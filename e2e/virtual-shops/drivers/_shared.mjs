// e2e/virtual-shops/drivers/_shared.mjs
//
// Common launch/mock/assert/report helpers shared by every virtual-shop
// driver (rincon-tire.mjs, quickfix-auto.mjs, and future wave-3 shops).
//
// Modeled directly on e2e/persona-drive.mjs and e2e/stress-drive.mjs:
//   - same NO_AI_STATUS mock-route stub (never a live AI provider)
//   - same localhost-only allowlist-guard pattern, pinned to the virtual
//     shops' own dedicated port (3500, per the retired design summarized in docs/HISTORY.md;
//     2026-07-29-virtual-shops-design.md)
//   - same "screenshot each flow step, collect JSON metrics" driver shape
//
// This file is mock-only and read/write-local only: it never calls a real
// AI provider, never touches a shared/already-running dev server, and never
// writes outside reports/virtual-shops/<shop>/ (gitignored, see .gitignore
// `/reports/`).

import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

export const VIRTUAL_SHOPS_PORT = "3500";
export const DEFAULT_TARGET = `http://localhost:${VIRTUAL_SHOPS_PORT}`;
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Same shape as e2e/persona-drive.mjs / e2e/stress-drive.mjs. AI lookup stays
// fully off for every virtual shop; decode is never exercised live.
export const NO_AI_STATUS = {
  liveEnabled: false,
  autoDecodeOnScan: false,
  openaiConfigured: false,
  mode: "off",
  dailyLimit: 200,
  missingKeys: ["OPENAI_API_KEY"],
  e2e: true,
};

/**
 * Hard-throws unless the target is localhost/127.0.0.1/::1 on port 3500.
 * Mirrors e2e/persona-drive.mjs's parseArgs port guard (there: 3400) and
 * e2e/stress-drive.mjs's validateTarget local-host check. Never allow a
 * cloud/preview/production target for virtual shops - they are mock-backend
 * only, always.
 */
export function validateLocalTarget(targetString) {
  if (!targetString) throw new Error("--target is required");
  const target = new URL(targetString);
  if (!LOCAL_HOSTS.has(target.hostname) || target.port !== VIRTUAL_SHOPS_PORT) {
    throw new Error(`Virtual shop drivers are restricted to localhost port ${VIRTUAL_SHOPS_PORT}`);
  }
  return target.href.replace(/\/$/, "");
}

export function artifactPath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Registers the same mock /api/ai-lookup route as e2e/persona-drive.mjs and
 * e2e/stress-drive.mjs: GET returns the always-off status, everything else
 * is refused with 503. No live provider is ever reachable through this
 * route while it is installed.
 */
export async function installMockAiRoute(context) {
  await context.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: NO_AI_STATUS });
    else await route.fulfill({ status: 503, json: { error: "Virtual shop keeps live product lookup off" } });
  });
}

/**
 * Types a raw code into the dedicated scanner input and submits it with
 * Enter, exactly like a keyboard-wedge scanner. Mirrors the `scan` helper in
 * e2e/persona-drive.mjs. `delayMs` lets error-injection scenarios (typos,
 * interrupted buffers) slow keystrokes down without changing call sites.
 */
export async function scanCode(page, code, { delayMs = 2 } = {}) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: delayMs });
  await input.press("Enter");
}

/**
 * Types a raw code WITHOUT pressing Enter, leaving it mid-buffer. Used by
 * QuickFix Auto's mid-scan focus-loss/interrupt injection to prove the
 * scanner buffer does not leak into the next session (AGENTS.md scanner
 * buffer rules: capture in a ref, never mid-typing AI/matching, refocus).
 */
export async function typePartialCode(page, partialCode, { delayMs = 2 } = {}) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(partialCode, { delay: delayMs });
}

/**
 * Logs in through the same mock login button flow as e2e/persona-drive.mjs
 * and lands on /scan with the AI lookup toggle forced off (belt-and-braces:
 * the mock route above already refuses live calls, this also keeps the UI
 * honest about what it claims to be doing).
 */
export async function loginAndReachScan(page, target) {
  await page.goto(`${target}/login`, { waitUntil: "domcontentloaded" });
  const loginButton = page.getByTestId("login-button");
  if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
  await page.waitForURL("**/scan", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__scanStore));
  await page.evaluate(() => {
    window.__scanStore.getState().updateSettings({ aiLookupEnabled: false, scanContext: "any" });
  });
  await page.getByTestId("scanner-input").waitFor({ timeout: 30_000 });
}

/**
 * Reads the live scan feed length and counted total straight out of the
 * exposed Zustand store, the same way stress-drive.mjs's readPersistedCount
 * does. This is the read side of the TOP-LEVEL LAW assertion below.
 */
export async function readScanState(page) {
  return page.evaluate(() => {
    const store = window.__scanStore?.getState?.();
    if (!store) return null;
    return {
      scans: store.scanFeed.length,
      counted: store.finalCounts.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      products: store.finalCounts.length,
    };
  });
}

/**
 * CLAUDE.md TOP-LEVEL LAW: "Every Scan Appears and Counts." Every physically
 * issued scan - known, unknown, typo'd, doubled, interrupted - must show up
 * in scanFeed AND be reflected in the counted total. This helper is the one
 * assertion every driver calls after every scan (or batch of scans) so a
 * regression here fails loudly instead of silently dropping a row.
 */
