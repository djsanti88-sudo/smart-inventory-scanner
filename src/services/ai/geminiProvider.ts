import type { AiLookupResult } from "@/types";
import { type AiProvider, type AiLookupRequest, normalizeResult } from "@/services/ai/provider";
import { buildLookupPrompt } from "@/services/ai/prompt";

// Gemini provider WITH Google Search grounding (so it can decode a UPC from the live web, like a
// person searching). SERVER-SIDE ONLY. Extracts groundingMetadata (groundingChunks + supports) into
// sourceUrls / sourceSnippets / groundingChunks so the app's EvidenceVerifier can independently
// confirm the exact code appears in a real source. Throws "not configured" with no key.
export function createGeminiProvider(opts?: { model?: string; label?: string; disableSearch?: boolean }): AiProvider {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const model = opts?.model || process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const grounding = !opts?.disableSearch && process.env.ENABLE_GEMINI_SEARCH_GROUNDING !== "false";

  return {
    name: opts?.label || "gemini",
    async lookup(req: AiLookupRequest, signal?: AbortSignal): Promise<AiLookupResult> {
      if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

      const prompt = buildLookupPrompt(req);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Grounding with Google Search. Do NOT also force responseMimeType=json here (it conflicts
        // with tool use); we extract JSON from the text instead.
        generationConfig: { temperature: 0.2 },
      };
      if (grounding) body.tools = [{ google_search: {} }];

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();

      const candidate = data?.candidates?.[0];
      const text: string = (candidate?.content?.parts ?? [])
        .map((p: { text?: string }) => p?.text ?? "")
        .join("\n");

      // --- Extract grounding evidence ---
      const gm = candidate?.groundingMetadata ?? {};
      const chunks: Array<{ web?: { uri?: string; title?: string } }> = gm.groundingChunks ?? [];
      const supports: Array<{ segment?: { text?: string } }> = gm.groundingSupports ?? [];
      const sourceUrls = chunks.map((c) => c.web?.uri).filter((u): u is string => !!u);
      const chunkTitles = chunks.map((c) => c.web?.title).filter((t): t is string => !!t);
      const supportTexts = supports.map((s) => s.segment?.text).filter((t): t is string => !!t);

      const parsed = safeParseJson(text);
      const merged: Partial<AiLookupResult> = {
        ...parsed,
        sourceUrls: uniq([...(parsed.sourceUrls ?? []), ...sourceUrls]),
        // grounded response segments are the strongest textual evidence; chunk titles are snippets.
        groundingChunks: supportTexts,
        sourceSnippets: uniq([...(parsed.sourceSnippets ?? []), ...chunkTitles, ...supportTexts]),
      };
      return normalizeResult(merged);
    },
  };
}

function uniq(a: string[]): string[] {
  return [...new Set(a.filter(Boolean))];
}

/** Extract the first JSON object from a model response that may include prose / code fences. */
function safeParseJson(text: string): Partial<AiLookupResult> {
  if (!text) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {};
  }
}
