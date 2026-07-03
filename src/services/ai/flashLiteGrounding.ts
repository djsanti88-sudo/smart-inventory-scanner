// Grounding runs on Gemini 2.5 Flash-Lite by default (owner decision 2026-07-01): the 2.5 line gives
// 1,500 FREE grounding requests/day (~45k/month) billed per-prompt, vs the 3.x "-latest" line which is
// capped at 5,000 grounded prompts/MONTH and bills per search-query. Override with GEMINI_GROUND_MODEL.
// A retryable provider failure (429/5xx e.g. the 2026-07-02 "high demand" 503 outage) automatically
// falls back ONCE to GEMINI_GROUND_FALLBACK_MODEL (default gemini-2.5-flash - same free-grounding 2.5
// line; the whole 2.0 line is decommissioned for generateContent, live-checked 2026-07-02) so a
// primary-model outage degrades to the backup instead of silently deleting the grounding vote from
// the consensus. A lone fallback answer still can't auto-count - consensus gating is unchanged.
const MODEL = process.env.GEMINI_GROUND_MODEL || "gemini-2.5-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_GROUND_FALLBACK_MODEL || "gemini-2.5-flash";

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }>;
}

// Diagnostic status of the LAST grounding call (same pattern as getLastBarcodeDbStatus /
// getLastRetailLookupStatus): callers keep the silent-null contract, but the route debug payload can
// surface WHY grounding contributed nothing (a silent 503 outage is otherwise invisible).
type GroundingStatus = "idle" | "hit" | "fallback_hit" | "empty" | "no_key" | "network_error" | `error_${number}`;
let _last: GroundingStatus = "idle";
export function getLastGroundingStatus(): GroundingStatus { return _last; }

async function callModel(
  model: string,
  code: string,
  opts: { url?: string; apiKey?: string; fetch?: typeof fetch } | undefined,
  key: string,
): Promise<{ res: Response | null; networkError: boolean }> {
  const f = opts?.fetch ?? fetch;
  const tool = opts?.url ? { url_context: {} } : { google_search: {} };
  const prompt = opts?.url
    ? `From ${opts.url}, what product has UPC barcode ${code}? Reply only the brand and product name.`
    : `What product has UPC barcode ${code}? Reply only the brand and product name.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [tool] });
  try {
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return { res, networkError: false };
  } catch {
    return { res: null, networkError: true };
  }
}

export async function groundIdentify(code: string, opts?: { url?: string; apiKey?: string; fetch?: typeof fetch }): Promise<{ text: string; grounded: boolean; sources: string[]; sourceUrls: string[] } | null> {
  const key = opts?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) { _last = "no_key"; return null; }

  let usedFallback = false;
  let { res, networkError } = await callModel(MODEL, code, opts, key);
  // Provider failure (non-2xx or network) -> ONE retry on the backup model. A grounding call is free-tier
  // and the vote is load-bearing for consensus recall, so one extra attempt is always worth it.
  if (!res?.ok) {
    const failStatus: GroundingStatus = networkError ? "network_error" : (`error_${res!.status}` as GroundingStatus);
    ({ res, networkError } = await callModel(FALLBACK_MODEL, code, opts, key));
    if (!res?.ok) {
      _last = networkError ? "network_error" : failStatus;
      return null;
    }
    usedFallback = true;
  }

  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join(" ").trim();
  if (!text) { _last = "empty"; return null; }
  // GROUNDING-FIRST VERIFY: hand the APP the grounding sources so it can independently confirm the code.
  // `sources` = chunk titles + uris (legacy code-in-sources text signal). `sourceUrls` = ONLY the web.uri
  // values (the fetchable/redirect URLs) - these are what verifyCodeOnPage fetches to confirm the exact
  // code is really on the candidate page. The model's answer alone is never trusted as Verified.
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks.flatMap((c) => [c.web?.title ?? "", c.web?.uri ?? ""]).filter(Boolean);
  const sourceUrls = chunks.map((c) => c.web?.uri ?? "").filter(Boolean);
  _last = usedFallback ? "fallback_hit" : "hit";
  return { text, grounded: !opts?.url, sources, sourceUrls };
}
