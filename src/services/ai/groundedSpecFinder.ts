// server-only
import "server-only";
import type { AiLookupResult, CodeType, EvidenceResult, ProviderEvidence } from "@/types";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import { tireSizeToken } from "@/services/ai/tireSpecs";

// Fast brand-anchored grounded spec finder. Makes ONE Gemini Flash + Google Search grounding call
// with a hard 3s budget to look up tire (or other product) specs for a known brand prefix.
//
// parseSpecResponse is PURE (no I/O, no evidence) and is the unit-tested identity core.
// groundedSpecFind is the live wrapper (mirrored from geminiProvider.ts line 29-59 pattern).
// Evidence is produced ONLY in groundedSpecFind via the app's EvidenceVerifier - never from the
// model's self-reported exactCodeGrounded flag.

// ---------------------------------------------------------------------------
// PURE identity core - unit-tested; no I/O; no evidence
// ---------------------------------------------------------------------------

export interface ParsedIdentity {
  result: AiLookupResult | null;
}

/**
 * Map a grounded JSON answer from the model to an AiLookupResult (identity only).
 * Brand is anchored: when anchorBrand is provided, the result brand is the anchor,
 * never the model's guessed brand.
 *
 * Evidence is NOT produced here. The live wrapper (groundedSpecFind) builds evidence
 * independently via the app's EvidenceVerifier from real grounding text.
 */
export function parseSpecResponse(json: unknown, anchorBrand: string | null): ParsedIdentity {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;

  const brand = (anchorBrand && String(anchorBrand).trim()) || String(j.brand ?? "") || "";
  const model = j.model ? String(j.model) : "";
  const rawSize = j.size ? String(j.size) : "";
  // The size often lives in the title/description, not a clean size field. Mine it from the model name
  // and product text when the structured field is missing (owner insight).
  const size = rawSize || tireSizeToken({
    productName: [j.brand, j.model, j.productName, j.description].filter(Boolean).map(String).join(" "),
  } as Parameters<typeof tireSizeToken>[0]);

  // If there is no usable identity, return null result.
  if (!model && !size) {
    return { result: null };
  }

  const productName = [brand, model, size].filter(Boolean).join(" ").trim();
  // confidence is NOT driven by exactCodeGrounded (model self-claim); it is set conservatively
  // here and the caller (groundedSpecFind) will receive real evidence from the app verifier.
  const confidence = 0.6;

  // specsShort carries size + load index + speed rating as a compact spec string (consistent with
  // how the orchestrator's results carry size on the AiLookupResult).
  const loadIndex = j.loadIndex ? String(j.loadIndex) : "";
  const speedRating = j.speedRating ? String(j.speedRating) : "";
  const specParts = [size, loadIndex ? loadIndex + (speedRating ? speedRating : "") : ""].filter(Boolean);
  const specsShort = specParts.join(" ").trim();

  const sourceUrl = j.sourceUrl ? String(j.sourceUrl) : "";

  // corroboratedByModel means "an INDEPENDENT second model read agreed" everywhere else (set only by
  // enrichWithPageFetch via crossCheck), and decideDecode's pageFetchModelAgreement branch can verify on
  // it. The grounded finder does NOT provide an independent second read - it has only the model's own
  // self-reported exactCodeGrounded claim - so it must NOT set this flag. A single self-claim can never
  // stand in for two-source agreement; the hot path still verifies via the prefix-family tireCorroborated
  // branch when the app-verified evidence is strong.

  const result: AiLookupResult = {
    productName,
    brand,
    category: "",
    specsShort,
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
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
    needsHumanReview: true,
    sourceSnippets: [],
    groundingChunks: [],
    exactCodeEvidence: false,
    corroboratedByModel: false,
  };

  return { result };
}

// ---------------------------------------------------------------------------
// Live wrapper - mirrors geminiProvider.ts (fetch + google_search grounding)
// ---------------------------------------------------------------------------

export interface GroundedSpecFindResult {
  result: AiLookupResult | null;
  evidence: EvidenceResult;
  latencyMs: number;
}

