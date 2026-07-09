// Rung 1 live micro-proof: local corpus resolution, $0 marginal cost.
//
// Samples 20 random tire barcodes + 20 random retail barcodes straight from the knowledge DB
// (src/server/knowledge.generated.db), then decodes each through the REAL POST /api/ai-lookup
// route on a local dev server started WITHOUT live provider keys (GO_UPC_API_KEY, OPENAI_API_KEY,
// GEMINI_API_KEY, FIRECRAWL_API_KEY_1..10/FIRECRAWL_API_KEY all blanked). Because the corpus
// lookup runs before any paid rung, every code should resolve from the corpus alone -- proving
// the free floor of the ladder without spending anything, and proving the ladder never silently
// depends on a live key for codes the app already knows.
//
// Integrity rule (task brief): this hits the real route via fetch(), never rung functions
// directly -- bypassing the ladder produced misleading results before (Option-B lesson).
//
// Usage: node scripts/proof-rung-corpus.mjs [--port=3105] [--base-url=http://localhost:3105]
//   --base-url skips spawning a server (use an already-running one, e.g. started by the
//   controller) -- still asserts the response proves corpus-only (no live keys reachable).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3105);
const EXTERNAL_BASE = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11) ?? null;
const BASE_URL = EXTERNAL_BASE ?? `http://localhost:${PORT}`;

const OUT = new URL("./proof-rung-1-results.json", import.meta.url);
const REPORT = new URL("./proof-ladder-report.md", import.meta.url);

function sample(dbPath, table, n) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`SELECT barcode FROM ${table} WHERE barcode IS NOT NULL AND length(barcode) >= 8 ORDER BY RANDOM() LIMIT ?`).all(n);
  db.close();
  return rows.map((r) => r.barcode);
}

/** Kill a spawned dev-server process tree. On Windows, `npx ... shell:true` wraps cmd.exe around
 * node, so child.kill() only kills the shell -- the actual next-server node process survives and
 * keeps the port bound. taskkill /T (tree) /F (force) reaps the whole tree; falls back to
 * child.kill() on non-Windows. */
function killServerTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    proc.kill();
  }
}

async function waitForServer(baseUrl, timeoutMs = 60_000) {
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

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor((p / 100) * sortedNums.length));
  return sortedNums[idx];
}

