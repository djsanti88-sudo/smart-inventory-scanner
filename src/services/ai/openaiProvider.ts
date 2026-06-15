import type { AiLookupResult } from "@/types";
import { type AiProvider, type AiLookupRequest, normalizeResult } from "@/services/ai/provider";
import { buildLookupPrompt } from "@/services/ai/prompt";

// OpenAI provider using the Responses API WITH the web_search tool (so it can decode a UPC from the
// live web). SERVER-SIDE ONLY. Extracts url_citation annotations into sourceUrls + sourceSnippets so
// the app can independently verify the exact code. Throws "not configured" with no key.
export function createOpenAiProvider(opts?: { model?: string; label?: string; disableSearch?: boolean }): AiProvider {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = opts?.model || process.env.OPENAI_MODEL || "gpt-5-mini";
  const webSearch = !opts?.disableSearch && process.env.ENABLE_OPENAI_WEB_SEARCH !== "false";

  return {
    name: opts?.label || "openai",
    async lookup(req: AiLookupRequest, signal?: AbortSignal): Promise<AiLookupResult> {
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

      const prompt = buildLookupPrompt(req);
      const body: Record<string, unknown> = { model, input: prompt };
      if (webSearch) body.tools = [{ type: "web_search" }];

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();

      // --- Collect assistant text + url_citation annotations from the Responses API output ---
      let text = "";
      const sourceUrls: string[] = [];
      const citedSnippets: string[] = [];
      const titles: string[] = [];
      for (const item of data?.output ?? []) {
        if (item?.type !== "message") continue;
        for (const part of item?.content ?? []) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            const t: string = part.text;
            text += t;
            for (const ann of part.annotations ?? []) {
              if (ann?.type === "url_citation" && ann.url) {
                sourceUrls.push(ann.url);
                if (ann.title) titles.push(ann.title);
                if (typeof ann.start_index === "number" && typeof ann.end_index === "number") {
                  const seg = t.slice(ann.start_index, ann.end_index).trim();
                  if (seg) citedSnippets.push(seg);
                }
              }
            }
          }
        }
      }
      // Fallback for the convenience field if present.
      if (!text && typeof data?.output_text === "string") text = data.output_text;

      const parsed = safeParseJson(text);
      const merged: Partial<AiLookupResult> = {
        ...parsed,
        sourceUrls: uniq([...(parsed.sourceUrls ?? []), ...sourceUrls]),
        sourceSnippets: uniq([...(parsed.sourceSnippets ?? []), ...citedSnippets, ...titles]),
      };
      return normalizeResult(merged);
    },
  };
}

function uniq(a: string[]): string[] {
  return [...new Set(a.filter(Boolean))];
}

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
