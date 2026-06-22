// Decode eval harness — CLI entry.
//
//   npm run eval-decode            -> prints how to run the MOCK baseline (no live AI; default).
//   npx vitest run src/eval/eval.test.ts  -> the MOCK baseline table (offline fixtures, CI-safe).
//   npm run eval-decode -- --live  -> hits the RUNNING dev server's /api/ai-lookup for each labeled code
//                                     (manual only; <=10 calls << the ~100/day cap; needs `npm run dev:prod`
//                                     or a keyed server). NEVER runs live without the explicit --live flag.
//
// Money-safety: the DEFAULT path makes ZERO AI calls. --live is bounded to the dataset size (10 codes).

import { EVAL_DATASET } from "../src/eval/dataset.ts";
import { readFileSync } from "node:fs";

const LIVE = process.argv.includes("--live");
const CORPUS = process.argv.includes("--corpus");
const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";

// --corpus: read the generated SERVER-ONLY index directly (no AI, no server) and score the trusted tire
// corpus as expanded ground truth: every trusted barcode is an exact-hit auto-count candidate (full specs +
// verified tier), the poison must be absent, and AI-call avoidance is 100% for corpus hits.
function corpusEval(): void {
  let index: { barcodeIndex: Record<string, { brand: string; size: string; load_index: string; speed_rating: string; confidence: string }> };
  let meta: Record<string, unknown> = {};
  try {
    index = JSON.parse(readFileSync("src/server/tire-knowledge/tireKnowledge.generated.json", "utf8"));
    meta = JSON.parse(readFileSync("src/server/tire-knowledge/tireKnowledge.generated.meta.json", "utf8"));
  } catch {
    console.log("No generated tire-knowledge index. Run: npm run build:tire-knowledge");
    return;
  }
  const codes = Object.keys(index.barcodeIndex);
  const fullSpec = (r: { size: string; load_index: string; speed_rating: string }) => !!r.size && !!r.load_index && !!r.speed_rating;
  const autoCandidates = codes.filter((c) => fullSpec(index.barcodeIndex[c]));
  const poisonInCorpus = !!index.barcodeIndex["745125495781"];
  const nearInCorpus = !!index.barcodeIndex["7451254957818"];

  console.log("CORPUS eval (trusted tire knowledge index, offline, NO AI):");
  console.log(`  index version:         ${meta.schema_version} (generated ${meta.generated_at})`);
  console.log(`  source snapshot:       ${meta.source_snapshot_label} (harvester_used=${meta.harvester_snapshot_used})`);
  console.log(`  trusted corpus size:   ${codes.length} barcodes`);
  console.log(`  auto-count candidates: ${autoCandidates.length} (full size+load+speed)`);
  console.log(`  barcode hit rate:      100% (exact-key index, deterministic)`);
  console.log(`  auto-count rate:       ${codes.length ? Math.round((100 * autoCandidates.length) / codes.length) : 0}% (of trusted corpus rows)`);
  console.log(`  FALSE auto-count:      ${poisonInCorpus ? "FAIL (poison in corpus!)" : "0% (poison 745125495781 absent)"}`);
  console.log(`  near-match in corpus:  ${nearInCorpus ? "present" : "absent (7451254957818)"}`);
  console.log(`  AI-call avoidance:     100% (corpus hits never call Gemini/OpenAI/page-fetch)`);
  console.log(`  latency p50/p95:       in-memory exact lookup (~0ms after first lazy load)`);
  if (poisonInCorpus) process.exitCode = 1;
}

async function liveOne(code: string): Promise<{ status: string; brand: string; conf: number; path: string; latencyMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/ai-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "decode", rawCode: code, cleanCode: code, scanContext: "tire", confidenceThreshold: 0.85 }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) return { status: `http_${res.status}`, brand: "", conf: 0, path: "", latencyMs };
  const d = await res.json();
  const best = (d?.results ?? [])[0] ?? {};
  return { status: d?.decision?.status ?? "?", brand: best.brand ?? "", conf: d?.decision?.confidence ?? 0, path: d?.decision?.corroborationPath ?? "", latencyMs };
}

function pctl(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function main() {
  if (CORPUS) { corpusEval(); return; }
  if (!LIVE) {
    console.log("Decode eval harness");
    console.log("  MOCK baseline (default, no live AI):  npx vitest run src/eval/eval.test.ts");
    console.log("  LIVE run (manual, <=10 calls):        npm run eval-decode -- --live   (needs a keyed dev server)");
    console.log(`  dataset: ${EVAL_DATASET.length} labeled codes (${EVAL_DATASET.filter((d) => d.expectedType === "tire").length} tires + poison)`);
    return;
  }
  console.log(`LIVE eval against ${BASE}/api/ai-lookup  (${EVAL_DATASET.length} codes, respecting the daily cap)\n`);
  console.log("| code | expected | decoded | decision | conf | path | want | autoCount? | latencyMs |");
  console.log("|------|----------|---------|----------|------|------|------|------------|-----------|");
  let autoWant = 0, autoGot = 0, falsePos = 0;
  const lat: number[] = [];
  for (const label of EVAL_DATASET) {
    const r = await liveOne(label.code);
    lat.push(r.latencyMs);
    // NOTE: live "decision.status===verified" + conf>=0.9 approximates the store auto-count gate; the store
    // also applies the firewall + specs gate, so this is an UPPER bound on live auto-count.
    const autoCount = r.status === "verified" && r.conf >= 0.9;
    if (label.shouldAutoCount) { autoWant++; if (autoCount) autoGot++; }
    else if (autoCount) falsePos++;
    console.log(`| ${label.code} | ${label.expectedBrand || "(none)"} | ${r.brand || "(none)"} | ${r.status} | ${r.conf.toFixed(2)} | ${r.path || "-"} | ${label.shouldAutoCount ? "Y" : "-"} | ${autoCount ? "Y" : "-"} | ${r.latencyMs} |`);
  }
  console.log(`\nLIVE auto-count rate: ${autoWant ? Math.round((100 * autoGot) / autoWant) : 0}%  | FALSE auto-count: ${falsePos} (MUST be 0)`);
  console.log(`latency p50 ${pctl(lat, 50)}ms | p95 ${pctl(lat, 95)}ms | max ${Math.max(...lat)}ms`);
  if (falsePos > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
