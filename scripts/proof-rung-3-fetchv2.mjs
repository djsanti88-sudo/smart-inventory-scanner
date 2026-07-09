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

  // ---- LIVE PATH (owner-gated; not executed in this dispatch) ----
  const envLocal = loadEnvLocal();
  if (!envLocal.FIRECRAWL_API_KEY_1 && !envLocal.FIRECRAWL_API_KEY) {
    console.error("no Firecrawl key configured -- cannot run --live");
    process.exit(1);
  }
  let child = null;
  if (!EXTERNAL_BASE) {
    const env = { ...process.env, ...envLocal, PORT: String(PORT), NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1" };
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
    const up = await waitForServer(BASE_URL, 90_000);
    if (!up) { console.error("dev server did not come up"); killServerTree(child); process.exit(1); }
  }

  const results = { startedAt: new Date().toISOString(), sample, rows: [] };
  let resolvedNow = 0, wrong = 0;
  for (const code of sample) {
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/api/ai-lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode" }) });
    const json = await res.json();
    const truth = truthByCode.get(code);
    const row = { code, wallMs: Date.now() - t0, status: json?.decision?.status, productName: json?.decision?.result?.productName ?? json?.results?.[0]?.productName, priorTruth: truth?.truth, priorOutcome: truth?.outcome };
    if (row.status === "verified" || row.status === "suggested") resolvedNow++;
    results.rows.push(row);
    console.log(`[fetchv2] ${code} -> ${row.status} | ${row.productName ?? ""}`);
  }
  results.summary = { sampleSize: sample.length, resolvedNow, rateNow: resolvedNow / sample.length, baselineRate: BASELINE_RATE, beatsBaseline: resolvedNow / sample.length > BASELINE_RATE, wrong };
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  const section = `\n## Rung 3 (Fetch V2, HARD SET ONLY) -- LIVE\n\n- Sample: ${sample.length} codes from the 61-code still-unresolved pool.\n- Resolved: ${resolvedNow}/${sample.length} (${(results.summary.rateNow * 100).toFixed(1)}%) vs baseline ${(BASELINE_RATE * 100).toFixed(1)}%. Beats baseline: ${results.summary.beatsBaseline}.\n- Raw: \`scripts/proof-rung-3-results.json\`.\n`;
  appendFileSync(REPORT, section);
  if (child) killServerTree(child);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
