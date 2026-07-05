// GPT-5.5 "search from scratch" - the paid END of the decode ladder (owner spec 2026-07-05).
// Input is the CODE ONLY (no handoff evidence). The answer is TRUSTED per the owner's rule;
// tiers come from GPT's OWN self-report. This module is pure: fetch injected, no env reads.
const IN_USD_PER_M = 5.0;
const OUT_USD_PER_M = 30.0;
const USD_PER_SEARCH = 0.01;
export const GPT_LADDER_WORST_CASE_USD = 0.39 as const;

export type GptTier = "verified" | "suggested" | "info_only" | "none";

export interface GptFromScratchResult {
  tier: GptTier;
  brand: string;
  productName: string;
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

export function gptTierFor(exactCodeFound: boolean, confidence: number): GptTier {
  if (exactCodeFound && confidence >= 0.8) return "verified";
  if (confidence >= 0.5) return "suggested";
  return "info_only";
}

const promptFor = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

function none(partial: Partial<GptFromScratchResult>): GptFromScratchResult {
  return {
    tier: "none", brand: "", productName: "", specs: "", gtin: "", confidence: 0,
    exactCodeFound: false, basis: "", sourceUrls: [], searches: 0,
    usdActual: 0, usdWorstCase: GPT_LADDER_WORST_CASE_USD, aborted: false, ...partial,
  };
}

export async function gptFromScratch(
  code: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number },
): Promise<GptFromScratchResult> {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
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
        max_tool_calls: 6,
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
  if (!productName) return none({ searches, usdActual, error: "empty productName", raw: parsed });

  return {
    tier: gptTierFor(exactCodeFound, confidence),
    brand: str(parsed.brand).trim(),
    productName,
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
