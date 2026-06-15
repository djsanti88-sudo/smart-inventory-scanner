import type { AiLookupResult } from "@/types";
import { type AiProvider, type AiLookupRequest, normalizeResult } from "@/services/ai/provider";
import { detectCodeType } from "@/services/codeTypeDetector";

// Local mock AI provider. Deterministic, free, offline-safe. Produces a plausible LOW-confidence
// suggestion so the result always routes back to human review (confidence < 0.85). This proves the
// enrichment flow without any paid API call.
export const mockProvider: AiProvider = {
  name: "mock",
  async lookup(req: AiLookupRequest): Promise<AiLookupResult> {
    const code = req.cleanCodeSanitized || req.rawCodeSanitized;
    const type = detectCodeType(code);

    const isBarcode = type === "upc_a" || type === "ean_13" || type === "gtin_14";
    const result: Partial<AiLookupResult> = {
      productName: `Unidentified item (${code})`,
      brand: "",
      category: isBarcode ? "Unknown (retail item)" : "Unknown",
      specsShort: "",
      specsFull: "",
      primarySku: type === "alpha_sku" || type === "numeric_sku" ? code : "",
      primaryBarcode: isBarcode ? code : "",
      gtin: type === "gtin_14" || type === "ean_13" ? code : "",
      upc: type === "upc_a" ? code : "",
      ean: type === "ean_13" ? code : "",
      aliases: [code],
      imageUrl: req.allowImageSuggestions ? "" : "",
      productUrl: "",
      sourceUrls: [],
      confidence: 0.55,
      verifiedFacts: [`Scanned code shape detected: ${type}`],
      guesses: ["Product identity is a guess. A human should confirm before trusting it."],
      needsHumanReview: true,
    };
    return normalizeResult(result);
  },
};
