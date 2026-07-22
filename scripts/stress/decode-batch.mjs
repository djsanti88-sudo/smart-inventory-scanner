#!/usr/bin/env node
// Decode-ladder stress harness. Batches codes from a bucketed codes.json through the REAL
// POST /api/ai-lookup route (mode "decode"), attributes each result to exactly one ladder rung,
// and renders THE SQUARE (rung x outcome table) per batch plus a running cumulative report.
//
// CONTRACT (read, do not guess):
//   - src/app/api/ai-lookup/route.ts: POST body { rawCode, cleanCode, mode: "decode", scanContext,
//     confidenceThreshold, ... }. GET returns { daily: {used,limit}, gptLadder: {spentTodayUsd,...} }.
//   - src/server/decode/pipeline.ts: the winning rung is reported via response.debug.ladderPath (one
//     of "upcitemdb" | "openfoodfacts" | "goupc" | "fetchv2" | "gpt" | "none"), OR, for a pre-ladder
//     free settle, response.debug.corroborationPath ("tire-corpus" exit sets providerNames
//     ["tire-corpus"]; retail-corpus/learned-products/cache set corroborationPath accordingly) and
//     response.providerNames[0] (e.g. "tire-corpus", "retail-corpus", "learned-products"). A cache
//     replay is marked by response.debug.cached === true / persistedCacheHit === true (kind "persisted")
//     — attributed to "l1_cache" (in-memory replay) or "l2_cache" (persisted/Turso replay) by
//     debug.persistedCacheHit. response.decision.status is "verified" | "suggested" | "needs_review".
//   - scripts/proof-full-ladder.mjs: the existing live-harness pattern this mirrors (fetch shape,
//     ladderPath/corroborationPath reads, sequential + incremental-write resumability).
//
// CLI:
//   node scripts/stress/decode-batch.mjs --base https://<preview-url> --codes .superpowers/stress/codes.json --batch <N> [--size 100] [--concurrency 3] [--dry] [--selftest]
//
// Money guard: reserves $0.39 worst-case per GPT-attributed call in .superpowers/stress/spend.json;
// STOPS the whole run at $10.00 reserved, marks remaining codes "skipped_budget", exit 2.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
const GPT_WORST_CASE_USD = 0.39;
const BUDGET_CAP_USD = 10.0;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 30_000;
const BUCKET_ORDER = ["corpus_known", "tire_noncorpus", "junk_vendor", "retail_free"];

// Ladder rows in owner-specified order (THE SQUARE). `key` maps 1:1 to an attribution bucket.
const RUNG_ROWS = [
  { key: "l1_cache", label: "1 L1 cache", paid: false },
  { key: "tire_corpus", label: "2 Tire corpus", paid: false },
  { key: "retail_corpus", label: "3 Retail corpus", paid: false },
  { key: "learned", label: "4 Learned", paid: false },
  { key: "l2_cache", label: "5 L2 Turso", paid: false },
  { key: "upcitemdb", label: "6 UPCitemdb", paid: false },
  { key: "openfoodfacts", label: "7 OpenFoodFacts", paid: false },
  { key: "goupc", label: "8 Go-UPC", paid: true },
  { key: "fetchv2", label: "9 FetchV2", paid: true },
  { key: "gpt", label: "10 GPT", paid: true },
  { key: "needs_review_bare", label: "11 Needs Review bare", paid: false },
];
const RUNG_KEYS = new Set(RUNG_ROWS.map((r) => r.key));

// ---------------------------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { size: DEFAULT_BATCH_SIZE, concurrency: DEFAULT_CONCURRENCY, dry: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--codes") out.codes = argv[++i];
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else if (a === "--size") out.size = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--dry") out.dry = true;
    else if (a === "--selftest") out.selftest = true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Batch planning: deterministic interleave of buckets so every batch has a representative mix.
