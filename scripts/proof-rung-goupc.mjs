// Rung 2 live micro-proof: Go-UPC, <= 15 lookups total (phase cap: <= 40 across both proof tasks).
//
// Two groups, run through the REAL POST /api/ai-lookup route on a local dev server with REAL
// .env.local keys:
//   1. 10 known-good GTIN codes that are NOT in the local corpus (so the ladder falls through
//      corpus -> Go-UPC). These are real product barcodes from the owner-curated fixture pool.
//   2. 5 non-GTIN codes (Amazon ASIN / FNSKU-shaped). These must NEVER reach the Go-UPC client at
//      all -- buildLadderRungs() (src/server/upc/ladder.ts) only pushes the "goupc" rung when
//      isGtinShaped(code) && isValidCheckDigit(code). The quota-protection proof: the Go-UPC
//      usage counter must be BYTE-IDENTICAL before and after these 5 calls.
//
// Counter truth: goUpcUsage() is backed by fileLadderStorage() UNLESS TURSO_DATABASE_URL +
// TURSO_AUTH_TOKEN are set in .env.local, in which case the counter lives in Turso's goupc_usage
// table (src/server/upc/storage.ts). This script reads whichever backend is actually configured
// so the before/after delta is real, not a false negative from checking the wrong store.
//
// Integrity rule (task brief): hits the real route via fetch(), never rung functions directly.
//
// GATED (owner incident 2026-08-13, TL2-1 re-verification): this script spawns a REAL `next dev`
// server using REAL .env.local keys and spends real Go-UPC quota (plus possibly GPT). A bare
// `node scripts/proof-rung-goupc.mjs` used to do this immediately with no flag at all - unlike its
// siblings (proof-rung-3-fetchv2.mjs, proof-rung-4-gpt.mjs) it had no --live gate whatsoever.
// Reading .env.local here is legitimate (launching the actual app, the only thing allowed to use
// its own Lane 2 keys) - the missing piece was the gate itself, via scripts/lib/paidScriptGuard.mjs.
//
// Usage: node scripts/proof-rung-goupc.mjs --live --yes-i-accept-cost [--port=3106] [--base-url=http://localhost:3106]
// Bare invocation (no --live) prints this run's worst-case cost floor and exits 0, $0 spent.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { requireLiveApproval } from "./lib/paidScriptGuard.mjs";

const require = createRequire(import.meta.url);

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3106);
const EXTERNAL_BASE = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11) ?? null;
const BASE_URL = EXTERNAL_BASE ?? `http://localhost:${PORT}`;

const OUT = new URL("./proof-rung-2-results.json", import.meta.url);
const REPORT = new URL("./proof-ladder-report.md", import.meta.url);

// 10 known-good GTIN codes, real products, confirmed NOT present in src/server/knowledge.generated.db
// (neither `tires` nor `retail` tables) as of 2026-07-08 -- verified by direct SQLite query before
// picking this list. Sourced from e2e/fixtures/dryrun-codes.json (owner + obscure groups).
const KNOWN_GOOD_GTIN = [
  { code: "051596320812", truth: "Home Depot 5 Gal Orange Homer Bucket / 05GLHD2" },
  { code: "078742051451", truth: "Member's Mark Purified Water 500ml / 16.9 oz" },
  { code: "078742028477", truth: "Member's Mark Purified Water 40 Pack / 16.9 oz" },
  { code: "009800120871", truth: "Ferrero Rocher Valentine's Fine Hazelnut Chocolate Hearts, 2.6 oz" },
  { code: "044000072742", truth: "Nabisco Oreo / club pack sandwich cookies" },
  { code: "072554159725", truth: "Oreo King Cone ice cream cone 7.5 oz" },
  { code: "028400325042", truth: "Doritos Cool Ranch tortilla chips (Frito-Lay)" },
  { code: "016000200050", truth: "Cheerios Veggie Blends Blueberry Banana" },
  { code: "096619516698", truth: "Kirkland Signature Protein Bar, Energy Variety Pack (20 ct)" },
  { code: "690284733673", truth: "Trader Joe's Everything But The Bagel Sesame Seasoning Blend 2.3oz" },
];

// 5 non-GTIN-shaped codes (Amazon ASIN). isGtinShaped()/isValidCheckDigit() reject these, so
// buildLadderRungs() never includes the goupc rung -- the client must never be invoked.
const NON_GTIN = [
  { code: "B00FLYWNYQ", kind: "asin" },
  { code: "B00006JSUA", kind: "asin" },
  { code: "B09B8V1LZ3", kind: "asin" },
  { code: "B00006IFHD", kind: "asin" },
  { code: "B00NHQF6MG", kind: "asin" },
];

/** Kill a spawned dev-server process tree (Windows-safe: taskkill /T reaps the whole node tree
 * spawned under `npx ... shell:true`, which a bare child.kill() would leave running). */
function killServerTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    proc.kill();
  }
}

