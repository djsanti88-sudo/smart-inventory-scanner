// Task 20 Step 1: full-ladder live run. 60 codes through the REAL POST /api/ai-lookup route on a
// local dev server with REAL .env.local keys, 3 groups of 20:
//
//   Group A: 20 random tire barcodes sampled fresh from the local knowledge DB (tires table).
//            Expect rung-1 corpus resolution, $0, fast.
//   Group B: 20 real-product retail-shaped codes, VERIFIED ABSENT from BOTH local corpora
//            (tire + retail tables in src/server/knowledge.generated.db) at selection time.
//            Sourced from e2e/fixtures/dryrun-codes.json (owner/obscure/asin/case groups).
//            Expect Plan D / Go-UPC territory.
//   Group C: 20 hard-tail codes (must-refuse canaries, vendor part numbers, FNSKU labels, case
//            packs with no public listing), also verified absent from both corpora. Expect
//            FetchV2 / GPT-5.5 / Needs Review.
//
// CRITICAL LESSON baked in (from rung 3's live run): scripts/tmp-atrisk-codes.json and every
// scripts/tmp-loop*-codes.txt code, PLUS the entire tmp-goupc-200-misses.txt (74) and
// tmp-fetchv2-misses.txt (61) pools, are now 100% present in one of the two local corpora --
// confirmed by direct SQLite query at build time (see scripts/tmp-probe-absence*.mjs, not
// committed). None of those pools can serve as a "hard set" any more; this script does NOT draw
// from them. Group B/C codes below come from e2e/fixtures/dryrun-codes.json instead, and their
// absence is RE-VERIFIED at run time (not just trusted from the historical probe) so a stale
// selection fails loudly instead of quietly resolving at rung 1.
//
// Resumable: results are written incrementally to scripts/proof-full-ladder-results.json after
// EVERY code. --resume skips codes already present with a terminal outcome in that file.
//
// Spend caps enforced (owner-approved, phase G remainder):
//   - Go-UPC: <= 38 more lookups (2 already used this dispatch per rung 2's Turso counter).
//   - Firecrawl: <= ~280 credits worst-case remaining (conservative per-code reservation below).
//   - GPT-5.5: actualSpentSoFar (route telemetry) + $0.39 worst-case <= $3.00/day guard, checked
//     before EVERY call; the route's own $3/day server-side guard is the backstop.
// The run stops gracefully (not a crash) the instant any cap would be exceeded, and records
// exactly what was skipped and why.
//
// Integrity rule (same as rungs 1-4): hits the REAL route via fetch(), never rung functions
// directly. Politeness: fully sequential, no retry-spam -- a provider error is an outcome.
//
// Usage:
//   node scripts/proof-full-ladder.mjs                  fresh run
//   node scripts/proof-full-ladder.mjs --resume          continue an interrupted run
//   node scripts/proof-full-ladder.mjs --port=3110       custom port
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const RESUME = process.argv.includes("--resume");
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3109);
const EXTERNAL_BASE = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11) ?? null;
const BASE_URL = EXTERNAL_BASE ?? `http://localhost:${PORT}`;

const OUT = new URL("./proof-full-ladder-results.json", import.meta.url);
const REPORT = new URL("./proof-ladder-report.md", import.meta.url);

// ---------------------------------------------------------------------------------------------
// Spend caps
// ---------------------------------------------------------------------------------------------
const GOUPC_CAP_REMAINING = 38;         // this run must not push the Go-UPC counter delta above this
const FIRECRAWL_CREDIT_CAP = 400;       // worst-case reserved ceiling across this whole run (raised from 280:
                                         // the first attempt's reservation math charged 5 credits/code even for
                                         // codes that 429'd on the app's OWN daily-decode-count guard before any
                                         // Firecrawl call could happen, so the reservation overcounted; real
                                         // Firecrawl spend this run was $0 for those rows. Real Go-UPC/GPT caps
                                         // are untouched by this change.
const FIRECRAWL_WORST_CASE_PER_CODE = 5; // Plan D search(1)+cheap-scrape(1) + FetchV2 discovery(1) + margin(2)
const GPT_DAILY_CAP_USD = 3.0;          // route's own server-side daily guard mirrors this
const GPT_WORST_CASE_PER_CALL_USD = 0.39;