export const GROUNDED_SPEC_GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Make ONE grounded Gemini Flash + Google Search call to look up specs for a product code.
 * Hard timeout of 3000ms. Never throws - returns null result on any failure.
 * Mirrors the provider call pattern from geminiProvider.ts lines 29-59.
 *
 * Evidence is produced by the app's EvidenceVerifier (verifyEvidence) from the real grounding
 * text extracted from groundingMetadata. The model's exactCodeGrounded flag is NEVER used to
 * set evidence.verified or evidence.strength.
 */
export async function groundedSpecFind(args: {
  code: string;
  codeType?: CodeType;
  anchorBrand: string | null;
  signal?: AbortSignal;
}): Promise<GroundedSpecFindResult> {
  const { code, codeType = "upc_a", anchorBrand, signal } = args;
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

  // NOTE: key-in-URL matches the existing geminiProvider.ts precedent (line 20) - tracked for
  // codebase-wide follow-up rather than diverging from the parent here.
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

    if (!res.ok) {
      // Log safe status code only - no URL (contains key), no stack trace.
      console.error(`[groundedSpecFinder] Gemini error ${res.status} after ${Date.now() - start}ms`);
      return nullResult();
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text: string = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p?.text ?? "")
      .join("\n");

    // --- Extract grounding evidence (mirrors geminiProvider.ts lines 44-49) ---
    const gm = candidate?.groundingMetadata ?? {};
    const chunks: Array<{ web?: { uri?: string; title?: string } }> = gm.groundingChunks ?? [];
    const supports: Array<{ segment?: { text?: string } }> = gm.groundingSupports ?? [];
    const sourceUrls = chunks.map((c) => c.web?.uri).filter((u): u is string => !!u);
    const supportTexts = supports.map((s) => s.segment?.text).filter((t): t is string => !!t);

    // Build the ProviderEvidence for the app's EvidenceVerifier.
    // supportTexts are grounding segment texts (strongest prose evidence tier).
    // sourceUrls are cited page URLs. No fetchedSourceText here (only the page-fetch path has that).
    // NOTE: response-size-limit matches geminiProvider.ts precedent - tracked for codebase-wide
    // follow-up rather than diverging from the parent here.
    const providerEvidence: ProviderEvidence = {
      sourceUrls,
      sourceSnippets: [],
      groundingChunks: supportTexts,
    };

    // Run the app's EvidenceVerifier. This - not the model's claim - decides verified/strength.
    // Mirrored from decodeOrchestrator.ts line 132: verifyEvidence(p.code, p.codeType, evidenceOf(r))
    const evidence = verifyEvidence(code, codeType, providerEvidence);

    // Tolerate code-fence wrapper (same pattern as geminiProvider.ts safeParseJson).
    const json = extractJson(text);

    // parseSpecResponse is identity-only: it anchors brand and builds productName.
    // It does NOT produce evidence (that came from the EvidenceVerifier above).
    const { result: identityResult } = parseSpecResponse(json, anchorBrand);

    if (!identityResult) {
      return {
        result: null,
        evidence,
        latencyMs: Date.now() - start,
      };
    }

    // Attach grounding metadata to the result so downstream callers can inspect it.
    const result: AiLookupResult = {
      ...identityResult,
      primaryBarcode: code,
      sourceUrls,
      groundingChunks: supportTexts,
      // confidence: use verified evidence strength to inform confidence (not exactCodeGrounded).
      confidence: evidence.verified ? 0.9 : 0.6,
      // needsHumanReview: clear only if the app verifier confirmed the exact code in strong evidence.
      needsHumanReview: !evidence.verified,
    };

    return { result, evidence, latencyMs: Date.now() - start };
  } catch (err) {
    // Log error TYPE + latency only - no URL (contains key), no stack trace (matches geminiProvider
    // pattern of throwing a safe message without logging the full URL/key).
    const errType = err instanceof Error ? err.constructor.name : typeof err;
    console.error(`[groundedSpecFinder] catch ${errType} after ${Date.now() - start}ms`);
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
