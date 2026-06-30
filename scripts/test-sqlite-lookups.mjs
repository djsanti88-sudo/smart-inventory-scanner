#!/usr/bin/env node
// test-sqlite-lookups.mjs — Benchmark the SQLite knowledge DB through the real API route.
// Sends POST /api/ai-lookup (mode=decode) for known tire barcodes, known retail barcodes,
// and unknown codes. Measures response time and reports which path resolved each code.
//
// Usage:  node scripts/test-sqlite-lookups.mjs
// Requires: dev server running on localhost:3000 (use IS_E2E=1 to avoid real AI calls)

const BASE = process.env.TEST_BASE || "http://localhost:3000";

// Known tire barcodes (from the 76K tire corpus)
const TIRE_CODES = [
  { code: "029142869870", expect: "cooper" },     // Cooper Discoverer SRX
  { code: "848983006165", expect: "falken" },      // Falken
  { code: "848983006257", expect: "falken" },      // Falken Wildpeak
];

// Known retail barcodes (from the 4M Open Food Facts index)
const RETAIL_CODES = [
  { code: "10000991", expect: "Tesco Cherries" },
  { code: "10000021", expect: "REDUCED FAT" },
  { code: "3017620422003", expect: "" },           // Nutella (check if in OFF)
  { code: "5449000000996", expect: "" },           // Coca-Cola (check if in OFF)
  { code: "7622210449283", expect: "" },           // Oreo (check if in OFF)
  { code: "4008400401621", expect: "" },           // Ferrero
  { code: "8000500310427", expect: "" },           // Ferrero Rocher
];

// Unknown codes (should NOT match either index — go to AI/Needs Review)
const UNKNOWN_CODES = [
  { code: "999999999999", expect: null },
  { code: "012345678905", expect: null },
  { code: "00029155", expect: null },              // short internal
];

async function testLookup(code, label) {
  const t0 = performance.now();
  try {
    const resp = await fetch(`${BASE}/api/ai-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: code, cleanCode: code, mode: "decode" }),
    });
    const elapsed = performance.now() - t0;
    if (!resp.ok) {
      return { code, label, elapsed, status: resp.status, error: await resp.text() };
    }
    const data = await resp.json();
    const path = data.debug?.corroborationPath || data.debug?.tireHotPath ? "tire-hot-path" : null;
    const providers = data.providerNames || [];
    const product = data.results?.[0]?.productName || "";
    const decision = data.decision?.status || "";
    const aiCalled = data.debug?.aiCalled !== false; // false only for corpus hits
    const cached = data.debug?.cached || false;

    return {
      code, label, elapsed: Math.round(elapsed),
      providers: providers.join(","),
      product: product.slice(0, 50),
      decision,
      path: path || providers[0] || "unknown",
      aiCalled,
      cached,
    };
  } catch (e) {
    return { code, label, elapsed: Math.round(performance.now() - t0), error: e.message };
  }
}

// Check if server is reachable
try {
  const health = await fetch(`${BASE}/api/ai-lookup`);
  if (!health.ok) throw new Error(`GET /api/ai-lookup returned ${health.status}`);
  const info = await health.json();
  console.log(`\n[sqlite-test] Connected to ${BASE}`);
  console.log(`[sqlite-test] E2E mode: ${info.e2e}, AI mode: ${info.mode}`);
  console.log(`[sqlite-test] Gemini configured: ${info.geminiConfigured}, OpenAI configured: ${info.openaiConfigured}\n`);
} catch (e) {
  console.error(`[sqlite-test] Cannot reach ${BASE}. Is the dev server running?`);
  console.error(`  Start with: IS_E2E=1 npm run dev`);
  process.exit(1);
}

console.log("=" .repeat(100));
console.log("  TIRE CORPUS LOOKUPS (should resolve via SQLite, NO AI call, < 50ms)");
console.log("=" .repeat(100));
for (const { code, expect } of TIRE_CODES) {
  const r = await testLookup(code, "tire");
  const ok = r.error ? "ERROR" : (r.product?.toLowerCase().includes(expect) ? "MATCH" : "MISS");
  const aiTag = r.aiCalled === false ? "NO-AI" : "AI";
  console.log(`  ${code}  ${String(r.elapsed).padStart(5)}ms  ${ok.padEnd(6)} [${aiTag}] ${r.path?.padEnd(20)} ${r.product || r.error || ""}`);
}

console.log("\n" + "=" .repeat(100));
console.log("  RETAIL CORPUS LOOKUPS (should resolve via SQLite, NO AI call, < 50ms)");
console.log("=" .repeat(100));
for (const { code, expect } of RETAIL_CODES) {
  const r = await testLookup(code, "retail");
  const ok = r.error ? "ERROR" : (r.product ? (expect && r.product.toLowerCase().includes(expect.toLowerCase()) ? "MATCH" : "HIT") : "MISS");
  const aiTag = r.aiCalled === false ? "NO-AI" : "AI";
  console.log(`  ${code}  ${String(r.elapsed).padStart(5)}ms  ${ok.padEnd(6)} [${aiTag}] ${(r.path || "").padEnd(20)} ${r.product || r.error || "(no product)"}`);
}

console.log("\n" + "=" .repeat(100));
console.log("  UNKNOWN CODES (should miss both indexes, fall through to AI/mock)");
console.log("=" .repeat(100));
for (const { code } of UNKNOWN_CODES) {
  const r = await testLookup(code, "unknown");
  const ok = r.error ? "ERROR" : (!r.product ? "CORRECT" : `GOT: ${r.product.slice(0, 30)}`);
  console.log(`  ${code.padEnd(14)}  ${String(r.elapsed).padStart(5)}ms  ${ok.padEnd(8)} [${r.path || ""}]`);
}

// Summary
console.log("\n" + "=" .repeat(100));
console.log("  PERFORMANCE SUMMARY");
console.log("=" .repeat(100));
console.log("  If tire/retail lookups show NO-AI and < 100ms, the SQLite path is working.");
console.log("  Unknown codes will be slower (they fall through to the AI/mock path).");
console.log("=" .repeat(100));
