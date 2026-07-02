// Grounding runs on Gemini 2.5 Flash-Lite by default (owner decision 2026-07-01): the 2.5 line gives
// 1,500 FREE grounding requests/day (~45k/month) billed per-prompt, vs the 3.x "-latest" line which is
// capped at 5,000 grounded prompts/MONTH and bills per search-query. Override with GEMINI_GROUND_MODEL
// (e.g. drop to "gemini-2.0-flash-lite" if the 2.5 daily quota is ever exhausted too).
const MODEL = process.env.GEMINI_GROUND_MODEL || "gemini-2.5-flash-lite";

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }>;
}

export async function groundIdentify(code: string, opts?: { url?: string; apiKey?: string; fetch?: typeof fetch }): Promise<{ text: string; grounded: boolean; sources: string[]; sourceUrls: string[] } | null> {
  const key = opts?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) return null;
  const f = opts?.fetch ?? fetch;
  const tool = opts?.url ? { url_context: {} } : { google_search: {} };
  const prompt = opts?.url
    ? `From ${opts.url}, what product has UPC barcode ${code}? Reply only the brand and product name.`
    : `What product has UPC barcode ${code}? Reply only the brand and product name.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [tool] });
  let res: Response;
  try { res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join(" ").trim();
  if (!text) return null;
  // GROUNDING-FIRST VERIFY: hand the APP the grounding sources so it can independently confirm the code.
  // `sources` = chunk titles + uris (legacy code-in-sources text signal). `sourceUrls` = ONLY the web.uri
  // values (the fetchable/redirect URLs) - these are what verifyCodeOnPage fetches to confirm the exact
  // code is really on the candidate page. The model's answer alone is never trusted as Verified.
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks.flatMap((c) => [c.web?.title ?? "", c.web?.uri ?? ""]).filter(Boolean);
  const sourceUrls = chunks.map((c) => c.web?.uri ?? "").filter(Boolean);
  return { text, grounded: !opts?.url, sources, sourceUrls };
}