// Resumable/reproducible: purely a function of (codes.json contents, size, batch index).
// ---------------------------------------------------------------------------------------------
function loadCodesFile(codesPath) {
  const abs = path.isAbsolute(codesPath) ? codesPath : path.join(REPO_ROOT, codesPath);
  const parsed = JSON.parse(readFileSync(abs, "utf8"));
  // codes.json nests bucket lists under a top-level "buckets" key; also accept a flat file.
  const raw = parsed.buckets && typeof parsed.buckets === "object" ? parsed.buckets : parsed;
  const buckets = {};
  for (const name of BUCKET_ORDER) buckets[name] = Array.isArray(raw[name]) ? raw[name] : [];
  // Any bucket present in the file but not in BUCKET_ORDER is still included (appended), so an
  // unexpected/custom bucket name never silently vanishes.
  for (const name of Object.keys(raw)) {
    if (!BUCKET_ORDER.includes(name) && Array.isArray(raw[name])) buckets[name] = raw[name];
  }
  return buckets;
}

/** Interleave every bucket round-robin into one flat ordered list, tagging each entry with its
 *  source bucket. Deterministic: same input always produces the same flat order. */
function interleaveBuckets(buckets) {
  const names = Object.keys(buckets);
  const cursors = Object.fromEntries(names.map((n) => [n, 0]));
  const flat = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const name of names) {
      const list = buckets[name];
      const i = cursors[name];
      if (i < list.length) {
        const entry = list[i];
        const code = typeof entry === "string" ? entry : entry.code;
        flat.push({ code, bucket: name, meta: typeof entry === "object" ? entry : {} });
        cursors[name] = i + 1;
        progressed = true;
      }
    }
  }
  return flat;
}

/** Slice the deterministic flat interleave into fixed-size batches; batch N (1-indexed) is always
 *  the same slice regardless of what has already run — reproducible and resumable by construction. */
function planBatch(buckets, batchNumber, size) {
  const flat = interleaveBuckets(buckets);
  const start = (batchNumber - 1) * size;
  const items = flat.slice(start, start + size);
  return { items, totalCodes: flat.length, totalBatches: Math.max(1, Math.ceil(flat.length / size)) };
}

// ---------------------------------------------------------------------------------------------
// Money guard (persisted across batches/runs)
// ---------------------------------------------------------------------------------------------
function spendFilePath() {
  return path.join(REPO_ROOT, ".superpowers", "stress", "spend.json");
}
function loadSpend() {
  const p = spendFilePath();
  if (!existsSync(p)) return { reservedUsd: 0, gptAttributedCalls: 0, history: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { reservedUsd: 0, gptAttributedCalls: 0, history: [] };
  }
}
function saveSpend(spend) {
  mkdirSync(path.dirname(spendFilePath()), { recursive: true });
  writeFileSync(spendFilePath(), JSON.stringify(spend, null, 2));
}
/** Reserve worst-case for one GPT-attributed call. Returns false (and does NOT reserve) if doing so
 *  would push the persisted total to/over BUDGET_CAP_USD — caller must stop immediately on false. */
