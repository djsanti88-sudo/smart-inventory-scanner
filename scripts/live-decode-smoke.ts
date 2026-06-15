// Live decode smoke test. Hits the running dev server's /api/ai-lookup so it exercises the REAL
// Gemini grounding + OpenAI web-search integration with the server's env keys.
//
// Safety: it only POSTs (spends tokens) when LIVE_AI_TEST=1. Otherwise it just prints the no-token
// GET status. Run:  npm run dev   (in one terminal), then in another:
//   LIVE_AI_TEST=1 npm run live-decode-smoke
//
// Plain JS (in a .ts file) so `node scripts/live-decode-smoke.ts` runs on Node 24 with no toolchain.

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CODES = ["070330645936", "6977228152610", "710154236681"];
const LIVE = process.env.LIVE_AI_TEST === "1";

function codeType(c) {
  if (/^\d{12}$/.test(c)) return "upc_a";
  if (/^\d{13}$/.test(c)) return "ean_13";
  if (/^\d{14}$/.test(c)) return "gtin_14";
  if (/^(X0|B0)[0-9A-Z]{8}$/i.test(c)) return "vendor_label";
  return /^\d+$/.test(c) ? "numeric_sku" : "alpha_sku";
}

async function main() {
  console.log("=== Live decode smoke test ===");
  console.log("base:", BASE, "| LIVE_AI_TEST:", LIVE ? "1 (will spend tokens)" : "(unset - no live calls)");

  let status;
  try {
    status = await (await fetch(BASE + "/api/ai-lookup")).json();
  } catch (e) {
    console.error("Cannot reach the dev server at", BASE, "- start it with `npm run dev`.", String(e));
    process.exit(1);
  }
  console.log("\n--- AI status (no tokens) ---");
  console.log(JSON.stringify(status, null, 2));

  if (!LIVE) {
    console.log("\nLIVE_AI_TEST not set to 1 -> NOT calling live providers. No tokens spent.");
    console.log("To run for real: set keys in .env.local, restart the dev server, then:");
    console.log("  LIVE_AI_TEST=1 npm run live-decode-smoke");
    return;
  }
  if (status.e2e) {
    console.log("\nServer is in IS_E2E mock-only mode. Unset IS_E2E and restart to do a live test.");
    return;
  }
  if (!status.geminiConfigured && !status.openaiConfigured) {
    console.log("\nNo provider keys configured server-side. Add GEMINI_API_KEY / OPENAI_API_KEY to .env.local and restart.");
    return;
  }

  for (const code of CODES) {
    console.log("\n==================== " + code + " ====================");
    const ct = codeType(code);
    let data;
    try {
      const r = await fetch(BASE + "/api/ai-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "decode",
          rawCode: code,
          cleanCode: code,
          codeType: ct,
          confidenceThreshold: 0.85,
          allowImageSuggestions: true,
        }),
      });
      data = await r.json();
    } catch (e) {
      console.error("decode request failed:", String(e));
      continue;
    }

    const results = data.results || [];
    const names = data.providerNames || [];
    const evs = data.evidences || [];
    const dec = data.decision || {};
    const gem = results[names.findIndex((n) => String(n).startsWith("gemini"))] || null;
    const oai = results[names.findIndex((n) => String(n).startsWith("openai"))] || null;
    const best = results[0] || {};

    console.log("1.  raw code:", code);
    console.log("2.  code type:", ct);
    console.log("3.  gemini enabled:", status.geminiEnabled, "| configured:", status.geminiConfigured, "| grounding:", status.geminiSearchGrounding);
    console.log("4.  openai enabled:", status.openaiEnabled, "| configured:", status.openaiConfigured, "| web search:", status.openaiWebSearch);
    console.log("5.  gemini called:", !!gem);
    console.log("6.  openai called:", !!oai);
    console.log("7.  gemini productName:", gem ? gem.productName : "(not called/failed)");
    console.log("8.  openai productName:", oai ? oai.productName : "(not called/failed)");
    console.log("9.  sourceUrls:", JSON.stringify((best.sourceUrls || []).slice(0, 8)));
    console.log("10. sourceSnippets/grounding:", JSON.stringify([...(best.sourceSnippets || []), ...(best.groundingChunks || [])].slice(0, 5)));
    console.log("11. exactCodeEvidenceVerifiedByApp:", dec.exactCodeEvidenceVerifiedByApp);
    console.log("12. final decision:", dec.status);
    console.log("13. reason:", dec.reason);
    console.log("14. shows product in Live Scan Feed (verified):", dec.status === "verified");
    console.log("15. goes to Needs Review:", dec.status !== "verified");
    console.log("    evidence strengths:", JSON.stringify(evs.map((e) => e.strength)));
    const dbg = data.debug || {};
    console.log("    >> LATENCY:", dbg.latencyMs, "ms | timedOut:", data.timedOut, "| budget:", dbg.budgetMs, "ms | models:", JSON.stringify(dbg.baseModels));
    console.log("    productName:", JSON.stringify(best.productName || ""), "(must be a real product, never a website/search title)");
  }
}

main();
