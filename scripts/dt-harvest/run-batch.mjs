#!/usr/bin/env node
// Discount Tire harvest: Task 5 Step 1 - resumable batch driver.
//
// Usage:
//   node scripts/dt-harvest/run-batch.mjs --limit=100
//   node scripts/dt-harvest/run-batch.mjs --limit=500 --shard=0/4 --state-suffix=w1
//
// Reads state/urls.json (shared, read-only) + state/done<suffix>.json (map url -> true).
// For each selected url: fetchProductPage -> parseTireFromHtml -> guardRow (using
// src/products/catalog/brandPrefixMap.json, read-only) -> append to
// state/harvested<suffix>.jsonl. Updates state/done<suffix>.json and
// state/telemetry<suffix>.json after EVERY page (crash-safe, atomic-ish write-then-rename).
//
// Politeness: 2000-4000ms randomized delay between pages, extra 15-30s backoff on
// "blocked". Hard stop (exit 0, stop-report) when BlockRateStop.shouldStop() fires, on
// SIGINT, or when --limit is reached. Host allowlist enforced per-url via hostAllowed();
// anything else is skipped and counted as "error" - this script only ever talks to
// discounttire.com / www.discounttire.com.
//
// Scraped HTML is untrusted data throughout: parseTireFromHtml only extracts/maps
// fields, it never executes or obeys page content (see AGENTS.md / CLAUDE.md).

import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectUrls, hostAllowed } from "./lib/batch.mjs";
import { fetchProductPage, BlockRateStop } from "./fetchPage.mjs";
import { parseTireFromHtml, parseTireFromProductByCode } from "./lib/parseProduct.mjs";
import { guardRow } from "./lib/merge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const URLS_FILE = path.join(STATE_DIR, "urls.json");
const PREFIX_MAP_FILE = path.join(__dirname, "..", "..", "src", "products", "catalog", "brandPrefixMap.json");

const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 4000;
const BLOCKED_BACKOFF_MIN_MS = 15000;
const BLOCKED_BACKOFF_MAX_MS = 30000;
const CHECKPOINT_EVERY = 25;

const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { limit: undefined, shard: undefined, stateSuffix: "" };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, "").split(/=(.*)/s);
    if (key === "limit") args.limit = Number(value);
    else if (key === "shard") {
      const m = String(value).match(/^(\d+)\/(\d+)$/);
      if (!m) throw new Error(`Invalid --shard value "${value}", expected K/N (e.g. 0/4)`);
      const k = Number(m[1]);
      const n = Number(m[2]);
      if (n <= 0 || k < 0 || k >= n) throw new Error(`Invalid --shard value "${value}": require 0 <= K < N`);
      args.shard = { k, n };
    } else if (key === "state-suffix") args.stateSuffix = String(value);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("Missing/invalid required --limit=N argument");
  }
  return args;
}

// Build the exact filenames: done.json / done-w1.json, harvested.jsonl / harvested-w1.jsonl,
// telemetry.json / telemetry-w1.json, stop-report.json / stop-report-w1.json.
function withSuffix(baseName, suffix) {
  if (!suffix) return path.join(STATE_DIR, baseName);
  const dot = baseName.lastIndexOf(".");
  const stem = baseName.slice(0, dot);
  const ext = baseName.slice(dot);
  return path.join(STATE_DIR, `${stem}-${suffix}${ext}`);
}

async function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically-ish: write to a temp file then rename over the target.
 * On Windows the rename intermittently throws EPERM/EBUSY when the destination is
 * momentarily locked by Defender/indexing (killed worker w2 at page 272 on
 * 2026-07-09) - retry with backoff, then fall back to a direct write rather than
 * crash the whole crawl over a telemetry file.
 */
