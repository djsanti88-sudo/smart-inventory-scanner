// Route-level decode smoke. GET is free. POST can call GPT-5.4 mini and therefore requires
// LIVE_AI_TEST=1 plus a separately started non-E2E server with its normal spend guards enabled.

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CODES = ["070330645936", "6977228152610", "710154236681"];
const LIVE = process.env.LIVE_AI_TEST === "1";

function codeType(code) {
  if (/^\d{12}$/.test(code)) return "upc_a";
  if (/^\d{13}$/.test(code)) return "ean_13";
  if (/^\d{14}$/.test(code)) return "gtin_14";
  if (/^(X0|B0)[0-9A-Z]{8}$/i.test(code)) return "vendor_label";
  return /^\d+$/.test(code) ? "numeric_sku" : "alpha_sku";
}

async function main() {
  console.log("=== Decode smoke ===");
  console.log("base:", BASE, "| LIVE_AI_TEST:", LIVE ? "1 (may spend money)" : "unset (GET only)");

  let status;
  try {
    status = await (await fetch(`${BASE}/api/ai-lookup`)).json();
  } catch (error) {
    throw new Error(`Cannot reach ${BASE}. Start the app with npm run dev. ${String(error)}`);
  }
  console.log(JSON.stringify(status, null, 2));

  if (!LIVE) {
    console.log("No POST requests made. Set LIVE_AI_TEST=1 only after confirming the server budget and provider console.");
    return;
  }
  if (status.e2e) throw new Error("The server is in E2E mode; live GPT decode is disabled.");
  if (!status.openaiConfigured) throw new Error("OPENAI_API_KEY is not configured on the server.");

  for (const code of CODES) {
    const response = await fetch(`${BASE}/api/ai-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "decode",
        rawCode: code,
        cleanCode: code,
        codeType: codeType(code),
        confidenceThreshold: 0.85,
      }),
    });
    const body = await response.json();
    console.log(JSON.stringify({
      code,
      status: response.status,
      path: body.debug?.decodePath ?? body.providerNames?.[0] ?? body.reasonCode,
      decision: body.decision?.status,
      productName: body.results?.[0]?.productName ?? "",
      paidComputeCharged: body.debug?.paidComputeCharged ?? false,
    }, null, 2));
  }

  console.log("Do not infer spend from these responses. Reconcile true spend in the OpenAI provider console.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
