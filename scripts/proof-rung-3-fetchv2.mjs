// Rung 3 live micro-proof: Fetch V2, HARD SET ONLY (double-miss tail). BUILD-ONLY in this
// dispatch -- the controller authorizes a --live run in a follow-up message after reviewing
// rungs 1-2 (task brief: "You do NOT run rungs 3-4 ... you BUILD their scripts but stop before
// any Firecrawl/GPT spend"). This file is the harness; `--dry-run` validates inputs with ZERO
// network calls and zero Firecrawl credits spent.
//
// Input set: the 61 double-miss codes -- scripts/tmp-goupc-200-misses.txt (74 codes that BOTH
// corpus and Go-UPC missed) MINUS the 13 Fetch V2 already resolved (verified/suggested outcomes
// recorded in scripts/tmp-fetchv2-goupc-misses.json). That difference is EXACTLY
// scripts/tmp-fetchv2-misses.txt (61 codes, the "refused" outcomes) -- reconciled and asserted
// below rather than assumed, since the file *names* in the brief map opposite to their *roles*
// (tmp-fetchv2-misses.txt holds the STILL-UNRESOLVED codes, not "the resolved 13").
//
// Compares resolution rate vs the 17.6% baseline (13/74 from the same prior run) and enforces a
// zero-wrong gate (any verified/suggested identity must match the corpus/fixture truth already
// recorded for that code in tmp-fetchv2-goupc-misses.json).
//
// Integrity rule: --live hits the REAL POST /api/ai-lookup route (mode: "decode") on a local dev
// server with real .env.local keys -- never imports fetchV2()/rung functions directly.
//
// Usage:
//   node scripts/proof-rung-3-fetchv2.mjs --dry-run                validates inputs, $0, no network
//   node scripts/proof-rung-3-fetchv2.mjs --live --sample=20 --port=3107   SPENDS Firecrawl credits (owner-gated)
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const LIVE = process.argv.includes("--live");
const SAMPLE_N = Number(process.argv.find((a) => a.startsWith("--sample="))?.slice(9) ?? 20);
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3107);
const EXTERNAL_BASE = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11) ?? null;
const BASE_URL = EXTERNAL_BASE ?? `http://localhost:${PORT}`;

const BASELINE_RESOLVED = 13;
const BASELINE_TOTAL = 74;
const BASELINE_RATE = BASELINE_RESOLVED / BASELINE_TOTAL; // 0.1757 ("17.6%")

const OUT = new URL("./proof-rung-3-results.json", import.meta.url);
const REPORT = new URL("./proof-ladder-report.md", import.meta.url);

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

/** Build + reconcile the double-miss / still-unresolved input sets. Pure, no network. */
function buildInputSets() {
  const misses = readFileSync(new URL("./tmp-goupc-200-misses.txt", import.meta.url), "utf8").trim().split(",").map((s) => s.trim()).filter(Boolean);
  const stillUnresolved = readFileSync(new URL("./tmp-fetchv2-misses.txt", import.meta.url), "utf8").trim().split(",").map((s) => s.trim()).filter(Boolean);
  const priorRun = JSON.parse(readFileSync(new URL("./tmp-fetchv2-goupc-misses.json", import.meta.url), "utf8"));
  const truthByCode = new Map(priorRun.rows.map((r) => [r.code, r]));

  const missesSet = new Set(misses);
  const stillUnresolvedSet = new Set(stillUnresolved);
  const resolvedCodes = misses.filter((c) => !stillUnresolvedSet.has(c));
  const reconciled =
    misses.length === BASELINE_TOTAL &&
    resolvedCodes.length === BASELINE_RESOLVED &&
    stillUnresolved.every((c) => missesSet.has(c)) &&
    resolvedCodes.every((c) => truthByCode.get(c)?.outcome === "verified" || truthByCode.get(c)?.outcome === "suggested");

  return { misses, stillUnresolved, resolvedCodes, truthByCode, reconciled };
}