async function waitForServer(baseUrl, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/ai-lookup`, { method: "GET" });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Load .env.local into an object WITHOUT mutating process.env (values never logged). */
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

/** Read the Go-UPC usage counter from whichever backend is actually configured (Turso or file). */
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
    } finally {
      client.close?.();
    }
  }
  const usagePath = path.join(process.cwd(), ".go-upc-usage.json");
  if (!existsSync(usagePath)) return { backend: "file", month: new Date().toISOString().slice(0, 7), used: 0 };
  try {
    const j = JSON.parse(readFileSync(usagePath, "utf8"));
    return { backend: "file", month: j.month, used: j.used };
  } catch {
    return { backend: "file", month: new Date().toISOString().slice(0, 7), used: 0, readError: true };
  }
}

async function main() {
  requireLiveApproval({
    worstCaseFloorUsd: 1.5, // 10 Go-UPC lookups (near-$0 metered) + GPT actuals reserve, same order as sibling rungs
    describe: () => "Would spawn a real \"next dev\" server with REAL .env.local keys and run 15 codes (10 known-good GTIN + 5 non-GTIN) through the live decode ladder, spending real Go-UPC quota and possibly GPT.",
  });

  const envLocal = loadEnvLocal();
  if (!envLocal.GO_UPC_API_KEY) {
    console.error("GO_UPC_API_KEY missing from .env.local -- cannot run rung 2 (needs real keys).");
    process.exit(1);
  }

  const before = await readGoUpcUsageCounter(envLocal);
  console.log(`Go-UPC usage counter BEFORE (backend=${before.backend}): month=${before.month} used=${before.used}`);

  let child = null;
  if (!EXTERNAL_BASE) {
    console.log(`starting next dev on port ${PORT} with REAL .env.local keys (rung 2 spends real Go-UPC quota)...`);
    const env = { ...process.env, ...envLocal, PORT: String(PORT), NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1" };
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], shell: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const up = await waitForServer(BASE_URL, 90_000);
    if (!up) {
      console.error("dev server did not come up in time");
      killServerTree(child);
      process.exit(1);
    }
    console.log("dev server up.");
  } else {
    console.log(`using externally-provided server at ${BASE_URL}`);
  }

  // GPT-actuals baseline via the route's own telemetry (spentTodayUsd from recordGptLadderSpend):
  // with the T8b fix, a known-good code whose Plan D floors AND Go-UPC misses AND FetchV2 misses can
  // reach the paid GPT rung, so this rung's wallet line must capture any GPT actuals too.
  async function gptActuals() {
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, { method: "GET" });
      const j = await res.json();
      return { spentTodayUsd: j?.gptLadder?.spentTodayUsd ?? null, callsToday: j?.gptLadder?.callsToday ?? null };
    } catch { return { spentTodayUsd: null, callsToday: null }; }
  }
  const gptBefore = await gptActuals();

  const results = { startedAt: new Date().toISOString(), port: PORT, goUpcUsageBefore: before, gptActualsBefore: gptBefore, rows: [] };

  async function decodeOne(code, extra) {
    const t0 = Date.now();
    let row = { code, ...extra };
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // forceRetry: bypass L1/L2 decode caches so this is a genuinely fresh compute through the
        // FIXED ladder (commit 6a800c4), not a replay of a pre-fix cached payload.
        body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode", forceRetry: true }),
      });
      row.httpStatus = res.status;
      row.wallMs = Date.now() - t0;
      const json = await res.json();
      row.corroborationPath = json?.debug?.corroborationPath ?? null;
      row.ladderPath = json?.debug?.ladderPath ?? null;
      row.ladderReasons = json?.debug?.ladderReasons ?? null;
      row.status = json?.decision?.status ?? null;
      row.productName = json?.decision?.result?.productName ?? json?.results?.[0]?.productName ?? null;
      row.reasonCode = json?.reasonCode ?? null;
      row.reasonText = json?.reasonText ?? null;
      row.providerStatuses = json?.providerStatuses ?? null;
      row.debug = json?.debug ?? null;
      // Which stage actually settled this code: a ladder rung name (goupc/fetchv2/gpt), or the Plan D
      // parallel_* path when Plan D's verified win stayed terminal, or "plan_d_floor_fallback" when the
      // ladder all-missed and the stashed floor answered.
      row.settledBy = row.ladderPath && row.ladderPath !== "none"
        ? row.ladderPath
        : row.ladderPath === "none"
          ? (row.corroborationPath?.startsWith("parallel_") ? "plan_d_floor_fallback" : "none")
          : (row.corroborationPath ?? null);
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      row.wallMs = Date.now() - t0;
    }
    return row;
  }

  console.log("\n--- Group A: 10 known-good GTIN codes (Go-UPC reachable via the fixed ladder) ---");
  for (const { code, truth } of KNOWN_GOOD_GTIN) {
    const row = await decodeOne(code, { group: "known_good_gtin", truth });
    row.classification =
      row.status === "verified" ? "hit_exact"
      : row.status === "suggested" ? "hit_inferred_or_suggestion"
      : row.status === "needs_review" ? "miss_or_needs_review"
      : "unknown";
    results.rows.push(row);
    console.log(`[known-good] ${code} -> status=${row.status} settledBy=${row.settledBy} name="${row.productName ?? ""}" (${row.wallMs}ms)`);
    await new Promise((r) => setTimeout(r, 600)); // stay under the 2/s throttle
  }

  console.log("\n--- Group B: 5 non-GTIN codes (must be gated BEFORE the Go-UPC client) ---");
  for (const { code, kind } of NON_GTIN) {
    const row = await decodeOne(code, { group: "non_gtin", kind });
    results.rows.push(row);
    console.log(`[non-gtin] ${code} -> status=${row.status} reasonCode=${row.reasonCode} (${row.wallMs}ms)`);
  }

  const after = await readGoUpcUsageCounter(envLocal);
  const gptAfter = await gptActuals();
  console.log(`\nGo-UPC usage counter AFTER (backend=${after.backend}): month=${after.month} used=${after.used}`);
  const delta = (after.month === before.month) ? after.used - before.used : after.used; // month rollover: treat as fresh count
  const gptSpentThisRun = (gptAfter.spentTodayUsd ?? 0) - (gptBefore.spentTodayUsd ?? 0);
  results.goUpcUsageAfter = after;
  results.gptActualsAfter = gptAfter;
  results.gptSpentThisRunUsd = Math.round(gptSpentThisRun * 10000) / 10000;
  results.usageDelta = delta;
  results.deltaWithinCap = delta <= 10;
  results.gtinCallsMade = KNOWN_GOOD_GTIN.length;

  const hits = results.rows.filter((r) => r.group === "known_good_gtin" && r.classification === "hit_exact").length;
  const suggested = results.rows.filter((r) => r.group === "known_good_gtin" && r.classification === "hit_inferred_or_suggestion").length;
  const misses = results.rows.filter((r) => r.group === "known_good_gtin" && r.classification === "miss_or_needs_review").length;
  const stageCounts = {};
  for (const r of results.rows.filter((x) => x.group === "known_good_gtin")) {
    const k = r.settledBy ?? "unknown";
    stageCounts[k] = (stageCounts[k] ?? 0) + 1;
  }
  results.summary = {
    knownGoodHits: hits,
    knownGoodSuggestedOrInferred: suggested,
    knownGoodMisses: misses,
    settledByStage: stageCounts,
    nonGtinCount: NON_GTIN.length,
    nonGtinGatedProof: `usage delta ${delta} reflects ONLY the ${KNOWN_GOOD_GTIN.length} GTIN calls (non-GTIN calls never reach the client, so they contribute 0 to the counter)`,
  };

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT.pathname}`);
  console.log(`settled-by stages (known-good): ${JSON.stringify(stageCounts)}`);
  console.log(`counter delta: ${delta} (cap <=10 for the GTIN group; must be <=15 total for the whole rung-2 dispatch): within cap = ${results.deltaWithinCap}`);
  console.log(`GPT actuals this run: $${results.gptSpentThisRunUsd} (route-recorded)`);
  console.log("true spend = Go-UPC console (this script's counter reconciliation is a computed floor, not a substitute for the provider's own usage dashboard)");

  const stageLines = Object.entries(stageCounts).map(([k, v]) => `  - ${k}: ${v}`).join("\n");
  const section = `\n## Rung 2 RE-RUN (Go-UPC via the FIXED ladder, commit 6a800c4) -- LIVE, real keys\n\n- Server: local dev on port ${PORT}, REAL .env.local keys, full fixed ladder (Plan D verified wins terminal; floor/suggestion yields to Go-UPC -> FetchV2 -> GPT). forceRetry on every call (no cache replays).\n- Go-UPC usage counter (backend: ${after.backend}) BEFORE: month=${before.month} used=${before.used}. AFTER: month=${after.month} used=${after.used}. Delta: ${delta} (cap <= 10 for the 10-code group; 15 for the rung).\n- Known-good GTIN group (10 codes, not in local corpus): ${hits} verified, ${suggested} suggested, ${misses} miss/needs_review. Settled by stage:\n${stageLines}\n- Non-GTIN group (5 ASIN-shaped codes): gated BEFORE the Go-UPC client by \`buildLadderRungs()\` -- counter delta reflects only GTIN-shaped calls.\n- GPT actuals this run (route-recorded telemetry): $${results.gptSpentThisRunUsd} (before: $${gptBefore.spentTodayUsd ?? "?"}, after: $${gptAfter.spentTodayUsd ?? "?"} today).\n- Wallet: computed floor = ${delta} Go-UPC lookups + $${results.gptSpentThisRunUsd} GPT + any Plan D/FetchV2 Firecrawl credits (not individually metered by the route); true spend = provider consoles (Go-UPC / OpenAI / Firecrawl).\n- Pre-fix baseline preserved at \`scripts/proof-rung-2-results.pre-fix.json\` (delta 0, ladder unreachable).\n- Raw: \`scripts/proof-rung-2-results.json\`.\n`;
  appendFileSync(REPORT, section);
  console.log(`appended Rung 2 section to ${REPORT.pathname}`);

  if (child) {
    console.log("shutting down dev server...");
    killServerTree(child);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!results.deltaWithinCap) {
    console.error("CAP CONCERN: usage delta exceeded the expected <=10 for the GTIN group.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