export function assertLawHolds(state, expectedScans, context) {
  if (!state) throw new Error(`${context}: could not read scan store state`);
  if (state.scans !== expectedScans) {
    throw new Error(`${context}: TOP-LEVEL LAW violated - expected ${expectedScans} feed rows, found ${state.scans}`);
  }
  if (state.counted !== expectedScans) {
    throw new Error(
      `${context}: TOP-LEVEL LAW violated - expected ${expectedScans} counted, found ${state.counted}`,
    );
  }
}

export async function takeScreenshot(page, dir, name) {
  const screenshotPath = resolve(dir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return artifactPath(screenshotPath);
}

/**
 * Loads a JSON fixture (shop inventory, error-injection table, ...). Wave-2
 * agent B2 owns the fixtures directory concurrently and its outputs are not
 * guaranteed to exist yet this round, so any read failure (missing file,
 * bad JSON) falls back to `fallback` instead of throwing - the driver stays
 * runnable standalone. The caller decides whether a fallback is friction.
 */
export async function loadFixtureWithFallback(fixturePath, fallback) {
  try {
    const raw = await readFile(fixturePath, "utf8");
    const parsed = JSON.parse(raw);
    return { data: parsed, source: "fixture", usedFallback: false };
  } catch (error) {
    return {
      data: fallback,
      source: "fallback",
      usedFallback: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Deterministic seeded PRNG (mulberry32) so error-injection sequences
 * (typos, double-scans, interrupts) are reproducible across runs from the
 * same seed, matching the design doc's "different error pattern seed"
 * per-day requirement without relying on Math.random().
 */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Swaps two adjacent characters in `code`, simulating a fat-finger typo. */
export function swapAdjacentChars(code, index) {
  if (code.length < 2) return code;
  const position = Math.min(Math.max(index, 0), code.length - 2);
  const chars = code.split("");
  [chars[position], chars[position + 1]] = [chars[position + 1], chars[position]];
  return chars.join("");
}

/**
 * Append-only friction log writer. One JSON line per event, matching the
 * schema defined by shops.config.mjs; retired design history is in docs/HISTORY.md
 * ("Common friction-log schema"): timestamp, shopKey, dayIndex, phase,
 * severity, description, screenshotPath.
 */
export class FrictionLogger {
  constructor(shopKey, runDir) {
    this.shopKey = shopKey;
    this.runDir = runDir;
    this.path = resolve(runDir, "friction.jsonl");
    this.events = [];
  }

  async log({ dayIndex, phase, severity, description, screenshotPath = null }) {
    if (!["minor", "moderate", "blocking"].includes(severity)) {
      throw new Error(`Invalid friction severity: ${severity}`);
    }
    const event = {
      timestamp: new Date().toISOString(),
      shopKey: this.shopKey,
      dayIndex,
      phase,
      severity,
      description,
      screenshotPath,
    };
    this.events.push(event);
    await ensureDir(dirname(this.path));
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  summary() {
    const bySeverity = { minor: 0, moderate: 0, blocking: 0 };
    for (const event of this.events) bySeverity[event.severity] += 1;
    return bySeverity;
  }
}

/**
 * Writes report.json (raw metrics) + report.md (human summary) into the
 * run directory, matching the design doc's per-run report contract: shop,
 * day index, scans attempted vs counted, metric pass/fail, friction list at
 * moderate/blocking severity.
 */
export async function writeShopReport(runDir, { shopKey, metrics, metricResults, friction }) {
  await ensureDir(runDir);
  const reportJsonPath = resolve(runDir, "report.json");
  const reportMdPath = resolve(runDir, "report.md");
  const payload = { shopKey, generatedAt: new Date().toISOString(), metrics, metricResults, friction: friction.events };
  await writeFile(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const frictionCounts = friction.summary();
  const notable = friction.events.filter((event) => event.severity !== "minor");
  const lines = [
    `# Virtual Shop Report: ${shopKey}`,
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Metrics",
    "",
    `- Scans attempted: ${metrics.scansAttempted}`,
    `- Scans counted: ${metrics.scansCounted}`,
    `- Days simulated: ${metrics.daysSimulated}`,
    "",
    "## Metric pass/fail",
    "",
    ...Object.entries(metricResults).map(([name, result]) => `- ${result.pass ? "PASS" : "FAIL"}: ${name} - ${result.detail}`),
    "",
    "## Friction",
    "",
    `- minor: ${frictionCounts.minor}, moderate: ${frictionCounts.moderate}, blocking: ${frictionCounts.blocking}`,
    ...(notable.length
      ? notable.map((event) => `- [${event.severity}] day ${event.dayIndex} (${event.phase}): ${event.description}`)
      : ["- none at moderate/blocking severity"]),
    "",
  ];
  await writeFile(reportMdPath, `${lines.join("\n")}\n`, "utf8");
  return { reportJsonPath: artifactPath(reportJsonPath), reportMdPath: artifactPath(reportMdPath) };
}

/** Sums the `quantity` column of an exported final-counts CSV (same header contract as stress-drive.mjs). */
export function sumCsvQuantities(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  if (!lines[0]?.startsWith("quantity,")) throw new Error("Final-count CSV has an unexpected header");
  return lines.slice(1).reduce((sum, line) => {
    const comma = line.indexOf(",");
    const quantity = Number(comma === -1 ? line : line.slice(0, comma));
    if (!Number.isFinite(quantity)) throw new Error(`Invalid quantity in exported CSV: ${line}`);
    return sum + quantity;
  }, 0);
}

export function delay(milliseconds) {
  return new Promise((complete) => setTimeout(complete, milliseconds));
}
