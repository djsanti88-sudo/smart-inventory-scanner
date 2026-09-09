// Live tire decode monitor. This can spend money and therefore requires --allow-paid.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { classifyPath, gptDecodeCallsForResponse, webSearchCallsForResponse } from "../src/shared/benchmark/benchmarkAnalysis.ts";

const value = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] || fallback;
const BASE = value("base", process.env.SMOKE_BASE_URL || "http://localhost:3000");
const COUNT = Number(value("count", "15"));
const DATE = value("date", new Date().toISOString().slice(0, 10));
const POOL = "benchmarks/tire_pool.csv";
const STATE = "benchmarks/tire-rotation-state.json";
const OUT_DIR = `reports/product-intel/${DATE}`;

function parsePool(text) {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(",").map((part) => part.trim());
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, (line.split(",")[index] || "").trim()]))).filter((row) => row.code);
}

async function decode(code) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/ai-lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "decode", rawCode: code, cleanCode: code, codeType: "upc_a", confidenceThreshold: 0.85 }) });
  return { data: await response.json(), latencyMs: Date.now() - started };
}

const percentile = (values, percentage) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((percentage / 100) * values.length) - 1)] : 0;

async function main() {
  if (!process.argv.includes("--allow-paid")) throw new Error("Refusing a potentially paid monitor. Re-run with --allow-paid after confirming the budget.");
  const status = await (await fetch(`${BASE}/api/ai-lookup`)).json();
  if (!status.openaiConfigured || status.e2e) throw new Error("A non-E2E server with OPENAI_API_KEY is required.");
  const pool = parsePool(readFileSync(POOL, "utf8"));
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { cursor: 0, runs: 0 };
  const selected = Array.from({ length: Math.min(COUNT, pool.length) }, (_, index) => pool[(state.cursor + index) % pool.length]);
  const perCode = [];
  for (const row of selected) {
    const { data, latencyMs } = await decode(row.code);
    perCode.push({ code: row.code, expectedBrand: row.brand || "", productName: data.results?.[0]?.productName || "", path: classifyPath(data), decision: data.decision?.status || "", latencyMs, gptDecodeCalls: gptDecodeCallsForResponse(data), webSearchCallsReserved: webSearchCallsForResponse(data) });
  }
  const resolved = perCode.filter((row) => !["needs_review", "failed"].includes(row.path));
  const health = {
    date: DATE,
    base: BASE,
    freshTireCodes: perCode.length,
    decodeSuccessPct: perCode.length ? Math.round((resolved.length / perCode.length) * 100) : 0,
    needsReviewPct: perCode.length ? Math.round((perCode.filter((row) => row.path === "needs_review").length / perCode.length) * 100) : 0,
    latencyMs: { p50: percentile(perCode.map((row) => row.latencyMs), 50), p95: percentile(perCode.map((row) => row.latencyMs), 95), max: Math.max(0, ...perCode.map((row) => row.latencyMs)) },
    cost: { gptDecodeCalls: perCode.reduce((sum, row) => sum + row.gptDecodeCalls, 0), webSearchCallsReserved: perCode.reduce((sum, row) => sum + row.webSearchCallsReserved, 0), note: "True spend requires provider-console reconciliation." },
    perCode,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/scan-health.json`, JSON.stringify(health, null, 2));
  writeFileSync(STATE, JSON.stringify({ cursor: (state.cursor + selected.length) % pool.length, runs: (state.runs || 0) + 1 }, null, 2));
  console.log(JSON.stringify(health, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
