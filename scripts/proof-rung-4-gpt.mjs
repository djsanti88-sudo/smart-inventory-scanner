// Rung 4 live micro-proof: GPT-5.5 (v3 prompt), HARD SET ONLY, <= $1.50 worst-case (this rung's
// share of the phase-wide $3.00 GPT-5.5 cap, split with Task 20's full-ladder run per the plan's
// Phase G header). BUILD-ONLY in this dispatch -- owner/controller authorizes --live separately
// after reviewing rungs 1-2 AND after rung 3 has run (this rung's input is "codes rung 3 still
// cannot resolve", so it depends on rung 3's live output, which does not exist yet).
//
// Budget-guard pattern copied from scripts/tmp-gpt-goupc-misses.mts (owner's cost-truth rule: a
// client-aborted/timed-out call still bills server-side, so the gate reserves WORST CASE before
// every call, never the observed average).
//
// Junk-guess gate: 0 junk guesses required (v2 baseline from 2026-07-08: 3 junk in 7 -- e.g. a
// music-CD guess for a Toyo tire). Honest-empty (empty productName + populated category/basis) is
// allowed and does NOT count as junk. Any non-empty verified/suggested answer must match the
// corpus/fixture truth already on file for that code.
//
// Integrity rule: --live hits the REAL POST /api/ai-lookup route (mode: "decode"), never
// gptFromScratch() directly -- so the app's evidence-gate/decision wiring is exercised for real,
// not bypassed.
//
// GATED (owner incident 2026-08-13, TL2-1 re-verification): --live alone used to be enough to spend
// real OpenAI money. scripts/lib/paidScriptGuard.mjs now also requires --yes-i-accept-cost, matching
// every other Lane 1 paid script. Reading .env.local here is legitimate (launching the actual app).
//
// Usage:
//   node scripts/proof-rung-4-gpt.mjs --dry-run                                                        validates guard math, $0
//   node scripts/proof-rung-4-gpt.mjs --live --yes-i-accept-cost --codes=CODE1,CODE2,... --port=3108    SPENDS OpenAI $ (owner-gated)
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { requireLiveApproval } from "./lib/paidScriptGuard.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const LIVE_REQUESTED = process.argv.includes("--live");
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3108);
const EXTERNAL_BASE = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11) ?? null;
const BASE_URL = EXTERNAL_BASE ?? `http://localhost:${PORT}`;
const CODES = process.argv.find((a) => a.startsWith("--codes="))?.slice(8).split(",").map((s) => s.trim()).filter(Boolean) ?? [];
// --dry-run already gives a full $0 guard-math-validation path; only gate the ACTUAL --live spend path.
const LIVE = LIVE_REQUESTED && requireLiveApproval({
  worstCaseFloorUsd: 1.5, // this rung's reserved slice of the phase's $3.00 GPT-5.5 cap (HARD_CAP below)
  describe: () => `Would spawn a real "next dev" server with REAL .env.local keys and run ${CODES.length || "the configured"} hard-tail codes through the live GPT-5.5 rung, spending real OpenAI money.`,
}).live;

// Reserved worst-case-per-call from the probe-parity shape (copied from tmp-gpt-goupc-misses.mts,
// same $0.39/call figure measured at 18s / 5 searches probe parity). HARD_CAP is this rung's
// reserved SLICE of the phase's $3.00 total GPT-5.5 cap (Task 19 gets $1.50; Task 20's full-ladder
// run reserves the other $1.50 -- see plan Phase G header + task brief step 3).
const WORST_CASE_PER_CALL = 0.39;
const HARD_CAP = 1.5;
const JUNK_GATE = 0; // max allowed junk guesses (v2 baseline was 3/7)

const OUT = new URL("./proof-rung-4-results.json", import.meta.url);
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