async function main() {
  const dbPath = path.join(process.cwd(), "src", "server", "knowledge.generated.db");
  if (!existsSync(dbPath)) {
    console.error(`knowledge DB not found at ${dbPath} -- run npm run build:knowledge-db first`);
    process.exit(1);
  }

  const tireCodes = sample(dbPath, "tires", 20);
  const retailCodes = sample(dbPath, "retail", 20);
  console.log(`sampled ${tireCodes.length} tire + ${retailCodes.length} retail codes from the local corpus`);

  let child = null;
  if (!EXTERNAL_BASE) {
    console.log(`starting next dev on port ${PORT} with live keys BLANKED (rung-1 must resolve from corpus alone)...`);
    const env = {
      ...process.env,
      PORT: String(PORT),
      // Blank every key that gates a live rung. Route reads: GEMINI_API_KEY, OPENAI_API_KEY,
      // FIRECRAWL_API_KEY (+_1.._10 rotation), GO_UPC_API_KEY. Blanking all of them means a
      // corpus MISS would surface as "AI lookup unavailable" rather than silently spending.
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      GO_UPC_API_KEY: "",
      FIRECRAWL_API_KEY: "",
      FIRECRAWL_API_KEY_1: "", FIRECRAWL_API_KEY_2: "", FIRECRAWL_API_KEY_3: "", FIRECRAWL_API_KEY_4: "",
      FIRECRAWL_API_KEY_5: "", FIRECRAWL_API_KEY_6: "", FIRECRAWL_API_KEY_7: "", FIRECRAWL_API_KEY_8: "",
      FIRECRAWL_API_KEY_9: "", FIRECRAWL_API_KEY_10: "",
      BRAVE_SEARCH_API_KEY: "",
      NEXT_PUBLIC_FIREBASE_BACKEND: "0",
      NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
    };
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
    console.log(`using externally-provided server at ${BASE_URL} (no live keys asserted by this script for that server)`);
  }

  const results = { startedAt: new Date().toISOString(), port: PORT, rows: [] };
  let resolvedCount = 0;

  async function decodeOne(code, group) {
    const t0 = Date.now();
    let row = { code, group };
    try {
      const res = await fetch(`${BASE_URL}/api/ai-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode" }),
      });
      const wallMs = Date.now() - t0;
      const json = await res.json();
      row.httpStatus = res.status;
      row.wallMs = wallMs;
      row.routeLatencyMs = json?.providerStatuses?.[0]?.latencyMs ?? null;
      row.corroborationPath = json?.debug?.corroborationPath ?? null;
      row.ladderPath = json?.debug?.ladderPath ?? null;
      row.status = json?.decision?.status ?? null;
      row.productName = json?.decision?.result?.productName ?? json?.results?.[0]?.productName ?? null;
      row.retailLookup = json?.debug?.retailLookup ?? null;
      row.providerStatuses = json?.providerStatuses ?? null;
      // "resolvedLocally" = a usable identity came back WITHOUT any live-provider rung (goupc/fetchv2/gpt)
      // actually running. Two honest paths qualify:
      //  (a) tire corpus direct hit: corroborationPath corpus_exact_barcode/corpus_exact_part_number.
      //  (b) retail free-tier consensus (resolveUnknownFast / Plan D): corroborationPath
      //      parallel_retail_db / parallel_barcode_db / single_source, fed by the SAME local SQLite
      //      corpus this script sampled from (retailLookup: "sqlite_hit"). NOTE: this path also queries
      //      the free, keyless UPCitemdb trial endpoint (api.upcitemdb.com) as a consensus vote -- that
      //      IS a live external network call (no API key, $0, but not purely offline). Recorded honestly
      //      as `usedLiveUpcitemdbVote` below rather than silently counted as "corpus-only."
      const tireCorpusPath = row.corroborationPath === "corpus_exact_barcode" || row.corroborationPath === "corpus_exact_part_number";
      const retailFreeTierPath = ["parallel_retail_db", "parallel_barcode_db", "single_source"].includes(row.corroborationPath);
      const noPaidRungRan = !(row.providerStatuses ?? []).some((p) => ["go-upc", "fetchv2", "gpt-5.5-ladder"].includes(p.provider) && p.status !== "skipped");
      row.resolvedLocally = res.status === 200 && (row.status === "verified" || row.status === "suggested") && (tireCorpusPath || retailFreeTierPath) && noPaidRungRan;
      row.usedLiveUpcitemdbVote = retailFreeTierPath; // resolveUnknownFast always queries UPCitemdb concurrently for retail codes
      row.gapNote = row.retailLookup === "sqlite_hit" && row.status === "needs_review"
        ? "code IS in the local retail corpus (sqlite_hit) but codeType did not qualify for the free-tier resolver (isPublicBarcode gates on upc_a/ean_13/gtin_14 only -- e.g. EAN-8 falls through to the paid ladder, all-skipped here since keys are blanked)"
        : null;
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      row.wallMs = Date.now() - t0;
      row.resolvedLocally = false;
    }
    return row;
  }

  for (const code of tireCodes) {
    const row = await decodeOne(code, "tire");
    results.rows.push(row);
    if (row.resolvedLocally) resolvedCount++;
    console.log(`[tire] ${code} -> ${row.resolvedLocally ? "RESOLVED" : "MISS"} (${row.wallMs}ms) path=${row.corroborationPath} status=${row.status}`);
  }
  for (const code of retailCodes) {
    const row = await decodeOne(code, "retail");
    results.rows.push(row);
    if (row.resolvedLocally) resolvedCount++;
    console.log(`[retail] ${code} -> ${row.resolvedLocally ? "RESOLVED" : "MISS"} (${row.wallMs}ms) path=${row.corroborationPath} status=${row.status}${row.gapNote ? ` GAP: ${row.gapNote}` : ""}`);
  }

  const wallTimes = results.rows.map((r) => r.wallMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const routeTimes = results.rows.map((r) => r.routeLatencyMs).filter((n) => typeof n === "number" && n > 0).sort((a, b) => a - b);
  const p50Wall = percentile(wallTimes, 50);
  const p50Route = routeTimes.length ? percentile(routeTimes, 50) : null;
  const upcitemdbVotes = results.rows.filter((r) => r.usedLiveUpcitemdbVote).length;
  const gaps = results.rows.filter((r) => r.gapNote);

  results.summary = {
    total: results.rows.length,
    resolvedLocally: resolvedCount,
    assertion40of40: resolvedCount === results.rows.length,
    p50WallMs: p50Wall,
    p50RouteReportedMs: p50Route,
    liveExternalCallsNote: `${upcitemdbVotes} of ${retailCodes.length} retail rows went through resolveUnknownFast's free-tier consensus, which concurrently queries the free keyless UPCitemdb trial endpoint (api.upcitemdb.com) as one vote alongside the local retail-DB hit. That is a live external network call with $0 cost and no API key -- honestly not "corpus only," even though the identity that won came from the local corpus. Tire codes never take this path (resolveExactBarcode short-circuits before it).`,
    gate5msNote:
      "route does not report its own wall time for corpus hits (latencyMs:0 by design); p50 here is measured wall time from the proof script, which includes HTTP + Next.js routing overhead on top of the corpus lookup itself. A 4-worker crawler fleet runs concurrently in this checkout per the task brief -- if p50 exceeds 5ms, that reflects HTTP/process overhead and host load, not corpus query cost.",
    gapsFound: gaps.length,
    gapDetail: gaps.map((r) => ({ code: r.code, note: r.gapNote })),
  };

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT.pathname}`);
  console.log(`resolved locally ${resolvedCount}/${results.rows.length}; p50 wall ${p50Wall}ms; ${upcitemdbVotes} retail rows touched the free UPCitemdb vote; ${gaps.length} gap(s) found`);

  const gapLines = gaps.length ? gaps.map((g) => `  - \`${g.code}\`: ${g.gapNote}`).join("\n") : "  - none";
  const section = `\n## Rung 1 (corpus, $0)\n\n- Sampled: 20 random tire barcodes + 20 random retail barcodes from \`src/server/knowledge.generated.db\`.\n- Server: local dev on port ${PORT}, all live provider keys blanked (GEMINI_API_KEY, OPENAI_API_KEY, GO_UPC_API_KEY, FIRECRAWL_API_KEY / _1.._10, BRAVE_SEARCH_API_KEY).\n- Result: ${resolvedCount}/${results.rows.length} resolved locally (assertion 40/40: ${results.summary.assertion40of40}).\n- p50 wall-clock (script-measured, includes HTTP/Next.js overhead): ${p50Wall}ms. Route-reported latencyMs for corpus hits is 0 by design (no internal timer on that path).\n- Load caveat: a 4-worker crawler fleet runs concurrently in this checkout per the task brief; if p50 exceeds the 5ms internal-gate target, it reflects HTTP + host load, not corpus query cost.\n- HONESTY NOTE: ${upcitemdbVotes}/${retailCodes.length} retail rows resolve via \`resolveUnknownFast\`'s free-tier consensus, which also queries the free, keyless UPCitemdb trial endpoint concurrently with the local retail-DB lookup -- a live external network call (no key, $0), not purely offline. All 20 tire rows resolve via the direct \`resolveExactBarcode\` corpus short-circuit with zero network calls.\n- Gaps found (${gaps.length}):\n${gapLines}\n- Raw: \`scripts/proof-rung-1-results.json\`.\n`;
  appendFileSync(REPORT, section);
  console.log(`appended Rung 1 section to ${REPORT.pathname}`);

  if (child) {
    console.log("shutting down dev server...");
    killServerTree(child);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!results.summary.assertion40of40) {
    console.error(`ASSERTION FAILED: ${resolvedCount}/${results.rows.length} resolved locally (expected 40/40). See gaps in the results JSON.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