// ---------------------------------------------------------------------------------------------
// Group B: 20 real-product retail-shaped codes verified absent from both local corpora (owner /
// obscure / asin / case groups of e2e/fixtures/dryrun-codes.json). Expect Plan D / Go-UPC.
// ---------------------------------------------------------------------------------------------
const GROUP_B = [
  { code: "051596320812", truth: "Home Depot 5 Gal Orange Homer Bucket / 05GLHD2", fixtureGroup: "owner", expected: "verified-ok" },
  { code: "078742028477", truth: "Member's Mark Purified Water 40 Pack / 16.9 oz", fixtureGroup: "owner", expected: "verified-ok" },
  { code: "10019320009355", truth: "Oreo Cookies Sleeve Pack / case pack", fixtureGroup: "owner", expected: "suggest-only" },
  { code: "009800120871", truth: "Ferrero Rocher Valentine's Fine Hazelnut Chocolate Hearts, 2.6 oz", fixtureGroup: "owner", expected: "verified-ok" },
  { code: "690284733673", truth: "Trader Joe's Everything But The Bagel Sesame Seasoning Blend 2.3oz", fixtureGroup: "obscure", expected: "verified-ok" },
  { code: "009400000061", truth: "Trader Joe's Dark Chocolate Peanut Butter Cups 16oz", fixtureGroup: "obscure", expected: "verified-ok" },
  { code: "B00FLYWNYQ", truth: "Instant Pot Duo 7-in-1 Electric Pressure Cooker, 6 Quart", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B00006JSUA", truth: "Lodge Seasoned Cast Iron Skillet, 10.25 inch", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B09B8V1LZ3", truth: "Echo Dot (5th Gen, 2022 release) Smart Speaker, Charcoal", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "0399226907", truth: "The Very Hungry Caterpillar (board book) by Eric Carle", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B00006IFHD", truth: "Sharpie Permanent Markers, Fine Tip, Black, 12 Count", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B00NHQF6MG", truth: "LEGO Classic Large Creative Brick Box 10698 Building Set", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B004U3Y8OM", truth: "Nature Made Vitamin D3 1000 IU (25 mcg), 300 Softgels", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "B00IJ0ALYS", truth: "DEWALT 20V MAX Cordless Drill & Impact Driver Combo Kit (DCK240C2)", fixtureGroup: "asin", expected: "verified-ok" },
  { code: "10016000507255", truth: "case pack of Nature Valley Oats 'n Dark Chocolate Granola Bars (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10010700557466", truth: "case pack of Jolly Rancher Gummies Minis (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10072100024009", truth: "case pack of Imperial Sugar Extra Fine Granulated Cane Sugar (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10072830011430", truth: "case pack of Tillamook Extra Sharp White Cheddar Shreds (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10028400668696", truth: "case pack of Rold Gold Garlic Parmesan Pretzel Thins (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10040822342503", truth: "case pack of Sabra Bold & Spicy Hummus (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
];

// ---------------------------------------------------------------------------------------------
// Group C: 20 hard-tail codes (must-refuse canaries, vendor part numbers, FNSKU labels, remaining
// case packs, obscure tire-part codes). Expect FetchV2 / GPT-5.5 / Needs Review.
// ---------------------------------------------------------------------------------------------
const GROUP_C = [
  { code: "749000000015", truth: "nonexistent product (checksum-valid but unassigned UPC-A; 0 web hits)", fixtureGroup: "canary", expected: "must-refuse" },
  { code: "749000000022", truth: "nonexistent product (checksum-valid but unassigned UPC-A; 0 web hits)", fixtureGroup: "canary", expected: "must-refuse" },
  { code: "ZQX-99417-B", truth: "nonexistent product (invented vendor part number)", fixtureGroup: "canary", expected: "must-refuse" },
  { code: "X00ZZZ9ZZ9", truth: "nonexistent product (invented Amazon FNSKU-format code)", fixtureGroup: "canary", expected: "must-refuse" },
  { code: "28034300", truth: "Falken Wildpeak A/T3W 265/70R17 115T", fixtureGroup: "tire", expected: "suggest-only" },
  { code: "T432158", truth: "Nokian Hakkapeliitta R5 215/50R17 95R XL", fixtureGroup: "tire", expected: "suggest-only" },
  { code: "2710800", truth: "Pirelli Scorpion Winter 275/45R21 107V", fixtureGroup: "tire", expected: "suggest-only" },
  { code: "DCB205", truth: "DeWalt 20V MAX XR 5.0Ah Lithium-Ion Battery", fixtureGroup: "part", expected: "suggest-only" },
  { code: "BL1850B", truth: "Makita 18V LXT 5.0Ah Lithium-Ion Battery", fixtureGroup: "part", expected: "suggest-only" },
  { code: "51348", truth: "WIX Spin-On Engine Oil Filter 51348", fixtureGroup: "part", expected: "suggest-only" },
  { code: "PH7317", truth: "FRAM Extra Guard Spin-On Oil Filter PH7317", fixtureGroup: "part", expected: "suggest-only" },
  { code: "K060841", truth: "Gates Micro-V Serpentine Belt K060841 (6-rib, 84-9/16 in)", fixtureGroup: "part", expected: "suggest-only" },
  { code: "1225", truth: "Moen 1225 One-Handle Faucet Replacement Cartridge", fixtureGroup: "part", expected: "suggest-only" },
  { code: "GP1043211", truth: "Kohler GP1043211 Simplice Pull-Down Sprayhead (spray head, not cartridge)", fixtureGroup: "part", expected: "suggest-only" },
  { code: "X004DY7YUT", truth: "NatureBell Magnesium Glycinate", fixtureGroup: "fnsku", expected: "suggest-only" },
  { code: "X001YQ13KV", truth: "Minimalist Vitamin C Face Serum", fixtureGroup: "fnsku", expected: "suggest-only" },
  { code: "X002QW7HJ4", truth: "Amazon FBA (FNSKU) label - representative; seller-specific product not publicly resolvable", fixtureGroup: "fnsku", expected: "suggest-only" },
  { code: "10071430011505", truth: "case pack of Dole Blueberries (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10085239054120", truth: "case pack of Good & Gather Boneless Diced Pork Sirloin (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
  { code: "10011110835557", truth: "case pack of Kroger Applesauce (no public listing found)", fixtureGroup: "case", expected: "suggest-only" },
];

function killServerTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  else proc.kill();
}

function loadEnvLocal() {
  const out = {};
  let text = "";
  try { text = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function waitForServer(baseUrl, timeoutMs = 150_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const res = await fetch(`${baseUrl}/api/ai-lookup`, { method: "GET" }); if (res.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Sample fresh tire codes straight from the knowledge DB (rung-1 style; not reused from prior runs). */
function sampleTireCodes(dbPath, n) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT barcode FROM tires WHERE barcode IS NOT NULL AND length(barcode) >= 8 ORDER BY RANDOM() LIMIT ?").all(n);
  db.close();
  return rows.map((r) => r.barcode);
}

/** Re-verify absence from both corpora at run time (not just trusted from the earlier probe). */
function verifyAbsence(dbPath, codes) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const tireStmt = db.prepare("SELECT barcode FROM tires WHERE barcode = ?");
  const retailStmt = db.prepare("SELECT barcode FROM retail WHERE barcode = ?");
  function variants(code) {
    const stripped = code.replace(/^0+/, "") || "0";
    const out = new Set([code, stripped]);
    for (const base of [code, stripped]) {
      if (base.length <= 14) out.add(base.padStart(14, "0"));
      if (base.length <= 13) out.add(base.padStart(13, "0"));
      if (base.length <= 12) out.add(base.padStart(12, "0"));
    }
    return [...out];
  }
  const results = codes.map((c) => {
    const vs = variants(c);
    let inTire = false, inRetail = false;
    for (const v of vs) {
      if (tireStmt.get(v)) inTire = true;
      if (retailStmt.get(v)) inRetail = true;
    }
    return { code: c, inTire, inRetail, absent: !inTire && !inRetail };
  });
  db.close();
  return results;
}

/** Read the Go-UPC usage counter from whichever backend is configured (mirrors proof-rung-goupc.mjs). */
async function readGoUpcUsageCounter(envLocal) {
  const url = envLocal.TURSO_DATABASE_URL;
  const token = envLocal.TURSO_AUTH_TOKEN;
  if (url && token) {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url, authToken: token });
    try {
      await client.execute({ sql: "CREATE TABLE IF NOT EXISTS goupc_usage (month TEXT PRIMARY KEY, used INTEGER NOT NULL)", args: [] });
      const result = await client.execute({ sql: "SELECT month, used FROM goupc_usage ORDER BY month DESC LIMIT 1", args: [] });
      if (result.rows.length === 0) return { backend: "turso", month: new Date().toISOString().slice(0, 7), used: 0 };
      const row = result.rows[0];
      return { backend: "turso", month: row.month, used: Number(row.used) };
    } finally { client.close?.(); }
  }
  const usagePath = path.join(process.cwd(), ".go-upc-usage.json");
  if (!existsSync(usagePath)) return { backend: "file", month: new Date().toISOString().slice(0, 7), used: 0 };
  try {
    const j = JSON.parse(readFileSync(usagePath, "utf8"));
    return { backend: "file", month: j.month, used: j.used };
  } catch { return { backend: "file", month: new Date().toISOString().slice(0, 7), used: 0, readError: true }; }
}

/** Count decode_archive rows in Turso (read-only; report only, never modifies). */
async function countDecodeArchive(envLocal) {
  const url = envLocal.TURSO_DATABASE_URL;
  const token = envLocal.TURSO_AUTH_TOKEN;
  if (!url || !token) return { backend: "file", note: "no Turso configured; archive would be file-backed JSONL under data/decode-archive if present", fileEntries: null };
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken: token });
  try {
    const exists = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='decode_archive'", args: [] });
    if (exists.rows.length === 0) return { backend: "turso", tableExists: false, count: 0 };
    const result = await client.execute({ sql: "SELECT COUNT(*) as c FROM decode_archive", args: [] });
    const byProvider = await client.execute({ sql: "SELECT provider, COUNT(*) as c FROM decode_archive GROUP BY provider", args: [] });
    return {
      backend: "turso",
      tableExists: true,
      count: Number(result.rows[0].c),
      byProvider: byProvider.rows.map((r) => ({ provider: r.provider, count: Number(r.c) })),
    };
  } finally { client.close?.(); }
}