/** How many calls the reserved worst-case allows before the cap trips. Pure, testable in --dry-run. */
function maxCallsUnderCap(hardCap, worstCasePerCall) {
  return Math.floor(hardCap / worstCasePerCall);
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
  const maxCalls = maxCallsUnderCap(HARD_CAP, WORST_CASE_PER_CALL);
  if (DRY_RUN) console.log(`worst-case reserve: $${WORST_CASE_PER_CALL}/call, hard cap $${HARD_CAP} -> max ${maxCalls} calls before the guard trips`);
  console.log(`junk-guess gate: <= ${JUNK_GATE} (v2 baseline: 3 junk in 7)`);

  if (DRY_RUN) {
    const plannedCodes = CODES.length ? CODES : Array.from({ length: 10 }, (_, i) => `PLACEHOLDER_${i + 1}`);
    const dryRunResult = {
      mode: "dry-run",
      at: new Date().toISOString(),
      hardCapUsd: HARD_CAP,
      worstCasePerCallUsd: WORST_CASE_PER_CALL,
      maxCallsUnderCap: maxCalls,
      junkGate: JUNK_GATE,
      plannedSampleSize: 10,
      guardMathValid: maxCalls >= 10 && HARD_CAP <= 1.5,
      note: "Zero network calls, zero OpenAI $ spent. Input codes are 'rung 3's still-unresolved tail' -- do not exist until rung 3 runs live. Awaiting controller authorization for --live.",
    };
    writeFileSync(OUT, JSON.stringify(dryRunResult, null, 2));
    console.log(`\ndry-run OK (guard math valid: ${dryRunResult.guardMathValid}). wrote ${OUT.pathname}`);
    const marginNote = maxCalls >= 10
      ? `guard allows at most ${maxCalls} calls before stopping (10-code sample fits with margin)`
      : `CONCERN: guard allows at most ${maxCalls} calls under this $${HARD_CAP} cap at the $${WORST_CASE_PER_CALL}/call worst-case reserve -- a 10-code sample does NOT fit (10 * $${WORST_CASE_PER_CALL} = $${(10 * WORST_CASE_PER_CALL).toFixed(2)} > $${HARD_CAP}). Even the FULL phase-wide $3.00 GPT-5.5 cap only affords ${Math.floor(3.0 / WORST_CASE_PER_CALL)} calls at this worst-case rate, not 10. The plan's "$1.5 (half split) / 10-code sample" combination is arithmetically inconsistent as written -- the controller must either raise this rung's reserved cap, accept a smaller sample (<=${maxCalls} codes), or confirm a lower true worst-case-per-call before authorizing --live`;
    const section = `\n## Rung 4 (GPT-5.5 v3 prompt, HARD SET ONLY, <= $${HARD_CAP}) -- BUILT, DRY-RUN ONLY (not authorized to spend this dispatch)\n\n- Budget guard (copied pattern from \`scripts/tmp-gpt-goupc-misses.mts\`): worst-case reserve $${WORST_CASE_PER_CALL}/call, hard cap $${HARD_CAP} (this rung's reserved slice of the phase's $3.00 total GPT-5.5 cap) -> ${marginNote}.\n- Junk-guess gate: <= ${JUNK_GATE} (2026-07-08 v2-prompt baseline was 3 junk in 7; the v3 prompt under test is designed to kill this).\n- Dry-run validated the guard math with ZERO network calls / ZERO OpenAI spend.\n- Input dependency: this rung's 10-code sample is drawn from codes rung 3 STILL cannot resolve -- it does not exist until rung 3 has actually run live, so this rung cannot execute before rung 3.\n- Live invocation (owner-gated, not run this dispatch): \`node scripts/proof-rung-4-gpt.mjs --live --codes=CODE1,CODE2,...,CODE10 --port=3108\`.\n- Raw: \`scripts/proof-rung-4-results.json\`.\n`;
    appendFileSync(REPORT, section);
    console.log(`appended Rung 4 (dry-run) section to ${REPORT.pathname}`);
    return;
  }

  if (!LIVE) {
    console.error("pass --dry-run to validate the budget guard with $0 spend, or --live --codes=... to actually spend (owner-gated).");
    process.exit(1);
  }
  if (!CODES.length) { console.error("--codes= required for --live"); process.exit(1); }

  // ---- LIVE PATH (authorized by the controller 2026-07-09, phase 2) ------------------------------
  // BUDGET RESOLUTION (controller decision): check-before-spend WITH ACTUALS, against the PHASE cap.
  // Before each call: actualSpentThisRun + $0.39 (worst case ONE call) <= $3.00. Actuals come from the
  // route's own telemetry (GET /api/ai-lookup -> gptLadder.spentTodayUsd, fed by recordGptLadderSpend
  // with each call's real usdActual). Low actuals let all 10 codes run; high actuals stop early.
  // The route ALSO enforces its own identical server-side daily guard (GPT_LADDER_DAILY_USD=3 default),
  // so this client-side guard is redundant defense, not the only wall.
  const PHASE_CAP = 3.0;
  // RUNG ISOLATION VIA KEYS (still the real route): real OPENAI_API_KEY; GO_UPC_API_KEY, all
  // FIRECRAWL keys, and BRAVE blanked so the goupc rung skips (these codes are proven misses) and
  // Fetch V2 runs free doors only (no credits) before falling through to the GPT rung under test.
  const envLocal = loadEnvLocal();
  if (!envLocal.OPENAI_API_KEY) { console.error("no OPENAI_API_KEY configured"); process.exit(1); }
  let child = null;
  if (!EXTERNAL_BASE) {
    const env = {
      ...process.env, ...envLocal,
      GO_UPC_API_KEY: "",
      FIRECRAWL_API_KEY: "",
      FIRECRAWL_API_KEY_1: "", FIRECRAWL_API_KEY_2: "", FIRECRAWL_API_KEY_3: "", FIRECRAWL_API_KEY_4: "",
      FIRECRAWL_API_KEY_5: "", FIRECRAWL_API_KEY_6: "", FIRECRAWL_API_KEY_7: "", FIRECRAWL_API_KEY_8: "",
      FIRECRAWL_API_KEY_9: "", FIRECRAWL_API_KEY_10: "",
      BRAVE_SEARCH_API_KEY: "",
      PORT: String(PORT), NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
    };
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const up = await waitForServer(BASE_URL, 90_000);
    if (!up) { console.error("dev server did not come up"); killServerTree(child); process.exit(1); }
    console.log(`dev server up on ${PORT} (OPENAI real; GO_UPC/FIRECRAWL/BRAVE blanked).`);
  }

  async function gptActuals() {
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, { method: "GET" });
      const j = await res.json();
      return { spentTodayUsd: Number(j?.gptLadder?.spentTodayUsd ?? 0), callsToday: j?.gptLadder?.callsToday ?? null };
    } catch { return { spentTodayUsd: null, callsToday: null }; }
  }
  const baseline = await gptActuals();
  if (baseline.spentTodayUsd === null) { console.error("cannot read gptLadder actuals telemetry"); if (child) killServerTree(child); process.exit(1); }
  console.log(`GPT actuals baseline (today, route-recorded): $${baseline.spentTodayUsd.toFixed(4)}; phase cap for this run: $${PHASE_CAP}`);

  const results = { startedAt: new Date().toISOString(), port: PORT, isolation: "OPENAI real; GO_UPC + FIRECRAWL(1-10, legacy) + BRAVE blanked (real route, rung isolation)", phaseCapUsd: PHASE_CAP, worstCasePerCallUsd: WORST_CASE_PER_CALL, gptActualsBaseline: baseline, rows: [] };
  let attempted = 0, skippedByBudget = 0, junkCandidates = 0, honestEmpty = 0, answered = 0;

  for (const code of CODES) {
    const now = await gptActuals();
    const actualSpentThisRun = (now.spentTodayUsd ?? 0) - baseline.spentTodayUsd;
    if (actualSpentThisRun + WORST_CASE_PER_CALL > PHASE_CAP) {
      skippedByBudget++;
      console.log(`[budget] ${code} skipped: actuals $${actualSpentThisRun.toFixed(4)} + $${WORST_CASE_PER_CALL} worst case > $${PHASE_CAP}`);
      continue;
    }
    attempted++;
    const t0 = Date.now();
    let row = { code, actualsBeforeCallUsd: Math.round(actualSpentThisRun * 10000) / 10000 };
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode", forceRetry: true }),
      });
      const json = await res.json();
      row.wallMs = Date.now() - t0;
      row.httpStatus = res.status;
      row.status = json?.decision?.status ?? null;
      row.productName = json?.decision?.result?.productName ?? json?.results?.[0]?.productName ?? "";
      row.category = json?.results?.[0]?.category ?? "";
      row.ladderPath = json?.debug?.ladderPath ?? null;
      row.corroborationPath = json?.debug?.corroborationPath ?? null;
      row.settledBy = row.ladderPath && row.ladderPath !== "none" ? row.ladderPath : (row.corroborationPath ?? "none");
      row.ladderReasons = json?.debug?.ladderReasons ?? null;
      row.gptSkipReason = json?.debug?.gptLadderSkipReason ?? null;
      // Junk-guess classification (auto, conservative): only rows the GPT rung actually settled count.
      // honest-empty = the rung ran but returned no product (allowed). A non-empty GPT answer is graded
      // by the caller vs corpus truth (these are double-miss codes; corpus truth lives in the rung-3
      // results' priorTruth) - the JSON keeps everything needed for that adjudication.
      if (row.settledBy === "gpt") {
        if (row.productName) answered++;
        else honestEmpty++;
      } else if (!row.productName) {
        honestEmpty++;
      }
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      row.wallMs = Date.now() - t0;
    }
    const afterCall = await gptActuals();
    row.actualsAfterCallUsd = Math.round(((afterCall.spentTodayUsd ?? 0) - baseline.spentTodayUsd) * 10000) / 10000;
    row.callCostUsd = Math.round((row.actualsAfterCallUsd - row.actualsBeforeCallUsd) * 10000) / 10000;
    results.rows.push(row);
    console.log(`[rung4] ${code} -> ${row.status ?? "ERR"} settledBy=${row.settledBy ?? "?"} | ${(row.productName || row.gptSkipReason || row.error || "(empty)").slice(0, 60)} | call $${row.callCostUsd} | run $${row.actualsAfterCallUsd}`);
  }

  const final = await gptActuals();
  const totalActualUsd = Math.round(((final.spentTodayUsd ?? 0) - baseline.spentTodayUsd) * 10000) / 10000;
  results.summary = {
    codesRequested: CODES.length,
    attempted,
    skippedByBudget,
    answered,
    honestEmpty,
    junkCandidates,
    junkGate: JUNK_GATE,
    junkGateNote: "junk vs honest-empty vs correct requires adjudication vs corpus truth (rows carry productName/category/status); auto-count of clear junk left to the grading pass",
    totalActualUsd,
    walletLine: `computed floor $${totalActualUsd} (route-recorded actuals); true spend = OpenAI console`,
  };
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT.pathname}`);
  console.log(`attempted ${attempted}/${CODES.length} (${skippedByBudget} skipped by budget); answered ${answered}, honest-empty ${honestEmpty}`);
  console.log(results.summary.walletLine);

  const section = `\n## Rung 4 (GPT-5.5 v3 prompt, HARD SET ONLY) -- LIVE (phase 2)\n\n- Budget resolution (controller decision): check-before-spend with ACTUALS -- before each call, route-recorded actuals this run + $${WORST_CASE_PER_CALL} worst case must stay <= $${PHASE_CAP} (phase GPT cap). The route also enforces its own identical server-side daily guard (GPT_LADDER_DAILY_USD default $3).\n- Attempted: ${attempted}/${CODES.length} codes (${skippedByBudget} skipped by budget).\n- Rung isolation (real route): OPENAI real; GO_UPC + all FIRECRAWL keys + BRAVE blanked, so goupc skips and Fetch V2 runs free doors only before the GPT rung under test.\n- Outcomes: ${answered} answered, ${honestEmpty} honest-empty (allowed). Junk-guess gate (<= ${JUNK_GATE}): requires adjudication vs corpus truth -- per-row productName/category/status recorded for the grading pass.\n- Wallet: ${results.summary.walletLine}.\n- Raw: \`scripts/proof-rung-4-results.json\`.\n`;
  appendFileSync(REPORT, section);
  console.log(`appended Rung 4 (live) section to ${REPORT.pathname}`);
  if (child) { console.log("shutting down dev server..."); killServerTree(child); await new Promise((r) => setTimeout(r, 1000)); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