function reserveGptCall(spend, code) {
  if (spend.reservedUsd + GPT_WORST_CASE_USD > BUDGET_CAP_USD) return false;
  spend.reservedUsd = Math.round((spend.reservedUsd + GPT_WORST_CASE_USD) * 10000) / 10000;
  spend.gptAttributedCalls += 1;
  spend.history.push({ code, reservedUsd: GPT_WORST_CASE_USD, at: new Date().toISOString() });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Rung attribution
// ---------------------------------------------------------------------------------------------
/** Maps a settled decode response into exactly one RUNG_ROWS key. See the CONTRACT header comment
 *  for the exact response fields this reads. */
function attributeRung(json) {
  const debug = json?.debug ?? {};
  const providerNames = Array.isArray(json?.providerNames) ? json.providerNames : [];
  const ladderPath = debug.ladderPath;
  const corroborationPath = debug.corroborationPath;

  // Cache replay (kind "persisted" in the pipeline, or an L1 in-memory replay echoed as debug.cached).
  if (debug.cached === true || debug.persistedCacheHit === true) {
    return debug.persistedCacheHit === true ? "l2_cache" : "l1_cache";
  }
  // Ladder rungs settle via debug.ladderPath (upcitemdb / openfoodfacts / goupc / fetchv2 / gpt).
  if (ladderPath && ladderPath !== "none" && RUNG_KEYS.has(ladderPath === "goupc" ? "goupc" : ladderPath)) {
    return ladderPath; // upcitemdb | openfoodfacts | goupc | fetchv2 | gpt — identical to RUNG_ROWS keys
  }
  // Pre-ladder free settles report via corroborationPath / providerNames[0].
  const provider0 = providerNames[0] ?? "";
  if (corroborationPath === "tire-corpus" || provider0 === "tire-corpus") return "tire_corpus";
  if (corroborationPath === "retail_corpus_exact_barcode" || provider0 === "retail-corpus") return "retail_corpus";
  if (corroborationPath === "learned_products" || provider0 === "learned-products") return "learned";

  // No identity settled anywhere in the ladder: bare needs_review.
  return "needs_review_bare";
}

/** Outcome bucket from the settled decision, independent of which rung produced it. */
function attributeOutcome(json) {
  const status = json?.decision?.status;
  const hasIdentity = !!(json?.results?.[0]?.productName || json?.results?.[0]?.brand);
  if (status === "verified") return "resolved_verified";
  if (status === "suggested" || hasIdentity) return "suggested";
  return "needs_review_bare";
}

// ---------------------------------------------------------------------------------------------
// HTTP call (with timeout + single retry on network error only, never on 4xx/429)
// ---------------------------------------------------------------------------------------------
async function postDecode(base, item, fetchImpl) {
  const body = {
    rawCode: item.code,
    cleanCode: item.code,
    mode: "decode",
    scanContext: item.bucket === "tire_corpus" || item.bucket === "tire_noncorpus" ? "tire" : "any",
  };
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { res, networkError: null };
    } catch (e) {
      return { res: null, networkError: e };
    } finally {
      clearTimeout(timer);
    }
  };

  let { res, networkError } = await attempt();
  // Retry ONCE, but only on a genuine network error (fetch threw) — never on an HTTP 4xx/429, which
  // is a real server answer, not a transient failure.
  if (networkError) {
    ({ res, networkError } = await attempt());
  }
  if (networkError) {
    return { kind: "error", detail: String(networkError?.message ?? networkError).slice(0, 300) };
  }
  if (res.status === 429) {
    let capJson = null;
    try {
      capJson = await res.json();
    } catch {
      /* non-JSON 429 body */
    }
    return { kind: "cap_blocked", httpStatus: 429, reasonCode: capJson?.reasonCode ?? "daily_cap", raw: capJson };
  }
  if (!res.ok) {
    let errJson = null;
    try {
      errJson = await res.json();
    } catch {
      /* non-JSON error body */
    }
    return { kind: "error", httpStatus: res.status, detail: errJson?.error ?? `HTTP ${res.status}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { kind: "error", detail: `invalid JSON response: ${String(e?.message ?? e)}` };
  }
  return { kind: "ok", json };
}

// ---------------------------------------------------------------------------------------------
// Concurrency-bounded map
// ---------------------------------------------------------------------------------------------
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = Array.from({ length: Math.max(1, concurrency) }, () => lane());
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------------------------
// Resume: which codes already have a recorded row in results/
// ---------------------------------------------------------------------------------------------
function resultsDir() {
  return path.join(REPO_ROOT, ".superpowers", "stress", "results");
}
function batchJsonPath(n) {
  return path.join(resultsDir(), `batch-${n}.json`);
}
function batchMdPath(n) {
  return path.join(resultsDir(), `batch-${n}.md`);
}
function cumulativeMdPath() {
  return path.join(resultsDir(), "cumulative.md");
}
function loadExistingBatch(n) {
  const p = batchJsonPath(n);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function alreadyDoneCodes() {
  // Resumable across ANY prior batch file, not just this batch number — a code that was already
  // decoded in an earlier batch run must never be re-fetched (and re-billed) by a later invocation.
  const dir = resultsDir();
  const done = new Set();
  if (!existsSync(dir)) return done;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return done;
  }
  for (const f of entries) {
    if (!/^batch-\d+\.json$/.test(f)) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      for (const row of data.rows ?? []) done.add(row.code);
    } catch {
      /* skip unreadable file */
    }
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// THE SQUARE: rung x outcome table
// ---------------------------------------------------------------------------------------------
function buildSquare(rows) {
  const table = {};
  for (const r of RUNG_ROWS) {
    table[r.key] = { reached: 0, verified: 0, suggested: 0, missedNext: 0, latencies: [], spentUsd: 0 };
  }
  for (const row of rows) {
    const t = table[row.rung];
    if (!t) continue; // defensive: unknown rung never crashes the report
    t.reached += 1;
    if (row.outcome === "resolved_verified") t.verified += 1;
    else if (row.outcome === "suggested") t.suggested += 1;
    else t.missedNext += 1;
    if (typeof row.latencyMs === "number") t.latencies.push(row.latencyMs);
    if (typeof row.reservedUsd === "number") t.spentUsd += row.reservedUsd;
  }
  return table;
}
function avg(xs) {
  if (!xs.length) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}
function renderSquareMd(square, title) {
  const lines = [];
  lines.push(`### ${title}`, "");
  lines.push("| Rung | Reached | Resolved verified | Suggested | Missed->next | Avg latency (ms) | $ spent |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of RUNG_ROWS) {
    const t = square[r.key];
    const dollar = r.paid ? `$${t.spentUsd.toFixed(2)}` : "-";
    lines.push(`| ${r.label} | ${t.reached} | ${t.verified} | ${t.suggested} | ${t.missedNext} | ${avg(t.latencies)} | ${dollar} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Bucket safety summary
// ---------------------------------------------------------------------------------------------
function bucketSafetySummary(rows) {
  const junk = rows.filter((r) => r.bucket === "junk_vendor");
  const junkReviewed = junk.filter((r) => r.outcome === "needs_review_bare" || r.rung === "needs_review_bare");
  const tireNon = rows.filter((r) => r.bucket === "tire_noncorpus");
  const tireNonSuggested = tireNon.filter((r) => r.outcome === "resolved_verified" || r.outcome === "suggested");
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
  return {
    junkTotal: junk.length,
    junkCorrectlyReviewed: junkReviewed.length,
    junkCorrectlyReviewedPct: pct(junkReviewed.length, junk.length),
    tireNoncorpusTotal: tireNon.length,
    tireNoncorpusAtLeastSuggested: tireNonSuggested.length,
    tireNoncorpusAtLeastSuggestedPct: pct(tireNonSuggested.length, tireNon.length),
  };
}
function renderSafetyMd(safety) {
  return [
    "### Bucket safety summary",
    "",
    `- junk_vendor correctly routed to Needs Review: ${safety.junkCorrectlyReviewed}/${safety.junkTotal} (${safety.junkCorrectlyReviewedPct}%)`,
    `- tire_noncorpus with at least a suggestion: ${safety.tireNoncorpusAtLeastSuggested}/${safety.tireNoncorpusTotal} (${safety.tireNoncorpusAtLeastSuggestedPct}%)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Selftest: monkey-patch fetch with canned responses, run against a fixed 4-code plan, assert.
// ---------------------------------------------------------------------------------------------
function selftestFetch() {
  const responses = {
    "086699449535": { status: 200, json: { decision: { status: "verified", confidence: 0.95 }, results: [{ productName: "Premier LTX", brand: "Michelin" }], providerNames: ["tire-corpus"], debug: { corroborationPath: "tire-corpus", cached: false }, reasonCode: "ok" } },
    "GPT-CODE-0001": { status: 200, json: { decision: { status: "suggested", confidence: 0.7 }, results: [{ productName: "Mystery Widget", brand: "Acme" }], providerNames: ["gpt-5.5-ladder"], debug: { ladderPath: "gpt", cached: false }, reasonCode: "ok" } },
    "ZQX-99417-B": { status: 200, json: { decision: { status: "needs_review", confidence: 0 }, results: [], providerNames: [], debug: { ladderPath: "none", cached: false }, reasonCode: "no_result" } },
    "CAP-BLOCKED-01": { status: 429, json: { error: "Daily AI lookup cap reached", reasonCode: "daily_cap" } },
  };
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const fixture = responses[body.rawCode];
    if (!fixture) {
      return { ok: false, status: 500, json: async () => ({ error: "no fixture" }) };
    }
    return {
      ok: fixture.status >= 200 && fixture.status < 300,
      status: fixture.status,
      json: async () => fixture.json,
    };
  };
}

async function runSelftest() {
  console.log("=== SELFTEST (mock fetch, no network, no money) ===");
  const fetchImpl = selftestFetch();
  const codes = [
    { code: "086699449535", bucket: "corpus_known", meta: {} },
    { code: "GPT-CODE-0001", bucket: "retail_free", meta: {} },
    { code: "ZQX-99417-B", bucket: "junk_vendor", meta: {} },
    { code: "CAP-BLOCKED-01", bucket: "retail_free", meta: {} },
  ];
  const spend = { reservedUsd: 0, gptAttributedCalls: 0, history: [] };
  const rows = [];
  for (const item of codes) {
    const t0 = Date.now();
    const result = await postDecode("http://localhost", item, fetchImpl);
    const latencyMs = Date.now() - t0;
    if (result.kind === "cap_blocked") {
      rows.push({ code: item.code, bucket: item.bucket, rung: "cap_blocked", outcome: "cap_blocked", latencyMs });
      continue;
    }
    if (result.kind === "error") {
      rows.push({ code: item.code, bucket: item.bucket, rung: "error", outcome: "error", latencyMs });
      continue;
    }
    const rung = attributeRung(result.json);
    const outcome = attributeOutcome(result.json);
    let reservedUsd;
    if (rung === "gpt") {
      const ok = reserveGptCall(spend, item.code);
      reservedUsd = ok ? GPT_WORST_CASE_USD : 0;
    }
    rows.push({ code: item.code, bucket: item.bucket, rung, outcome, latencyMs, reservedUsd });
  }

  // Assertions.
  const assertions = [];
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assertions.push(["corpus hit -> tire_corpus/verified", byCode["086699449535"].rung === "tire_corpus" && byCode["086699449535"].outcome === "resolved_verified"]);
  assertions.push(["gpt hit -> gpt/suggested", byCode["GPT-CODE-0001"].rung === "gpt" && byCode["GPT-CODE-0001"].outcome === "suggested"]);
  assertions.push(["gpt hit reserved $0.39", byCode["GPT-CODE-0001"].reservedUsd === GPT_WORST_CASE_USD]);
  assertions.push(["junk -> needs_review_bare", byCode["ZQX-99417-B"].rung === "needs_review_bare" && byCode["ZQX-99417-B"].outcome === "needs_review_bare"]);
  assertions.push(["429 -> cap_blocked (not needs_review)", byCode["CAP-BLOCKED-01"].rung === "cap_blocked"]);
  assertions.push(["spend guard total after 1 gpt call", spend.reservedUsd === GPT_WORST_CASE_USD]);

  // Spend guard math: simulate reaching the cap.
  const capSpend = { reservedUsd: 9.8, gptAttributedCalls: 25, history: [] };
  const firstOk = reserveGptCall(capSpend, "A");
  assertions.push(["reserve under cap succeeds (9.80+0.39<=10.00 fails, expect false since 10.19>10.00)", firstOk === false]);
  const nearCapSpend = { reservedUsd: 9.6, gptAttributedCalls: 24, history: [] };
  const secondOk = reserveGptCall(nearCapSpend, "B");
  assertions.push(["reserve exactly at boundary succeeds (9.60+0.39=9.99<=10.00)", secondOk === true && nearCapSpend.reservedUsd === 9.99]);

  const square = buildSquare(rows.filter((r) => RUNG_KEYS.has(r.rung)));
  assertions.push(["square has tire_corpus reached=1", square.tire_corpus.reached === 1]);
  assertions.push(["square has gpt reached=1 spent=0.39", square.gpt.reached === 1 && Math.abs(square.gpt.spentUsd - 0.39) < 1e-9]);

  let failed = 0;
  for (const [name, pass] of assertions) {
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`);
    if (!pass) failed++;
  }
  console.log(renderSquareMd(square, "Selftest square"));
  console.log(`\nSELFTEST ${failed === 0 ? "PASSED" : `FAILED (${failed} assertion(s))`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) {
    await runSelftest();
    return;
  }

  if (!args.codes) {
    console.error("Missing --codes <path to codes.json>");
    process.exitCode = 1;
    return;
  }
  if (!args.batch || args.batch < 1) {
    console.error("Missing/invalid --batch <N> (1-indexed)");
    process.exitCode = 1;
    return;
  }
  const buckets = loadCodesFile(args.codes);
  const plan = planBatch(buckets, args.batch, args.size);

  if (args.dry) {
    console.log(`Batch plan (--dry, no network calls):`);
    console.log(`  codes file: ${args.codes}`);
    console.log(`  batch: ${args.batch}/${plan.totalBatches}  size: ${args.size}  total codes: ${plan.totalCodes}`);
    const byBucket = {};
    for (const item of plan.items) byBucket[item.bucket] = (byBucket[item.bucket] ?? 0) + 1;
    console.log(`  mix:`, byBucket);
    console.log(`  codes:`);
    for (const item of plan.items) console.log(`    ${item.code}  [${item.bucket}]`);
    return;
  }

  if (!args.base) {
    console.error("Missing --base <url> (e.g. https://<preview-url> or http://localhost:3000)");
    process.exitCode = 1;
    return;
  }

  mkdirSync(resultsDir(), { recursive: true });

  // Resumable: skip codes already present in ANY prior results/batch-*.json.
  const done = alreadyDoneCodes();
  const existingBatch = loadExistingBatch(args.batch);
  const rows = existingBatch?.rows ? [...existingBatch.rows] : [];
  const alreadyInThisBatch = new Set(rows.map((r) => r.code));
  const pending = plan.items.filter((item) => !done.has(item.code) && !alreadyInThisBatch.has(item.code));

  console.log(`Batch ${args.batch}/${plan.totalBatches}: ${plan.items.length} planned, ${pending.length} to fetch (${plan.items.length - pending.length} already resolved/skipped in a prior run).`);

  // MONEY GUARD: peek at server status before starting (best-effort; a failed peek does not block —
  // the persisted spend.json guard is the hard stop regardless of server-reported status).
  try {
    const statusRes = await fetch(`${args.base}/api/ai-lookup`, { method: "GET" });
    if (statusRes.ok) {
      const status = await statusRes.json();
      console.log(`Server status: daily used=${status?.daily?.used}/${status?.daily?.limit}, GPT spent today=$${status?.gptLadder?.spentTodayUsd ?? "?"}`);
    }
  } catch {
    console.warn("Could not reach GET /api/ai-lookup status endpoint before starting (continuing; spend guard still enforced).");
  }

  const spend = loadSpend();
  console.log(`Money guard: reserved so far across all batches = $${spend.reservedUsd.toFixed(2)} / $${BUDGET_CAP_USD.toFixed(2)} cap.`);
  let budgetExhausted = spend.reservedUsd >= BUDGET_CAP_USD;

  const skippedBudget = [];
  const toFetch = [];
  for (const item of pending) {
    if (budgetExhausted) {
      skippedBudget.push(item);
    } else {
      toFetch.push(item);
    }
  }

  const newRows = await runWithConcurrency(toFetch, args.concurrency, async (item) => {
    if (budgetExhausted) {
      skippedBudget.push(item);
      return null;
    }
    const t0 = Date.now();
    const result = await postDecode(args.base, item, fetch);
    const latencyMs = Date.now() - t0;

    if (result.kind === "error") {
      return { code: item.code, bucket: item.bucket, rung: "error", outcome: "error", latencyMs, detail: result.detail, httpStatus: result.httpStatus };
    }
    if (result.kind === "cap_blocked") {
      // Honor 429/cap responses honestly — never recorded as needs_review.
      return { code: item.code, bucket: item.bucket, rung: "cap_blocked", outcome: "cap_blocked", latencyMs, reasonCode: result.reasonCode };
    }

    const rung = attributeRung(result.json);
    const outcome = attributeOutcome(result.json);
    let reservedUsd;
    if (rung === "gpt") {
      // MONEY GUARD (hard): reserve worst-case BEFORE counting this call as complete. If reserving
      // would exceed the cap, the call has ALREADY happened (we don't un-ring that bell for the
      // in-flight one), but every subsequent code in this and future batches is skipped_budget.
      const ok = reserveGptCall(spend, item.code);
      reservedUsd = GPT_WORST_CASE_USD; // charge the worst case regardless — it was a genuine GPT-attributed completion
      if (!ok) {
        budgetExhausted = true;
      }
      saveSpend(spend);
    }
    return {
      code: item.code,
      bucket: item.bucket,
      rung,
      outcome,
      latencyMs,
      reservedUsd,
      productName: result.json?.results?.[0]?.productName ?? "",
      brand: result.json?.results?.[0]?.brand ?? "",
      status: result.json?.decision?.status ?? null,
      reasonCode: result.json?.reasonCode ?? null,
    };
  });

  for (const r of newRows) {
    if (r) rows.push(r);
  }
  for (const item of skippedBudget) {
    if (!rows.some((r) => r.code === item.code)) {
      rows.push({ code: item.code, bucket: item.bucket, rung: "skipped_budget", outcome: "skipped_budget", latencyMs: null });
    }
  }

  const batchResult = {
    batch: args.batch,
    size: args.size,
    codesFile: args.codes,
    plannedCodes: plan.items.map((i) => ({ code: i.code, bucket: i.bucket })),
    generatedAt: new Date().toISOString(),
    rows,
    moneyGuard: { reservedUsdAfterBatch: spend.reservedUsd, capUsd: BUDGET_CAP_USD, budgetExhausted },
  };
  writeFileSync(batchJsonPath(args.batch), JSON.stringify(batchResult, null, 2));

  // Per-batch square (this batch's rows only).
  const square = buildSquare(rows);
  const safety = bucketSafetySummary(rows);
  const capBlockedCount = rows.filter((r) => r.rung === "cap_blocked").length;
  const errorCount = rows.filter((r) => r.rung === "error").length;
  const skippedBudgetCount = rows.filter((r) => r.rung === "skipped_budget").length;
  const md = [
    `# Batch ${args.batch} (${rows.length} codes)`,
    "",
    `Generated ${batchResult.generatedAt}. Money reserved after this batch: $${spend.reservedUsd.toFixed(2)} / $${BUDGET_CAP_USD.toFixed(2)}.`,
    "",
    renderSquareMd(square, "THE SQUARE (this batch)"),
    "",
    renderSafetyMd(safety),
    "",
    `### Non-rung outcomes`,
    "",
    `- cap_blocked: ${capBlockedCount}`,
    `- error: ${errorCount}`,
    `- skipped_budget: ${skippedBudgetCount}`,
    "",
  ].join("\n");
  writeFileSync(batchMdPath(args.batch), md);

  // Cumulative report across ALL completed batches found on disk.
  const allBatchFiles = existsSync(resultsDir())
    ? readdirSync(resultsDir()).filter((f) => /^batch-\d+\.json$/.test(f))
    : [];
  const allRows = [];
  for (const f of allBatchFiles) {
    try {
      const data = JSON.parse(readFileSync(path.join(resultsDir(), f), "utf8"));
      allRows.push(...(data.rows ?? []));
    } catch {
      /* skip unreadable file */
    }
  }
  const cumSquare = buildSquare(allRows);
  const cumSafety = bucketSafetySummary(allRows);
  const cumMd = [
    `# Cumulative (${allBatchFiles.length} batch file(s), ${allRows.length} codes)`,
    "",
    `Generated ${new Date().toISOString()}. Total reserved: $${spend.reservedUsd.toFixed(2)} / $${BUDGET_CAP_USD.toFixed(2)}.`,
    "",
    renderSquareMd(cumSquare, "THE SQUARE (cumulative)"),
    "",
    renderSafetyMd(cumSafety),
    "",
  ].join("\n");
  writeFileSync(cumulativeMdPath(), cumMd);

  console.log(`\nWrote ${batchJsonPath(args.batch)}`);
  console.log(`Wrote ${batchMdPath(args.batch)}`);
  console.log(`Wrote ${cumulativeMdPath()}`);
  console.log(md);

  if (budgetExhausted && skippedBudgetCount > 0) {
    console.error(`\nMONEY GUARD: budget cap ($${BUDGET_CAP_USD}) reached. ${skippedBudgetCount} code(s) skipped_budget this batch.`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
