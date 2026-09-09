// Live decode benchmark. This script can spend money; it requires an explicit opt-in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { accuracyVerdict, classifyPath, gptDecodeCallsForResponse, parseCsv, summarize, toInputRows, webSearchCallsForResponse } from "../src/shared/benchmark/benchmarkAnalysis.ts";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const FILE = process.argv.find((arg) => arg.startsWith("--file="))?.split("=")[1] || "benchmarks/phase1_100_codes.csv";
const ALLOW_PAID = process.argv.includes("--allow-paid");
const OUT_DIR = "benchmarks/results";

function codeType(code) {
  if (/^\d{12}$/.test(code)) return "upc_a";
  if (/^\d{13}$/.test(code)) return "ean_13";
  if (/^\d{14}$/.test(code)) return "gtin_14";
  return /^\d+$/.test(code) ? "numeric_sku" : "alpha_sku";
}

async function decode(code) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/ai-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "decode", rawCode: code, cleanCode: code, codeType: codeType(code), confidenceThreshold: 0.85 }),
  });
  const data = await response.json();
  return { data, wallMs: Date.now() - started };
}

async function main() {
  if (!ALLOW_PAID) throw new Error("Refusing a potentially paid benchmark. Re-run with --allow-paid after confirming the server budget and provider console.");
  const status = await (await fetch(`${BASE}/api/ai-lookup`)).json();
  if (status.e2e) throw new Error("The server is in E2E mode; use a normal local server for a live benchmark.");
  if (!status.openaiConfigured) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const inputs = toInputRows(parseCsv(readFileSync(FILE, "utf8")));
  const rows = [];
  for (const input of inputs) {
    const { data, wallMs } = await decode(input.code);
    const verdict = accuracyVerdict(data, input);
    rows.push({
      code: input.code,
      path: classifyPath(data),
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
      productName: data.results?.[0]?.productName || "",
      decision: data.decision?.status || "",
      reasonCode: data.reasonCode || "",
      latencyMs: wallMs,
      cached: !!data.debug?.cached,
      gptDecodeCalls: gptDecodeCallsForResponse(data),
      webSearchCalls: webSearchCallsForResponse(data),
    });
    console.log(`${input.code} ${rows.at(-1).path} ${wallMs}ms`);
  }
  const summary = summarize(rows);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/decode_benchmark.json`, JSON.stringify({ base: BASE, file: FILE, summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("Spend is intentionally not inferred from response metadata. Reconcile true spend in the OpenAI provider console.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
