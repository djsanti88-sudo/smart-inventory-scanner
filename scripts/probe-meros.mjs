#!/usr/bin/env node
// Meros reality probe (Task 11 / AM-8, 2026-07-15).
//
// Owner decision: keep the meros.io door in BARCODE_SOURCES, but measure it honestly first. Live
// spot-checks found meros.io/<7-digit-prefix> pages are bare sequential code enumerations (no
// product or company names) and per-code pages 404 for every code tried. This script re-measures
// that claim mechanically against the first 20 codes of the golden tire corpus and writes a report
// with the decision number: identity-yield % (how often the page shows a real product/company
// identity near the scanned code).
//
// $0 cost: public GET requests only, no API keys, no secrets sent. Throttled to 1 req/s to be a
// polite, read-only crawler. Pure Node (no deps) - uses global fetch (Node 18+).
//
// Usage: node scripts/probe-meros.mjs

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GOLDEN_PATH = path.join(ROOT, "benchmarks", "golden", "phase1-corpus-golden.json");
const REPORTS_DIR = path.join(ROOT, "reports");
const CODES_TO_PROBE = 20; // AM-8: first 20 codes, not the full 84 - 0/20 identity is conclusive.
const THROTTLE_MS = 1000; // 1 req/s
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 10_000;

// Same enumeration heuristic as the production junk-rule guard (junkRules.ts), reimplemented here
// as a standalone pure function so this script has zero dependency on the app's module graph
// (module resolution differs for a plain .mjs script vs the app's TS path aliases).
const ENUMERATION_MIN_RUNS = 50;
const ENUMERATION_MIN_DIGIT_RATIO = 0.5;
const ENUMERATION_MIN_SEQUENTIAL_RATIO = 0.3;
const ENUMERATION_SEQUENTIAL_DELTA = 20;

function sequentialRunRatio(runs) {
  if (runs.length < 2) return 0;
  const nums = runs.map((r) => Number(r)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length < 2) return 0;
  let sequential = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] - nums[i - 1] <= ENUMERATION_SEQUENTIAL_DELTA) sequential++;
  }
  return sequential / (nums.length - 1);
}

function isEnumerationPage(pageText) {
  const text = (pageText ?? "").trim();
  if (!text) return false;
  const digitRuns = text.match(/\d{8,14}/g) ?? [];
  if (digitRuns.length < ENUMERATION_MIN_RUNS) return false;
  const digitChars = digitRuns.join("").length;
  if (digitChars / text.length <= ENUMERATION_MIN_DIGIT_RATIO) return false;
  return sequentialRunRatio(digitRuns) >= ENUMERATION_MIN_SEQUENTIAL_RATIO;
}