async function waitForServer(baseUrl, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const res = await fetch(`${baseUrl}/api/ai-lookup`, { method: "GET" }); if (res.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const { misses, stillUnresolved, resolvedCodes, truthByCode, reconciled } = buildInputSets();

  console.log(`double-miss set (misses): ${misses.length} codes`);
  console.log(`already resolved by Fetch V2 (prior run): ${resolvedCodes.length} codes`);
  console.log(`still unresolved (this rung's input pool): ${stillUnresolved.length} codes`);
  console.log(`reconciliation (misses = stillUnresolved ∪ resolvedCodes, resolvedCodes all verified/suggested): ${reconciled}`);

  if (!reconciled) {
    console.error("INPUT VALIDATION FAILED: the three miss files do not reconcile as expected. Fix inputs before --live.");
    process.exitCode = 1;
    if (!LIVE) return;
    process.exit(1);
  }

  if (stillUnresolved.length < SAMPLE_N) {
    console.warn(`WARNING: requested sample ${SAMPLE_N} > pool size ${stillUnresolved.length}; will use the full pool.`);
  }
  const sample = stillUnresolved.slice(0, Math.min(SAMPLE_N, stillUnresolved.length));
  console.log(`sample for this run: ${sample.length} codes`);
  console.log(`baseline resolution rate to beat: ${(BASELINE_RATE * 100).toFixed(1)}% (${BASELINE_RESOLVED}/${BASELINE_TOTAL})`);

  if (DRY_RUN) {
    const dryRunResult = {
      mode: "dry-run",
      at: new Date().toISOString(),
      inputValidation: { misses: misses.length, resolvedCodes: resolvedCodes.length, stillUnresolved: stillUnresolved.length, reconciled },
      sample,
      sampleSize: sample.length,
      baselineRate: BASELINE_RATE,
      note: "Zero network calls, zero Firecrawl credits spent. Awaiting controller authorization for --live (owner-gated: T19 dispatch scope is rungs 1-2 live only).",
    };
    writeFileSync(OUT, JSON.stringify(dryRunResult, null, 2));
    console.log(`\ndry-run OK. wrote ${OUT.pathname}`);
    const section = `\n## Rung 3 (Fetch V2, HARD SET ONLY) -- BUILT, DRY-RUN ONLY (not authorized to spend this dispatch)\n\n- Input reconciliation: \`tmp-goupc-200-misses.txt\` (${misses.length} double-miss codes) = \`tmp-fetchv2-misses.txt\` (${stillUnresolved.length} still-unresolved) ∪ the ${resolvedCodes.length} codes Fetch V2 already resolved in \`tmp-fetchv2-goupc-misses.json\` (all verified/suggested). Reconciled: ${reconciled}.\n- Dry-run validated a ${sample.length}-code sample from the still-unresolved pool with ZERO network calls / ZERO Firecrawl credits.\n- Baseline to beat: ${(BASELINE_RATE * 100).toFixed(1)}% (${BASELINE_RESOLVED}/${BASELINE_TOTAL}). Success gate for a live run: resolution rate strictly > baseline AND zero wrong identities vs corpus/fixture truth.\n- Live invocation (owner-gated, not run this dispatch): \`node scripts/proof-rung-3-fetchv2.mjs --live --sample=20 --port=3107\`.\n- Raw: \`scripts/proof-rung-3-results.json\`.\n`;
    appendFileSync(REPORT, section);
    console.log(`appended Rung 3 (dry-run) section to ${REPORT.pathname}`);
    return;
  }

  if (!LIVE) {
    console.error("pass --dry-run to validate inputs with $0 spend, or --live to actually spend Firecrawl credits (owner-gated).");
    process.exit(1);
  }

  // ---- LIVE PATH (authorized by the controller 2026-07-09, phase 2) ------------------------------
  // RUNG ISOLATION VIA KEYS (still the real route, per the integrity rule): the server runs with the
  // real Firecrawl/Brave/Turso keys but GO_UPC_API_KEY and OPENAI_API_KEY BLANKED:
  //   - Go-UPC blanked: every sample code is an already-proven Go-UPC miss (the goupc-200 benchmark),
  //     so letting the goupc rung run would spend ~20 quota lookups re-proving known misses and eat
  //     half the 40-lookup phase cap for zero information. The rung skips loudly ("key not configured").
  //   - OpenAI blanked: this rung's budget is Firecrawl-only (<= CREDIT_BUDGET). Without this, every
  //     Fetch V2 miss would fall through to the paid GPT rung and spend rung-4's budget here.
  // Plan D still runs first for these 12/13-digit public barcodes (it is part of the real route) and
  // can spend Firecrawl credits (search + scrape); that spend is counted in the worst-case reservation.
  const CREDIT_BUDGET = 150;
  // Worst-case Firecrawl credits per code through this server: Plan D /search (1) + Plan D cheap
  // scrape (1) + Fetch V2 firecrawl-search discovery (1). fetchPage is a plain fetch ($0); brocade,
  // pattern URLs, and Brave discovery are not Firecrawl credits.
  const WORST_CASE_CREDITS_PER_CODE = 3;

  const envLocal = loadEnvLocal();
  if (!envLocal.FIRECRAWL_API_KEY_1 && !envLocal.FIRECRAWL_API_KEY) {
    console.error("no Firecrawl key configured -- cannot run --live");
    process.exit(1);
  }
  let child = null;
  if (!EXTERNAL_BASE) {
    const env = {
      ...process.env, ...envLocal,
      GO_UPC_API_KEY: "",   // rung isolation: proven misses, don't re-spend quota
      OPENAI_API_KEY: "",   // rung isolation: zero GPT spend in rung 3
      PORT: String(PORT), NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
    };
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const up = await waitForServer(BASE_URL, 90_000);
    if (!up) { console.error("dev server did not come up"); killServerTree(child); process.exit(1); }
    console.log(`dev server up on ${PORT} (GO_UPC + OPENAI blanked; Firecrawl/Brave real).`);
  }

  // Conservative automatic grade vs corpus truth: shared distinctive tokens (len>=3, not generic).
  const GENERIC = new Set(["tire", "tires", "the", "and", "with", "for", "size", "pack", "count", "oz", "ounce"]);
  const toks = (s) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
  function gradeVsTruth(productName, truth) {
    if (!productName) return "no_answer";
    if (!truth) return "no_truth_available";
    const a = toks(productName), b = toks(truth);
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    if (shared >= 2) return "match";
    if (shared === 1) return "partial_needs_manual";
    return "mismatch_candidate"; // candidate WRONG identity - flagged for manual adjudication
  }

  const results = { startedAt: new Date().toISOString(), port: PORT, isolation: "GO_UPC_API_KEY + OPENAI_API_KEY blanked (real route, rung isolation)", creditBudget: CREDIT_BUDGET, worstCaseCreditsPerCode: WORST_CASE_CREDITS_PER_CODE, sample, rows: [] };
  let resolvedNow = 0, fetchv2Settled = 0, mismatchCandidates = 0, attempted = 0, skippedByBudget = 0;
  let reservedCredits = 0;

  for (const code of sample) {
    if (reservedCredits + WORST_CASE_CREDITS_PER_CODE > CREDIT_BUDGET) {
      skippedByBudget++;
      console.log(`[budget] ${code} skipped: reserved ${reservedCredits} + ${WORST_CASE_CREDITS_PER_CODE} would exceed ${CREDIT_BUDGET} credits`);
      continue;
    }
    reservedCredits += WORST_CASE_CREDITS_PER_CODE;
    attempted++;
    const t0 = Date.now();
    let row = { code };
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode", forceRetry: true }),
      });
      const json = await res.json();
      const truth = truthByCode.get(code);
      row.wallMs = Date.now() - t0;
      row.httpStatus = res.status;
      row.status = json?.decision?.status ?? null;
      row.productName = json?.decision?.result?.productName ?? json?.results?.[0]?.productName ?? null;
      row.ladderPath = json?.debug?.ladderPath ?? null;
      row.corroborationPath = json?.debug?.corroborationPath ?? null;
      row.settledBy = row.ladderPath && row.ladderPath !== "none" ? row.ladderPath : (row.corroborationPath ?? "none");
      row.ladderReasons = json?.debug?.ladderReasons ?? null;
      row.priorTruth = truth?.truth ?? null;
      row.priorOutcome = truth?.outcome ?? null;
      row.grade = (row.status === "verified" || row.status === "suggested") ? gradeVsTruth(row.productName, truth?.truth) : "unresolved";
      if (row.status === "verified" || row.status === "suggested") resolvedNow++;
      if (row.settledBy === "fetchv2") fetchv2Settled++;
      if (row.grade === "mismatch_candidate") mismatchCandidates++;
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      row.wallMs = Date.now() - t0;
      row.grade = "error";
    }
    results.rows.push(row);
    console.log(`[rung3] ${code} -> ${row.status ?? "ERR"} settledBy=${row.settledBy ?? "?"} grade=${row.grade} | ${(row.productName ?? row.error ?? "").slice(0, 70)} (${row.wallMs}ms)`);
  }

  const rateNow = attempted ? resolvedNow / attempted : 0;
  results.summary = {
    sampleSize: sample.length,
    attempted,
    skippedByBudget,
    resolvedNow,
    fetchv2Settled,
    rateNow,
    baselineRate: BASELINE_RATE,
    beatsBaseline: rateNow > BASELINE_RATE,
    mismatchCandidates,
    zeroWrongGate: mismatchCandidates === 0 ? "PASS (0 mismatch candidates; partials flagged for manual adjudication, see rows)" : `REVIEW NEEDED: ${mismatchCandidates} mismatch candidate(s) vs corpus truth`,
    creditsWorstCaseReserved: reservedCredits,
    walletLine: `computed worst-case Firecrawl ceiling ${reservedCredits} credits (${attempted} codes x ${WORST_CASE_CREDITS_PER_CODE}); true spend = Firecrawl console`,
  };
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT.pathname}`);
  console.log(`resolved ${resolvedNow}/${attempted} (${(rateNow * 100).toFixed(1)}%) vs baseline ${(BASELINE_RATE * 100).toFixed(1)}%; fetchv2-settled ${fetchv2Settled}; mismatch candidates ${mismatchCandidates}`);
  console.log(results.summary.walletLine);

  const section = `\n## Rung 3 (Fetch V2, HARD SET ONLY) -- LIVE (phase 2)\n\n- Sample: ${attempted}/${sample.length} codes attempted from the 61-code still-unresolved pool (${skippedByBudget} skipped by the ${CREDIT_BUDGET}-credit budget guard).\n- Rung isolation (real route): GO_UPC_API_KEY blanked (all sample codes are already-proven Go-UPC misses; re-spending ~${sample.length} quota lookups proves nothing) and OPENAI_API_KEY blanked (zero GPT spend this rung). Plan D + Fetch V2 run exactly as wired.\n- Resolved: ${resolvedNow}/${attempted} (${(rateNow * 100).toFixed(1)}%) vs 17.6% baseline -> beats baseline: ${results.summary.beatsBaseline}. Settled by fetchv2 rung specifically: ${fetchv2Settled}.\n- Zero-wrong gate: ${results.summary.zeroWrongGate}.\n- Wallet: ${results.summary.walletLine}.\n- Raw: \`scripts/proof-rung-3-results.json\`.\n`;
  appendFileSync(REPORT, section);
  console.log(`appended Rung 3 (live) section to ${REPORT.pathname}`);
  if (child) { console.log("shutting down dev server..."); killServerTree(child); await new Promise((r) => setTimeout(r, 1000)); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
