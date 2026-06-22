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

const LIVE = process.argv.includes("--live");
const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";

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