// A 3+ word Title Case run within 200 chars of the scanned code = plausible product/company identity.
const TITLE_CASE_RUN_RE = /(?:[A-Z][a-zA-Z'&-]*\s+){2,}[A-Z][a-zA-Z'&-]*/;

function hasIdentityNearCode(text, code) {
  const idx = text.indexOf(code);
  if (idx === -1) return false;
  const start = Math.max(0, idx - 200);
  const end = Math.min(text.length, idx + code.length + 200);
  const window = text.slice(start, end);
  return TITLE_CASE_RUN_RE.test(window);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": CHROME_UA, Accept: "text/html,application/xhtml+xml" },
    });
    const text = await res.text();
    return { status: res.status, size: text.length, text };
  } catch (err) {
    return { status: 0, size: 0, text: "", error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function sevenDigitPrefix(code) {
  const digits = (code ?? "").replace(/\D/g, "");
  // GTIN-13-ish codes: first 7 digits of the canonical 13-digit form when possible, else first 7 raw.
  const padded = digits.length >= 12 && digits.length <= 13 ? digits.padStart(13, "0") : digits;
  return padded.slice(0, 7);
}

async function probeOne(code) {
  const perCodeUrl = `https://meros.io/${code}`;
  const prefixUrl = `https://meros.io/${sevenDigitPrefix(code)}`;

  const perCode = await fetchWithTimeout(perCodeUrl);
  await sleep(THROTTLE_MS);
  const prefix = await fetchWithTimeout(prefixUrl);
  await sleep(THROTTLE_MS);

  const perCodeIdentity = hasIdentityNearCode(perCode.text, code);
  const prefixIdentity = hasIdentityNearCode(prefix.text, code);
  const perCodeEnum = isEnumerationPage(perCode.text);
  const prefixEnum = isEnumerationPage(prefix.text);

  return {
    code,
    perCodeUrl,
    prefixUrl,
    perCode: { status: perCode.status, size: perCode.size, identity: perCodeIdentity, enumeration: perCodeEnum, error: perCode.error ?? null },
    prefix: { status: prefix.status, size: prefix.size, identity: prefixIdentity, enumeration: prefixEnum, error: prefix.error ?? null },
  };
}

async function main() {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const codes = golden.slice(0, CODES_TO_PROBE).map((entry) => entry.code);

  console.log(`Meros reality probe: ${codes.length} codes x 2 URLs (per-code + 7-digit prefix), throttled to 1 req/s.`);

  const results = [];
  for (const code of codes) {
    process.stdout.write(`  probing ${code} ... `);
    const r = await probeOne(code);
    results.push(r);
    console.log(
      `per-code ${r.perCode.status}/${r.perCode.size}b${r.perCode.identity ? " IDENTITY" : ""}${r.perCode.enumeration ? " ENUM" : ""} | ` +
        `prefix ${r.prefix.status}/${r.prefix.size}b${r.prefix.identity ? " IDENTITY" : ""}${r.prefix.enumeration ? " ENUM" : ""}`,
    );
  }

  const totalFetches = results.length * 2;
  const perCodeHits = results.filter((r) => r.perCode.status >= 200 && r.perCode.status < 400).length;
  const prefixHits = results.filter((r) => r.prefix.status >= 200 && r.prefix.status < 400).length;
  const totalHits = perCodeHits + prefixHits;
  const identityHits = results.filter((r) => r.perCode.identity || r.prefix.identity).length;
  const enumerationHits = results.filter((r) => r.perCode.enumeration || r.prefix.enumeration).length;

  const hitRatePct = ((totalHits / totalFetches) * 100).toFixed(1);
  const identityYieldPct = ((identityHits / results.length) * 100).toFixed(1);
  const enumerationPct = ((enumerationHits / results.length) * 100).toFixed(1);

  console.log("");
  console.log(`Summary: ${totalFetches} fetches, HTTP-hit rate ${hitRatePct}%, identity-yield ${identityYieldPct}% (${identityHits}/${results.length} codes), enumeration-page rate ${enumerationPct}%`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORTS_DIR, `meros-probe-${dateStr}.md`);

  const rows = results
    .map(
      (r) =>
        `| ${r.code} | ${r.perCode.status} | ${r.perCode.size} | ${r.perCode.identity ? "yes" : "no"} | ${r.perCode.enumeration ? "yes" : "no"} | ${r.prefix.status} | ${r.prefix.size} | ${r.prefix.identity ? "yes" : "no"} | ${r.prefix.enumeration ? "yes" : "no"} |`,
    )
    .join("\n");

  const report = `# Meros Reality Probe - ${dateStr}

Owner decision context: meros.io is kept as a door in \`BARCODE_SOURCES\` but must be measured
honestly. This probe fetches BOTH \`https://meros.io/<code>\` (per-code page) and
\`https://meros.io/<7-digit-prefix>\` (prefix listing page) for the first ${CODES_TO_PROBE} codes of
\`benchmarks/golden/phase1-corpus-golden.json\`, throttled to 1 request/second with a Chrome user
agent. It is read-only, sends no secrets, and costs $0 (no API keys involved).

Identity is decided by: a 3+ word Title Case run (regex \`${TITLE_CASE_RUN_RE.source}\`) within 200
characters of the scanned code in the page text - a plausible product or company name, not just a
bare number. Enumeration is decided by the SAME rule now shipped in
\`src/services/fetchV2/pageEvidence/junkRules.ts\` (\`isEnumerationPage\`): >= 50 digit runs (8-14
digits), digit-to-text ratio > 0.5, and >= 30% of the runs pairwise-sequential.

ToS note: this is a small, throttled, read-only, publicly-accessible-page probe for internal
engineering decision-making; it is not a scraping/redistribution service and stops after ${CODES_TO_PROBE}
codes. No content is redistributed by this script.

## Decision number

**Identity-yield: ${identityYieldPct}% (${identityHits} of ${results.length} codes showed a plausible product/company identity near the code, on either URL).**

## Summary

- Total fetches: ${totalFetches} (${results.length} codes x 2 URLs)
- HTTP-hit rate (2xx/3xx): ${hitRatePct}% (${totalHits}/${totalFetches})
- Per-code URL hits: ${perCodeHits}/${results.length}
- Prefix URL hits: ${prefixHits}/${results.length}
- Identity-yield: ${identityYieldPct}% (${identityHits}/${results.length})
- Enumeration-page rate: ${enumerationPct}% (${enumerationHits}/${results.length})

## Per-code table

| code | per-code status | per-code bytes | per-code identity | per-code enum | prefix status | prefix bytes | prefix identity | prefix enum |
|---|---|---|---|---|---|---|---|---|
${rows}

## Recommendation

${
  identityHits === 0
    ? "0% identity-yield confirms the prior live spot-check: meros.io pages never surface a usable product/company identity for this sample. Recommend removing the meros entry from BARCODE_SOURCES (owner decision, not applied by this script) since it only fetches 404s/enumeration pages and wastes a door slot."
    : `${identityHits}/${results.length} codes DID show identity signal - meros.io may have some value; do not remove without owner review of the specific hits above.`
}
`;

  writeFileSync(reportPath, report, "utf8");
  console.log(`Report written: ${reportPath}`);
  console.log("(reports/ is gitignored - this file is NOT committed.)");
}

main().catch((err) => {
  console.error("probe-meros failed:", err);
  process.exitCode = 1;
});
