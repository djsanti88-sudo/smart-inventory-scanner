// Architecture Version: v1.0.0
//
// snippetCap.ts - W4 (v1.0.0): cap AI-bound evidence snippets to a fixed character budget to cut
// token waste and latency. Applied to per-snippet text (grounding chunks, citation segments, titles)
// before it is stored on an AiLookupResult or re-sent to a model.
//
// BOUNDARY: this is NEVER applied to the full fetched page text used by the EvidenceVerifier for
// exact-code matching (that lives on ProviderEvidence.fetchedSourceText and must stay complete, so a
// code appearing far into a page still verifies).

export const MAX_AI_SNIPPET_CHARS = 1500;

/** Cap a single AI-bound snippet to MAX_AI_SNIPPET_CHARS. Non-strings collapse to "". */
export function capSnippet(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.length > MAX_AI_SNIPPET_CHARS ? s.slice(0, MAX_AI_SNIPPET_CHARS) : s;
}

/** Cap every snippet in a list. Non-array input yields []. */
export function capSnippets(arr: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(capSnippet);
}
