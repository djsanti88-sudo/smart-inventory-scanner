// server-only
import "server-only";
import type { AiLookupResult, EvidenceResult } from "@/types";

// Fast brand-anchored grounded spec finder. Makes ONE Gemini Flash + Google Search grounding call
// with a hard 3s budget to look up tire (or other product) specs for a known brand prefix.
//
// parseSpecResponse is PURE (no I/O) and is the unit-tested core.
// groundedSpecFind is the live wrapper (mirrored from geminiProvider.ts line 29-59 pattern).

// ---------------------------------------------------------------------------
// PURE core - unit-tested; no I/O
// ---------------------------------------------------------------------------

export interface ParsedSpec {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
}

/**
 * Map a grounded JSON answer from the model to an AiLookupResult + EvidenceResult.
 * Brand is anchored: when anchorBrand is provided, the result brand is the anchor,
 * never the model's guessed brand.
 */
export function parseSpecResponse(json: unknown, code: string, anchorBrand: string | null): ParsedSpec {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;

  const brand = (anchorBrand && String(anchorBrand).trim()) || String(j.brand ?? "") || "";
  const model = j.model ? String(j.model) : "";
  const size = j.size ? String(j.size) : "";

  // If there is no usable identity, return null result.
  if (!model && !size) {
    return {
      result: null,
      evidence: {
        verified: false,
        strength: j.sourceUrl ? "url_only" : "none",
        matchedCode: code,
        matchedSources: j.sourceUrl ? [String(j.sourceUrl)] : [],
        reason: "No model or size returned by provider.",
      },
    };
  }

  const productName = [brand, model, size].filter(Boolean).join(" ").trim();
  const exactGrounded = j.exactCodeGrounded === true;
  const confidence = exactGrounded ? 0.9 : 0.6;

  // specsShort carries size + load index + speed rating as a compact spec string (consistent with
  // how the orchestrator's results carry size on the AiLookupResult).
  const loadIndex = j.loadIndex ? String(j.loadIndex) : "";
  const speedRating = j.speedRating ? String(j.speedRating) : "";
  const specParts = [size, loadIndex ? loadIndex + (speedRating ? speedRating : "") : ""].filter(Boolean);
  const specsShort = specParts.join(" ").trim();

  const sourceUrl = j.sourceUrl ? String(j.sourceUrl) : "";

  const result: AiLookupResult = {
    productName,
    brand,
    category: "",
    specsShort,
    specsFull: "",
    primarySku: "",
    primaryBarcode: code,
    gtin: "",
    upc: "",
    ean: "",
    aliases: [],
    imageUrl: "",
    productUrl: sourceUrl,
    sourceUrls: sourceUrl ? [sourceUrl] : [],
    confidence,
    verifiedFacts: [],
    guesses: [],
    needsHumanReview: !exactGrounded,
    sourceSnippets: [],
    groundingChunks: [],
    exactCodeEvidence: exactGrounded,
    corroboratedByModel: exactGrounded,
  };

  let evidence: EvidenceResult;
  if (exactGrounded) {
    evidence = {
      verified: true,
      strength: "fetched_source",
      matchedCode: code,
      matchedSources: sourceUrl ? [sourceUrl] : [],
      reason: "Grounded provider confirmed exact code in a cited source page.",
    };
  } else {
    evidence = {
      verified: false,
      strength: sourceUrl ? "url_only" : "none",
      matchedCode: code,
      matchedSources: sourceUrl ? [sourceUrl] : [],
      reason: "Exact code was not confirmed in any grounded source.",
    };
  }

  return { result, evidence };
}

// ---------------------------------------------------------------------------
// Live wrapper - mirrors geminiProvider.ts (fetch + google_search grounding)
// ---------------------------------------------------------------------------

export interface GroundedSpecFindResult {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
  latencyMs: number;
}

const GROUNDED_SPEC_GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.0-flash-001";

/**
 * Make ONE grounded Gemini Flash + Google Search call to look up specs for a product code.
 * Hard timeout of 3000ms. Never throws - returns null result on any failure.
 * Mirrors the provider call pattern from geminiProvider.ts lines 29-59.
 */
export async function groundedSpecFind(args: {
  code: string;
  anchorBrand: string | null;
  signal?: AbortSignal;
}): Promise<GroundedSpecFindResult> {
  const { code, anchorBrand, signal } = args;
  const start = Date.now();

  const nullResult = (): GroundedSpecFindResult => ({
    result: null,
    evidence: {
      verified: false,
      strength: "none",
      matchedCode: code,
      matchedSources: [],
      reason: "groundedSpecFind returned no usable result.",
    },
    latencyMs: Date.now() - start,
  });

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return nullResult();

  const brandHint = anchorBrand || "tire";
  const prompt =
    `UPC ${code} is a ${brandHint} tire. Using web/grounding, return ONLY JSON ` +
    `{brand, model, size, loadIndex, speedRating, sourceUrl, exactCodeGrounded} ` +
    `where exactCodeGrounded is true ONLY if a cited source page shows this exact UPC. ` +
    `Do not guess the brand.`;

  // Use the caller's signal if provided, else a hard 3s timeout (mirrors geminiProvider.ts line 29).
  const effectiveSignal = signal ?? AbortSignal.timeout(3000);

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GROUNDED_SPEC_GEMINI_MODEL}:generateContent?key=${apiKey}`;

  try {
    // Mirror geminiProvider.ts lines 29-59: POST with google_search tool, extract text + grounding.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
        tools: [{ google_search: {} }],
      }),
      signal: effectiveSignal,
    });

    if (!res.ok) return nullResult();

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text: string = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p?.text ?? "")
      .join("\n");

    // Tolerate code-fence wrapper (same pattern as geminiProvider.ts safeParseJson).
    const json = extractJson(text);
    const parsed = parseSpecResponse(json, code, anchorBrand);
    return { ...parsed, latencyMs: Date.now() - start };
  } catch {
    return nullResult();
  }
}

/** Extract the first JSON object from model text that may include prose or code fences. */
function extractJson(text: string): unknown {
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
