// Isolated rung test (owner-approved 2026-07-20, own $6 hard cap, bypasses the ladder clock):
// for each code, run Fetch V2 alone with its FULL budget, then gptFromScratch alone (35s).
// Usage: npx tsx scripts/stress/rung-isolated-test.mts [--skip-gpt] [--skip-fetch]
// Reads keys from .env.local. Live PAID calls: Firecrawl credits + GPT (worst case $0.39/call,
// hard stop when cumulative worst-case reserve would exceed $6.00).
import fs from "node:fs";
import path from "node:path";

// Minimal .env.local loader (no dotenv dep).
for (const line of fs.readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { fetchV2 } = await import("../../src/services/fetchV2/index.js");
const { FetchV2Cache } = await import("../../src/services/fetchV2/cache.js");
const { braveProvider, firecrawlSearchProvider } = await import("../../src/services/fetchV2/sources/discovery.js");
const { brocadeLookup } = await import("../../src/services/fetchV2/sources/brocade.js");
const { selectBarcodeUrls } = await import("../../src/services/ai/barcodeSources.js");
const { gptFromScratch, GPT_LADDER_WORST_CASE_USD } = await import("../../src/services/ai/gptFromScratch.js");
const { firecrawlKeysFromEnv } = await import("../../src/services/ai/firecrawlProvider.js");

const CAP_USD = 6.0;
const codes: string[] = JSON.parse(fs.readFileSync(".superpowers/stress/rung-test-codes.json", "utf8"));
const skipGpt = process.argv.includes("--skip-gpt");
const skipFetch = process.argv.includes("--skip-fetch");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
async function fetchPage(url: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: controller.signal, redirect: "follow" });
    return { ok: res.ok, status: res.status, html: res.ok ? await res.text() : "" };
  } catch {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(t);
  }
}

function discovery() {
  const provs: unknown[] = [];
  if (process.env.BRAVE_SEARCH_API_KEY) provs.push(braveProvider({ apiKey: process.env.BRAVE_SEARCH_API_KEY, fetchImpl: fetch as never }));
  const fc = firecrawlKeysFromEnv();
  if (fc.length) provs.push(firecrawlSearchProvider({ apiKeys: fc, fetchImpl: fetch as never }));
  return provs as never[];
}

const cache = new FetchV2Cache();
const out: Record<string, unknown>[] = [];
let gptReserved = 0;

for (const code of codes) {
  const row: Record<string, unknown> = { code };
  if (!skipFetch) {
    const t0 = Date.now();
    try {
      const fv2 = await fetchV2(code, {
        fetchPage,
        discovery: discovery(),
        structured: [{ name: "brocade", lookup: (v: string[]) => brocadeLookup(v) }],
        cache,
        patternUrls: selectBarcodeUrls ? (v: string[]) => { const c = v.find((x) => /^\d{12,14}$/.test(x)) ?? v[0]; return selectBarcodeUrls(c).slice(0, 4); } : undefined,
      }, { mode: "balanced", maxSourcesPerCode: 4, maxTotalMs: 25000 });
      row.fetch = {
        outcome: fv2.outcome,
        brand: fv2.product?.brand ?? "",
        name: fv2.product?.name ?? "",
        exactCodeFound: fv2.evidence.exactCodeFound,
        confidence: fv2.evidence.finalConfidence,
        winner: fv2.evidence.winningSourceUrl,
        sources: fv2.sourcesChecked.length,
        ms: Date.now() - t0,
        earlyStopped: fv2.performance.earlyStopped,
      };
    } catch (e) {
      row.fetch = { outcome: "error", error: String(e).slice(0, 120), ms: Date.now() - t0 };
    }
  }
  if (!skipGpt) {
    if (gptReserved + GPT_LADDER_WORST_CASE_USD > CAP_USD) {
      row.gpt = { skipped: "test $6 cap reached (worst-case reserve)" };
    } else {
      gptReserved += GPT_LADDER_WORST_CASE_USD;
      const t0 = Date.now();
      const r = await gptFromScratch(code, { apiKey: process.env.OPENAI_API_KEY! });
      row.gpt = {
        tier: r.tier, brand: r.brand, name: r.productName, category: r.category,
        exactCodeFound: r.exactCodeFound, confidence: r.confidence, searches: r.searches,
        usdActual: Number(r.usdActual.toFixed(4)), aborted: r.aborted, error: r.error ?? "",
        basis: (r.basis ?? "").slice(0, 140), ms: Date.now() - t0,
      };
    }
  }
  out.push(row);
  console.log(JSON.stringify(row));
}

const sum = {
  codes: codes.length,
  fetchAnswered: out.filter((r) => (r.fetch as { name?: string } | undefined)?.name).length,
  fetchVerified: out.filter((r) => (r.fetch as { outcome?: string } | undefined)?.outcome === "verified").length,
  gptAnswered: out.filter((r) => (r.gpt as { name?: string } | undefined)?.name).length,
  gptExactClaims: out.filter((r) => (r.gpt as { exactCodeFound?: boolean } | undefined)?.exactCodeFound).length,
  gptUsdActualTotal: Number(out.reduce((a, r) => a + ((r.gpt as { usdActual?: number } | undefined)?.usdActual ?? 0), 0).toFixed(4)),
  gptWorstCaseReserved: Number(gptReserved.toFixed(2)),
};
console.log("SUMMARY", JSON.stringify(sum));
fs.writeFileSync(".superpowers/stress/results/rung-isolated-test.json", JSON.stringify({ rows: out, summary: sum }, null, 1));