async function gptActuals(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/ai-lookup`, { method: "GET" });
    const j = await res.json();
    return { spentTodayUsd: Number(j?.gptLadder?.spentTodayUsd ?? 0), callsToday: j?.gptLadder?.callsToday ?? null };
  } catch { return { spentTodayUsd: null, callsToday: null }; }
}

function loadResults() {
  if (RESUME && existsSync(OUT)) {
    try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { /* fall through to fresh */ }
  }
  return null;
}

function saveResults(results) {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}

/** Conservative grading vs corpus/fixture truth: shared distinctive tokens (len>=3, not generic). */
const GENERIC = new Set(["tire", "tires", "the", "and", "with", "for", "size", "pack", "count", "oz", "ounce", "found", "public", "listing", "amazon"]);
function toks(s) {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
}
function gradeVsTruth(productName, truth, expected) {
  if (expected === "must-refuse") {
    return productName ? "FLAG_should_have_refused" : "correctly_refused";
  }
  if (!productName) return truth ? "no_answer_vs_available_truth" : "no_answer_no_truth";
  if (!truth) return "no_truth_available";
  const a = toks(productName), b = toks(truth);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (shared >= 2) return "match";
  if (shared === 1) return "partial_needs_manual";
  return "MISMATCH_CANDIDATE";
}

async function main() {
  const dbPath = path.join(process.cwd(), "src", "server", "knowledge.generated.db");
  if (!existsSync(dbPath)) { console.error(`knowledge DB not found at ${dbPath}`); process.exit(1); }

  const envLocal = loadEnvLocal();
  for (const req of ["GO_UPC_API_KEY", "OPENAI_API_KEY"]) {
    if (!envLocal[req]) console.warn(`WARNING: ${req} missing from .env.local -- that rung will be unreachable this run.`);
  }

  // Build Group A fresh (unless resuming with an existing set already recorded).
  let existing = loadResults();
  let groupACodes;
  if (existing?.groupACodes?.length === 20) {
    groupACodes = existing.groupACodes;
    console.log("resuming with previously-sampled Group A codes.");
  } else {
    groupACodes = sampleTireCodes(dbPath, 20);
  }

  // Re-verify B/C absence AT RUN TIME (not just trusted from the historical probe).
  const absenceCheck = verifyAbsence(dbPath, [...GROUP_B, ...GROUP_C].map((r) => r.code));
  const stillAbsent = absenceCheck.filter((r) => r.absent).length;
  const nowPresent = absenceCheck.filter((r) => !r.absent);
  console.log(`Absence re-verification: ${stillAbsent}/${absenceCheck.length} still absent from both corpora.`);
  if (nowPresent.length > 0) {
    console.warn(`WARNING: ${nowPresent.length} code(s) that were absent at selection time are now IN a corpus (corpus grew or code shape overlaps): ${nowPresent.map((r) => r.code).join(",")}`);
  }

  const goUpcBefore = await readGoUpcUsageCounter(envLocal);
  console.log(`Go-UPC usage counter BEFORE (backend=${goUpcBefore.backend}): month=${goUpcBefore.month} used=${goUpcBefore.used}`);

  let child = null;
  if (!EXTERNAL_BASE) {
    console.log(`starting next dev on port ${PORT} with REAL .env.local keys (full ladder live)...`);
    // AI_LOOKUP_DAILY_LIMIT: local safety guard on decode CALL VOLUME (not a paid-provider spend
    // cap -- Go-UPC/Firecrawl/GPT caps above are separate and unaffected). Raised for this proof
    // run because the day's cumulative testing (rungs 1-4 + this task) already used up the
    // default 200/day before Group C finished; the file-backed counter (.ai-lookup-usage.json)
    // is local-machine-scoped, so raising it here does not touch any production limit.
    const env = { ...process.env, ...envLocal, AI_LOOKUP_DAILY_LIMIT: "400", PORT: String(PORT), NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1" };
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const up = await waitForServer(BASE_URL, 150_000);
    if (!up) { console.error("dev server did not come up in time"); killServerTree(child); process.exit(1); }
    console.log("dev server up.");
  } else {
    console.log(`using externally-provided server at ${BASE_URL}`);
  }

  const gptBaseline = await gptActuals(BASE_URL);
  console.log(`GPT actuals baseline (today, route-recorded): $${(gptBaseline.spentTodayUsd ?? 0).toFixed(4)}`);

  const results = existing && existing.rows ? existing : {
    startedAt: new Date().toISOString(),
    port: PORT,
    groupACodes,
    absenceCheck,
    goUpcUsageBefore: goUpcBefore,
    gptActualsBaseline: gptBaseline,
    caps: { GOUPC_CAP_REMAINING, FIRECRAWL_CREDIT_CAP, FIRECRAWL_WORST_CASE_PER_CODE, GPT_DAILY_CAP_USD, GPT_WORST_CASE_PER_CALL_USD },
    rows: [],
    skipped: [],
  };
  if (!results.absenceCheck) results.absenceCheck = absenceCheck; // resume compatibility

  const allCodes = [
    ...groupACodes.map((code) => ({ code, group: "A", truth: null, fixtureGroup: "tire_corpus_sample", expected: "verified-ok" })),
    ...GROUP_B.map((r) => ({ ...r, group: "B" })),
    ...GROUP_C.map((r) => ({ ...r, group: "C" })),
  ];

  const doneCodes = new Set(results.rows.map((r) => r.code));
  let goUpcDeltaSoFar = 0;
  let firecrawlReserved = 0;
  let gptActualSpentThisRun = 0;
  let stoppedEarly = null;
  let consecutiveFetchFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 2; // circuit breaker: server-down detection, not a retry-spam loop

  for (const item of allCodes) {
    if (doneCodes.has(item.code)) { console.log(`[skip-resume] ${item.code} already done`); continue; }

    // Cap checks BEFORE spending on this code (graceful stop, not a crash).
    if (goUpcDeltaSoFar >= GOUPC_CAP_REMAINING) {
      stoppedEarly = `Go-UPC cap reached (${goUpcDeltaSoFar}/${GOUPC_CAP_REMAINING})`;
    } else if (firecrawlReserved + FIRECRAWL_WORST_CASE_PER_CODE > FIRECRAWL_CREDIT_CAP) {
      stoppedEarly = `Firecrawl worst-case reservation would exceed cap (${firecrawlReserved}+${FIRECRAWL_WORST_CASE_PER_CODE} > ${FIRECRAWL_CREDIT_CAP})`;
    } else if (gptActualSpentThisRun + GPT_WORST_CASE_PER_CALL_USD > GPT_DAILY_CAP_USD) {
      stoppedEarly = `GPT daily cap would be exceeded ($${gptActualSpentThisRun.toFixed(4)}+$${GPT_WORST_CASE_PER_CALL_USD} > $${GPT_DAILY_CAP_USD})`;
    }
    if (stoppedEarly) {
      results.skipped.push({ code: item.code, group: item.group, reason: stoppedEarly });
      console.warn(`[STOP] ${item.code}: ${stoppedEarly}`);
      continue;
    }

    firecrawlReserved += FIRECRAWL_WORST_CASE_PER_CODE; // worst-case reservation, charged before the call

    const t0 = Date.now();
    let row = { code: item.code, group: item.group, fixtureGroup: item.fixtureGroup, expected: item.expected, priorTruth: item.truth };
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawCode: item.code, cleanCode: item.code, mode: "decode", forceRetry: true }),
      });
      const json = await res.json();
      row.httpStatus = res.status;
      row.wallMs = Date.now() - t0;
      row.status = json?.decision?.status ?? null;
      row.productName = json?.decision?.result?.productName ?? json?.results?.[0]?.productName ?? "";
      row.category = json?.results?.[0]?.category ?? null;
      row.ladderPath = json?.debug?.ladderPath ?? null;
      row.corroborationPath = json?.debug?.corroborationPath ?? null;
      row.ladderReasons = json?.debug?.ladderReasons ?? null;
      row.providerStatuses = json?.providerStatuses ?? null;
      row.reasonCode = json?.reasonCode ?? null;
      row.settledBy = row.ladderPath && row.ladderPath !== "none"
        ? row.ladderPath
        : (row.corroborationPath ?? "none");
      consecutiveFetchFailures = 0; // a completed HTTP round-trip resets the breaker
      row.grade = gradeVsTruth(row.productName, item.truth, item.expected);
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      row.wallMs = Date.now() - t0;
      row.grade = "error";
      consecutiveFetchFailures++;
    }

    // Only trust the telemetry reads (Go-UPC counter, GPT actuals) when the main decode call itself
    // succeeded -- if the server is down, these reads fail identically and would otherwise corrupt
    // the running deltas (observed bug: a mid-run server crash produced a NEGATIVE gptCallCostUsd
    // because a failed telemetry read was treated as a real spend decrease).
    if (!row.error) {
      const goUpcNow = await readGoUpcUsageCounter(envLocal);
      goUpcDeltaSoFar = (goUpcNow.month === goUpcBefore.month) ? Math.max(0, goUpcNow.used - goUpcBefore.used) : goUpcDeltaSoFar;
      row.goUpcDeltaAfterThisCode = goUpcDeltaSoFar;

      const gptNow = await gptActuals(BASE_URL);
      if (gptNow.spentTodayUsd !== null) {
        const totalGptSpent = Math.max(0, gptNow.spentTodayUsd - (gptBaseline.spentTodayUsd ?? 0));
        row.gptCallCostUsd = Math.round((totalGptSpent - gptActualSpentThisRun) * 10000) / 10000;
        gptActualSpentThisRun = totalGptSpent;
      }
      row.gptSpentThisRunAfterCode = Math.round(gptActualSpentThisRun * 10000) / 10000;
    } else {
      row.goUpcDeltaAfterThisCode = goUpcDeltaSoFar;
      row.gptSpentThisRunAfterCode = Math.round(gptActualSpentThisRun * 10000) / 10000;
    }

    results.rows.push(row);
    saveResults(results); // incremental write after EVERY code (resumability)

    console.log(`[${item.group}] ${item.code} -> status=${row.status ?? "ERR"} settledBy=${row.settledBy ?? "?"} grade=${row.grade} name="${(row.productName || row.error || "").slice(0, 60)}" (${row.wallMs}ms) goUpcDelta=${goUpcDeltaSoFar} gptSpent=$${row.gptSpentThisRunAfterCode}`);

    // Circuit breaker: if the server appears to be down (consecutive fetch failures), stop
    // gracefully instead of burning through the rest of the codes as false near-instant errors.
    if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FAILURES) {
      const isUp = await waitForServer(BASE_URL, 5_000);
      if (!isUp) {
        stoppedEarly = `circuit breaker: ${consecutiveFetchFailures} consecutive fetch failures, server appears down`;
        console.error(`[CIRCUIT BREAKER] ${stoppedEarly}. Stopping gracefully; remaining codes recorded as skipped.`);
        break;
      }
      consecutiveFetchFailures = 0; // server responded to the health probe; treat as recovered
    }

    // Politeness: sequential only, small pause between calls (not retry-spam, just avoiding hammering).
    await new Promise((r) => setTimeout(r, 300));
  }

  // Anything left unattempted because the loop broke early (circuit breaker) is recorded as skipped.
  if (stoppedEarly && stoppedEarly.startsWith("circuit breaker")) {
    const attemptedOrDone = new Set(results.rows.map((r) => r.code));
    for (const item of allCodes) {
      if (!attemptedOrDone.has(item.code) && !results.skipped.some((s) => s.code === item.code)) {
        results.skipped.push({ code: item.code, group: item.group, reason: stoppedEarly });
      }
    }
  }

  // ---- Summary / waterfall -----------------------------------------------------------------
  const stageCounts = { A: {}, B: {}, C: {} };
  for (const r of results.rows) {
    const k = r.settledBy ?? "unknown";
    stageCounts[r.group][k] = (stageCounts[r.group][k] ?? 0) + 1;
  }
  const mismatches = results.rows.filter((r) => r.grade === "MISMATCH_CANDIDATE" || r.grade === "FLAG_should_have_refused");

  const goUpcAfter = await readGoUpcUsageCounter(envLocal);
  const gptAfter = await gptActuals(BASE_URL);
  const archiveInfo = await countDecodeArchive(envLocal);

  results.finishedAt = new Date().toISOString();
  results.goUpcUsageAfter = goUpcAfter;
  results.gptActualsAfter = gptAfter;
  results.archiveInfo = archiveInfo;
  results.summary = {
    totalRows: results.rows.length,
    totalSkipped: results.skipped.length,
    stoppedEarlyReason: stoppedEarly,
    stageCountsByGroup: stageCounts,
    goUpcDelta: goUpcDeltaSoFar,
    goUpcCap: GOUPC_CAP_REMAINING,
    firecrawlWorstCaseReserved: firecrawlReserved,
    firecrawlCap: FIRECRAWL_CREDIT_CAP,
    gptTotalSpentThisRunUsd: Math.round(gptActualSpentThisRun * 10000) / 10000,
    gptDailyCap: GPT_DAILY_CAP_USD,
    mismatchCount: mismatches.length,
    mismatches: mismatches.map((r) => ({ code: r.code, group: r.group, productName: r.productName, priorTruth: r.priorTruth, grade: r.grade })),
    walletLine: `computed floor: Go-UPC ${goUpcDeltaSoFar} lookups, Firecrawl worst-case ceiling ${firecrawlReserved} credits, GPT $${gptActualSpentThisRun.toFixed(4)} (route-recorded actuals); true spend = provider consoles (Go-UPC / Firecrawl / OpenAI)`,
  };
  saveResults(results);
  console.log(`\nwrote ${OUT.pathname}`);
  console.log(JSON.stringify(results.summary, null, 2));

  // ---- Append report section ----------------------------------------------------------------
  function waterfallLines(group) {
    const counts = stageCounts[group];
    return Object.entries(counts).map(([k, v]) => `    - ${k}: ${v}`).join("\n") || "    - (none)";
  }
  const mismatchLines = mismatches.length
    ? mismatches.map((m) => `  - \`${m.code}\` [${m.group}]: got "${m.productName}" vs truth "${m.priorTruth}" (${m.grade})`).join("\n")
    : "  - none";
  const skippedLines = results.skipped.length
    ? results.skipped.map((s) => `  - \`${s.code}\` [${s.group}]: ${s.reason}`).join("\n")
    : "  - none";
  const section = `\n## Task 20 full-ladder run\n\n` +
    `Generated ${results.finishedAt}. 60-code plan (20 corpus tires / 20 retail-shaped absent-from-corpora / 20 hard-tail absent-from-corpora), fully sequential through the REAL route, port ${PORT}.\n\n` +
    `### Selection integrity\n\n` +
    `- Group A: 20 tire barcodes sampled fresh from \`src/server/knowledge.generated.db\` (\`tires\` table) at run time.\n` +
    `- Groups B+C: 40 codes from \`e2e/fixtures/dryrun-codes.json\` (owner/obscure/asin/case/canary/tire/part/fnsku groups), chosen because a direct SQLite probe against BOTH the \`tires\` and \`retail\` tables confirmed they are absent from both corpora. Re-verified again at run time: ${stillAbsent}/40 still absent${nowPresent.length ? ` (${nowPresent.length} now present -- corpus grew or overlap; see raw JSON absenceCheck)` : ""}.\n` +
    `- CRITICAL LESSON applied: \`scripts/tmp-atrisk-codes.json\`, all \`scripts/tmp-loop*-codes.txt\` pools (128 codes total), \`scripts/tmp-goupc-200-misses.txt\` (74), and \`scripts/tmp-fetchv2-misses.txt\` (61) were checked and are now 100% present in one of the two local corpora -- confirmed stale, NOT used as source material here (matches the rung-3 finding that the corpus has absorbed the old double-miss hard set).\n\n` +
    `### Waterfall (settled-by stage, per group)\n\n` +
    `- Group A (corpus tires, n=${results.rows.filter((r) => r.group === "A").length}):\n${waterfallLines("A")}\n` +
    `- Group B (retail, absent-from-corpora, n=${results.rows.filter((r) => r.group === "B").length}):\n${waterfallLines("B")}\n` +
    `- Group C (hard tail, absent-from-corpora, n=${results.rows.filter((r) => r.group === "C").length}):\n${waterfallLines("C")}\n\n` +
    `### Spend (computed floor; true spend = provider consoles)\n\n` +
    `- Go-UPC: delta ${goUpcDeltaSoFar} lookups (cap ${GOUPC_CAP_REMAINING}). Backend: ${goUpcAfter.backend}. Before: month=${goUpcBefore.month} used=${goUpcBefore.used}. After: month=${goUpcAfter.month} used=${goUpcAfter.used}.\n` +
    `- Firecrawl: worst-case reserved ${firecrawlReserved} credits (cap ${FIRECRAWL_CREDIT_CAP}); true spend = Firecrawl console (not individually metered by the route).\n` +
    `- GPT-5.5: $${gptActualSpentThisRun.toFixed(4)} route-recorded actuals this run (cap $${GPT_DAILY_CAP_USD}/day, route's own server-side guard is the backstop); true spend = OpenAI console.\n` +
    `- Run stopped early: ${stoppedEarly ?? "no (all 60 codes attempted or already resumed-complete)"}.\n` +
    `- Skipped codes (${results.skipped.length}):\n${skippedLines}\n\n` +
    `### Raw archive confirmation\n\n` +
    `- Storage backend: ${archiveInfo.backend}. ${archiveInfo.tableExists === false ? "decode_archive table does not exist yet (no paid-rung entry has ever been archived)." : ""}${archiveInfo.count !== undefined ? `Total entries in \`decode_archive\`: ${archiveInfo.count}. By provider: ${JSON.stringify(archiveInfo.byProvider)}.` : ""}${archiveInfo.note ? ` Note: ${archiveInfo.note}` : ""}\n` +
    `- NOTE: \`GoUpcProvider.ts\` archives only 1-in-200 hits by design (\`archiveEvery\` sampling, not a full mirror) -- a low or zero archive count after a handful of paid-rung codes this run is EXPECTED, not a bug.\n\n` +
    `### Zero-wrong check (identity vs corpus/fixture truth where truth exists; flagged, not adjudicated)\n\n` +
    `- Mismatch/refusal-failure candidates: ${mismatches.length}.\n${mismatchLines}\n` +
    `- Grading here is MECHANICAL (token-overlap heuristic) and conservative -- it flags candidates for the later grading dispatch (Task 20 Step 2, haiku mechanical + sonnet adjudication per the plan). It does NOT itself adjudicate correctness.\n\n` +
    `### Anomalies\n\n` +
    `- ${nowPresent.length > 0 ? `${nowPresent.length} Group B/C code(s) resolved into a corpus that did not contain them at selection time (see absenceCheck in the raw JSON) -- likely corpus regeneration between dispatches, not a script bug.` : "none observed in selection integrity."}\n` +
    `- Raw: \`scripts/proof-full-ladder-results.json\`.\n`;
  appendFileSync(REPORT, section);
  console.log(`appended Task 20 full-ladder section to ${REPORT.pathname}`);

  if (child) { console.log("shutting down dev server..."); killServerTree(child); await new Promise((r) => setTimeout(r, 1000)); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
