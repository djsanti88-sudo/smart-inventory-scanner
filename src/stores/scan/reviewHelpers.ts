import type { Product, UnknownCodeReview } from "@/types";
import { cleanProductName } from "@/decoding/decode";
import { gradeBarcode } from "@/products/barcodes/barcodeTrust";

/**
 * Phase-2 POISON GUARD core check (centralizes what used to be three copy-pasted blocks in
 * resolveUnknown). Returns true when a create_new is accepting the review's AI SUGGESTION (the new
 * product's normalized name equals the suggested name) AND the app could NOT back that suggestion with
 * any real evidence - no brand, no gtin/upc/ean, no source URL. Such an evidence-less guess must never
 * become a verified product / approved alias / verified catalog entry.
 *
 * NOTE: this is ONLY the name+evidence decision. The per-call-site `origin !== "human"` clause is applied
 * by the caller (two sites gate on it, the fresh-mint site historically does not) so this extraction does
 * NOT change any trust decision - it only de-duplicates the shared logic.
 */
function isWeakGuess(review: UnknownCodeReview, np: Partial<Product>): boolean {
  const normName = (s: string) => cleanProductName(s ?? "").trim().toLowerCase();
  const suggestedName = normName(review.suggestedProductName ?? "");
  const acceptingSuggestion =
    !!review.hasSuggestion && suggestedName.length > 0 && normName(np.name ?? "") === suggestedName;
  const suggestionHasRealEvidence =
    (review.suggestedBrand ?? "").trim().length > 0 ||
    [review.suggestedGtin, review.suggestedUpc, review.suggestedEan].some((c) => (c ?? "").trim().length > 0) ||
    (review.sourceUrls?.length ?? 0) > 0;
  return acceptingSuggestion && !suggestionHasRealEvidence;
}

/** TRUST GATE (spec v3 AM-4.2): rejected barcode identity fields are blanked, never stored. This is
 *  the single choke point for both resolveUnknown minting sites (provisional upgrade + fresh mint) -
 *  a phantom/misread barcode never becomes searchable/trusted product identity. The scanned cleanCode
 *  alias is NOT gated here (physically scanned; vendor labels must keep aliasing - Resolver Trust Rules
 *  unchanged). Blanking a field never blocks minting, counting, or alias teaching. */
function gateIdentityBarcodeFields(
  np: { gtin?: string; upc?: string; ean?: string; primarySku?: string },
): { gtin: string; upc: string; ean: string } {
  const gate = (v?: string): string => {
    const value = (v ?? "").trim();
    if (!value) return "";
    return gradeBarcode({ barcode: value, partNumber: np.primarySku }).verdict === "rejected" ? "" : value;
  };
  return { gtin: gate(np.gtin), upc: gate(np.upc), ean: gate(np.ean) };
}

// reviews are keyed to their originating scan event via idempotencyKey's event segment;
// we stash the scanEventId on the review's idempotencyKey, so derive it back here.
function idForReview(r: UnknownCodeReview): string {
  const parts = (r.idempotencyKey ?? "").split(":");
  return parts[2] ?? r.id;
}
export { gateIdentityBarcodeFields, idForReview, isWeakGuess };
