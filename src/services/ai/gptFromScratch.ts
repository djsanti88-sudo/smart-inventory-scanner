// GPT-5.5 "search from scratch" - the paid END of the decode ladder (owner spec 2026-07-05,
// rebuilt 2026-07-06 to PROBE PARITY per owner order: raw code in, GPT's answer taken as
// returned, no wrapper rules on top). Input is the CODE ONLY (no handoff evidence). The answer
// is TRUSTED per the owner's rule; tiers come from GPT's OWN self-report and nothing else:
//   verified  = exactCodeFound && confidence >= 0.8 (owner auto-count rule)
//   suggested = any other answer with a non-empty productName (shown as-is, human approves)
//   none      = empty productName (honest-empty) / error / abort
// This module is pure: fetch injected, no env reads.
const IN_USD_PER_M = 5.0;
const OUT_USD_PER_M = 30.0;
const USD_PER_SEARCH = 0.01;
export const GPT_LADDER_WORST_CASE_USD = 0.39 as const;

export type GptTier = "verified" | "suggested" | "none";

export interface GptFromScratchResult {
  tier: GptTier;
  brand: string;
  productName: string;
  category: string;
  specs: string;
  gtin: string;
  confidence: number;
  exactCodeFound: boolean;
  basis: string;
  sourceUrls: string[];
  searches: number;
  usdActual: number;
  usdWorstCase: typeof GPT_LADDER_WORST_CASE_USD;
  aborted: boolean;
  error?: string;
  raw?: unknown;
}

export function gptTierFor(exactCodeFound: boolean, confidence: number, productName = ""): GptTier {
  // Honest-empty (prompt v3, owner order 2026-07-08): an empty productName is "no evidence-based
  // guess" - it is never a suggestion, always tier none, regardless of exactCodeFound/confidence.
  if (!productName.trim()) return "none";
  if (exactCodeFound && confidence >= 0.8) return "verified";
  // Owner rule (2026-07-06): every other answer WITH a productName IS the suggestion, exactly as
  // the probe showed it - no info_only demotion, no burying weak guesses.
  return "suggested";
}

const promptFor = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: ` +
  `{"brand":"","productName":"","category":"","specs":"","gtin":"","confidence":0.0,` +
  `"exactCodeFound":false,"basis":"","sourceUrls":[]}. ` +
  `If you find this exact code on a real page, set exactCodeFound true, copy the product ` +
  `identity EXACTLY as the page states it (brand, full product name, size/variant), and set ` +
  `confidence to match the evidence. If you cannot find the exact code, you may give ONE best ` +
  `guess ONLY when concrete evidence points to a specific product (prefix ownership, near-identical ` +
  `listings, partial code matches) - set exactCodeFound false, confidence 0.4 or less, name the ` +
  `category, and cite the evidence in basis. If you have no evidence-based guess, return an empty ` +
  `productName and say in basis what you searched and why nothing qualified. Never invent a product. ` +
  `Always fill category with the product type you believe the barcode belongs to, even when ` +
  `productName is empty. Keep it brief.`;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

function none(partial: Partial<GptFromScratchResult>): GptFromScratchResult {
  return {
    tier: "none", brand: "", productName: "", category: "", specs: "", gtin: "", confidence: 0,
    exactCodeFound: false, basis: "", sourceUrls: [], searches: 0,
    usdActual: 0, usdWorstCase: GPT_LADDER_WORST_CASE_USD, aborted: false, ...partial,
  };
}

export async function gptFromScratch(
  code: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number },
): Promise<GptFromScratchResult> {
  const f = deps.fetchImpl ?? fetch;
  // 35s cap (owner-set 2026-07-06, raised from 18s): the exhaustion band on unfindable codes runs
  // 12-28s live (probe max 27.0s, our control max 27.8s) - 35s lets every call finish and ANSWER
  // (the prompt's always-answer property), which also bills actuals instead of worst case.
  const timeoutMs = deps.timeoutMs ?? 35_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data: {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  try {
    const res = await f("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: promptFor(code),
        tools: [{ type: "web_search", search_context_size: "low" }],
        reasoning: { effort: "low" },
        max_output_tokens: 6000,
        // 5 = the owner-set cap from the 21/21 probe (server-enforced by OpenAI).
        max_tool_calls: 5,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return none({ error: `HTTP ${res.status}`, usdActual: GPT_LADDER_WORST_CASE_USD });
    data = await res.json();
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    // A client-aborted or failed call may still have executed server-side: count worst case.
    return none({ aborted, usdActual: GPT_LADDER_WORST_CASE_USD, error: aborted ? "aborted at cap" : String(e).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }

  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const usdActual =
    ((data.usage?.input_tokens ?? 0) / 1e6) * IN_USD_PER_M +
    ((data.usage?.output_tokens ?? 0) / 1e6) * OUT_USD_PER_M +
    searches * USD_PER_SEARCH;

  const text = (data.output ?? [])
    .flatMap((o) => o?.content ?? [])
    .filter((c) => c?.type === "output_text")
    .map((c) => c?.text ?? "")
    .join("");
  let parsed: Record<string, unknown>;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    return none({ searches, usdActual, error: "model returned non-JSON" });
  }

  const exactCodeFound = parsed.exactCodeFound === true;
  const confidence = clamp01(parsed.confidence);
  const productName = str(parsed.productName).trim();
  const category = str(parsed.category).trim();
  // Honest-empty (prompt v3): an empty productName is a deliberate "no evidence-based guess", NOT an
  // error. Keep the category so the UI can still label what the barcode probably is.
  if (!productName) return none({ searches, usdActual, category, error: "empty productName", raw: parsed });

  return {
    tier: gptTierFor(exactCodeFound, confidence, productName),
    brand: str(parsed.brand).trim(),
    productName,
    category,
    specs: str(parsed.specs).trim(),
    gtin: str(parsed.gtin).replace(/\D/g, ""),
    confidence,
    exactCodeFound,
    basis: str(parsed.basis).slice(0, 300),
    sourceUrls: Array.isArray(parsed.sourceUrls) ? parsed.sourceUrls.filter((u): u is string => typeof u === "string").slice(0, 5) : [],
    searches,
    usdActual,
    usdWorstCase: GPT_LADDER_WORST_CASE_USD,
    aborted: false,
    raw: parsed,
  };
}
