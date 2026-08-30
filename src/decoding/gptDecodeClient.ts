// The one paid decode provider. Input is the sanitized product code only. GPT may suggest an
// identity, but its own exact-code/confidence claims never create verified app truth.
//
// Pricing verified against the official GPT-5.4 mini and OpenAI API pricing pages on 2026-08-21:
// $0.75/M input tokens, $4.50/M output tokens, and $0.01 per web-search call. `usdComputedFloor`
// includes only response-observable units. Ambiguous failures/aborts reserve the documented worst
// case because the provider may still have executed work after the client stopped waiting.
const IN_USD_PER_M = 0.75;
const OUT_USD_PER_M = 4.5;
const USD_PER_SEARCH = 0.01;
// 400k possible input tokens + 6k output tokens + five searches is about $0.377. Round upward.
export const GPT_DECODE_WORST_CASE_USD = 0.39 as const;

export type GptTier = "verified" | "suggested" | "none";

export interface GptDecodeResult {
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
  usdComputedFloor: number;
  usdWorstCase: typeof GPT_DECODE_WORST_CASE_USD;
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
  `Identify the product for barcode ${code}. Search the web. ` +
  `GTIN zero-padding variants of a code (the same digits with leading zeros added or removed) ` +
  `are the SAME product - search the shortest form too. Return JSON only: ` +
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

function none(partial: Partial<GptDecodeResult>): GptDecodeResult {
  return {
    tier: "none", brand: "", productName: "", category: "", specs: "", gtin: "", confidence: 0,
    exactCodeFound: false, basis: "", sourceUrls: [], searches: 0,
    usdComputedFloor: 0, usdWorstCase: GPT_DECODE_WORST_CASE_USD, aborted: false, ...partial,
  };
}

export async function decodeWithGpt(
  code: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; signal?: AbortSignal },
): Promise<GptDecodeResult> {
  const f = deps.fetchImpl ?? fetch;
  // 35 seconds covers search round trips while keeping a bounded customer-visible wait.
  const timeoutMs = deps.timeoutMs ?? 35_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Combine a caller cancellation with the provider timeout. Cancellation is still charged at worst
  // case because the server may have executed after the client stopped waiting.
  const fetchSignal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
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
        model: process.env.GPT_DECODE_MODEL?.trim() || "gpt-5.4-mini",
        input: promptFor(code),
        tools: [{ type: "web_search", search_context_size: process.env.GPT_SEARCH_CONTEXT || "medium" }],
        reasoning: { effort: "low" },
        max_output_tokens: 6000,
        // OpenAI enforces this bound, making the separately billed search units meterable.
        max_tool_calls: 5,
        // Strict structured output keeps the provider boundary deterministic and parseable.
        text: {
          format: {
            type: "json_schema",
            name: "product_identity",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["brand", "productName", "category", "specs", "gtin", "confidence", "exactCodeFound", "basis", "sourceUrls"],
              properties: {
                brand: { type: "string" },
                productName: { type: "string" },
                category: { type: "string" },
                specs: { type: "string" },
                gtin: { type: "string" },
                confidence: { type: "number" },
                exactCodeFound: { type: "boolean" },
                basis: { type: "string" },
                sourceUrls: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      }),
      signal: fetchSignal,
    });
    if (!res.ok) {
      // These client-error classes reject the request before model execution. Rate limits, server
      // failures, timeouts, and network failures remain ambiguous and reserve worst case.
      const isPreExecutionRejection = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422;
      const error = res.status === 401 ? "openai_auth_failed (check OPENAI_API_KEY)" : `HTTP ${res.status}`;
      return none({ error, usdComputedFloor: isPreExecutionRejection ? 0 : GPT_DECODE_WORST_CASE_USD });
    }
    data = await res.json();
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    // A client-aborted or failed call may still have executed server-side: count worst case.
    return none({ aborted, usdComputedFloor: GPT_DECODE_WORST_CASE_USD, error: aborted ? "aborted at cap" : String(e).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }

  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const usdComputedFloor =
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
    return none({ searches, usdComputedFloor, error: "model returned non-JSON" });
  }

  const exactCodeFound = parsed.exactCodeFound === true;
  const confidence = clamp01(parsed.confidence);
  const productName = str(parsed.productName).trim();
  const category = str(parsed.category).trim();
  // Honest-empty (prompt v3): an empty productName is a deliberate "no evidence-based guess", NOT an
  // error. Keep the category so the UI can still label what the barcode probably is.
  if (!productName) return none({ searches, usdComputedFloor, category, error: "empty productName", raw: parsed });

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
    usdComputedFloor,
    usdWorstCase: GPT_DECODE_WORST_CASE_USD,
    aborted: false,
    raw: parsed,
  };
}