async function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const json = JSON.stringify(data, null, 2);
  await writeFile(tmpPath, json);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (err) {
      if (err?.code !== "EPERM" && err?.code !== "EBUSY" && err?.code !== "EACCES") throw err;
      await sleep(100 * attempt);
    }
  }
  // Last resort: non-atomic direct write (a torn read on next resume is recoverable;
  // a dead worker is worse).
  await writeFile(filePath, json);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpPath);
  } catch {
    /* stray tmp file is harmless */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

function makeTelemetry() {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    ok: 0,
    blocked: 0,
    error: 0,
    parse_miss: 0,
    rows: 0,
    guardRejected: 0,
    blockRate: 0,
    pagesPerHour: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const doneFile = withSuffix("done.json", args.stateSuffix);
  const harvestedFile = withSuffix("harvested.jsonl", args.stateSuffix);
  const telemetryFile = withSuffix("telemetry.json", args.stateSuffix);
  const stopReportFile = withSuffix("stop-report.json", args.stateSuffix);

  const urlsState = await readJsonSafe(URLS_FILE, { urls: [] });
  const urls = Array.isArray(urlsState.urls) ? urlsState.urls : [];
  if (urls.length === 0) {
    console.error(`No urls found in ${URLS_FILE}. Run discover.mjs first.`);
    process.exitCode = 1;
    return;
  }

  const done = await readJsonSafe(doneFile, {});
  let telemetry = await readJsonSafe(telemetryFile, null) || makeTelemetry();

  const prefixMap = await readJsonSafe(PREFIX_MAP_FILE, {});

  const selected = selectUrls(urls, done, { limit: args.limit, shard: args.shard });
  console.log(
    `Selected ${selected.length} url(s) to process (limit=${args.limit}${args.shard ? `, shard=${args.shard.k}/${args.shard.n}` : ""}${
      args.stateSuffix ? `, state-suffix=${args.stateSuffix}` : ""
    }).`,
  );
  if (selected.length === 0) {
    console.log("Nothing to do (all urls in scope are already done, or urls.json is empty for this shard).");
    return;
  }

  const blockRateStop = new BlockRateStop();
  let stopRequested = false;
  const onSigint = () => {
    console.log("\nSIGINT received - will stop after the current page and flush state.");
    stopRequested = true;
  };
  process.on("SIGINT", onSigint);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: REALISTIC_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();

  let processedThisRun = 0;
  let stopReason = null;

  try {
    for (let i = 0; i < selected.length; i++) {
      if (stopRequested) {
        stopReason = "sigint";
        break;
      }

      const url = selected[i];

      if (!hostAllowed(url)) {
        telemetry.error += 1;
        done[url] = true;
        console.log(`[${i + 1}/${selected.length}] REFUSED (host not allowlisted): ${url}`);
        await writeJsonAtomic(doneFile, done);
        continue;
      }

      const result = await fetchProductPage(page, url);
      blockRateStop.record(result.status);
      done[url] = true;
      processedThisRun += 1;

      if (result.status === "ok") {
        telemetry.ok += 1;
        // Primary: the captured productByCode GraphQL node (carries gtin + full
        // specs); fall back to JSON-LD only if it was not captured.
        const row = result.productJson
          ? parseTireFromProductByCode(result.productJson, url)
          : parseTireFromHtml(result.html, url);
        if (!row || !row.gtin) {
          telemetry.parse_miss += 1;
          console.log(`[${i + 1}/${selected.length}] ok, parse_miss: ${url}`);
        } else {
          const guard = guardRow(row, prefixMap);
          if (guard.ok) {
            await appendFile(harvestedFile, `${JSON.stringify({ ...row, guard: "ok" })}\n`);
            telemetry.rows += 1;
            console.log(`[${i + 1}/${selected.length}] ok, gtin=${row.gtin}: ${url}`);
          } else {
            await appendFile(harvestedFile, `${JSON.stringify({ ...row, guard: guard.reason })}\n`);
            telemetry.guardRejected += 1;
            console.log(`[${i + 1}/${selected.length}] ok, guard rejected (${guard.reason}): ${url}`);
          }
        }
      } else if (result.status === "blocked") {
        telemetry.blocked += 1;
        console.log(`[${i + 1}/${selected.length}] BLOCKED: ${url}`);
      } else {
        telemetry.error += 1;
        console.log(`[${i + 1}/${selected.length}] error: ${url}`);
      }

      const elapsedHours = (Date.now() - new Date(telemetry.startedAt).getTime()) / 3_600_000;
      const totalProcessed = telemetry.ok + telemetry.blocked + telemetry.error;
      telemetry.blockRate = blockRateStop.window.length > 0
        ? blockRateStop.window.filter((s) => s === "blocked").length / blockRateStop.window.length
        : 0;
      telemetry.pagesPerHour = elapsedHours > 0 ? totalProcessed / elapsedHours : 0;
      telemetry.updatedAt = new Date().toISOString();

      await writeJsonAtomic(doneFile, done);
      await writeJsonAtomic(telemetryFile, telemetry);

      if ((i + 1) % CHECKPOINT_EVERY === 0) {
        console.log(
          `  --- checkpoint: ${i + 1}/${selected.length} processed | ok=${telemetry.ok} blocked=${telemetry.blocked} error=${telemetry.error} rows=${telemetry.rows} guardRejected=${telemetry.guardRejected} parse_miss=${telemetry.parse_miss} blockRate=${(telemetry.blockRate * 100).toFixed(1)}% pagesPerHour=${telemetry.pagesPerHour.toFixed(1)} ---`,
        );
      }

      if (blockRateStop.shouldStop()) {
        stopReason = "block_rate";
        break;
      }

      if (result.status === "blocked") {
        await sleep(randomDelay(BLOCKED_BACKOFF_MIN_MS, BLOCKED_BACKOFF_MAX_MS));
      } else if (i < selected.length - 1) {
        await sleep(randomDelay(MIN_DELAY_MS, MAX_DELAY_MS));
      }
    }
  } finally {
    await browser.close();
    process.removeListener("SIGINT", onSigint);
  }

  if (stopReason === "block_rate") {
    const counts = {
      ok: telemetry.ok,
      blocked: telemetry.blocked,
      error: telemetry.error,
      parse_miss: telemetry.parse_miss,
      rows: telemetry.rows,
      guardRejected: telemetry.guardRejected,
    };
    await writeJsonAtomic(stopReportFile, {
      stoppedAt: new Date().toISOString(),
      reason: "block_rate",
      counts,
    });
    console.log(`\nHARD STOP: block rate exceeded threshold. Wrote ${stopReportFile}.`);
  } else if (stopReason === "sigint") {
    console.log("\nStopped by SIGINT. State flushed, safe to resume.");
  } else {
    console.log(`\nReached --limit=${args.limit} (${processedThisRun} page(s) processed this run).`);
  }

  console.log("\nFinal telemetry summary:");
  console.log(JSON.stringify(telemetry, null, 2));
}

main().catch((err) => {
  console.error("run-batch.mjs failed:", err);
  process.exitCode = 1;
});
