import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult } from "@/types";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";

// decideDecode: the gate that turns provider results + APP-verified evidence into a final decode
// status. A "verified" decode requires ALL of:
//   - public barcode code type (never X00/FNSKU/vendor_label/internal_code/messy)
//   - strong app-verified evidence (snippet / grounding_chunk / fetched_source), set by the app
//   - provider agreement OR a single provider (never a conflict)
//   - non-empty product identity
//   - confidence >= threshold
// Anything short of that is suggested / needs_review. Provider disagreement is a conflict.

const PUBLIC_BARCODE_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14"];

export interface DecodeParams {
  codeType: CodeType;
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  confidenceThreshold: number;
}

// --- Product-name quality gate (junk firewall) ------------------------------------------------
// Providers and page scrapes sometimes hand back a website/search/error page TITLE, an AI hedge,
// or a placeholder instead of a real product. None of these may be trusted or auto-added.

// Hedge parentheticals/tails like "(likely wholesale listing)" or "- exact variant unknown".
const HEDGE_PAREN = /\s*\((?:likely|possibly|probably|maybe|uncertain|unverified|unconfirmed|best guess|guess|approx\.?|exact variant unknown|variant unknown|wholesale listing)[^)]*\)/gi;
const HEDGE_TAIL = /\s*[-–—]\s*(?:exact variant unknown|variant unknown|unverified|unconfirmed|best guess)\s*$/i;

// Barcode-site / search / error / store-nav titles that are NOT products.
const SITE_BLOCKLIST =
  /\b(upc barcode search|barcode lookup|look ?up any (upc|ean|isbn)|go-?upc|upcitemdb|barcodefinder|barcode finder|barcodespider|barcodes? database|barcode database|ean-?search|eandata|barcodes?\.(com|net|org)|gtin ?lookup|buy ?upc|product ?lookup|barcode ?india|barcodable|scandit|search results|results for|page not found|404 (not found|error)|error 404|add to cart|your cart|shopping cart|all categories)\b/i;
const PLACEHOLDER_NAME = /^\s*(unknown|unidentified|n\/a)\b|no (public )?match|not found|no result/i;

// Barcode-site title cruft appended after a separator (incl. em/en dash), e.g.
// "Bic Lighter Texas — UPC 70330645936 — Go-UPC" or "Widget | Barcode Lookup".
const TITLE_CODE_SUFFIX = /\s*[|–—-]\s*(?:upc|ean|gtin|isbn|barcode)\b[\s\S]*$/i;
const TITLE_SITE_SUFFIX =
  /\s*[|–—-]\s*(?:barcode lookup|upcitemdb|go-?upc|buycott|barcodespider|barcode ?finder|barcodes? ?database|ean-?search|eandata|barcodes?\.(?:com|net|org)|gtin ?lookup)\b[\s\S]*$/i;

/** Strip AI hedges + barcode-site title cruft; keep real descriptors like "(Texas)" and hyphens. */
export function cleanProductName(name: string): string {
  return (name ?? "")
    .replace(HEDGE_PAREN, "")
    .replace(HEDGE_TAIL, "")
    .replace(TITLE_CODE_SUFFIX, "")
    .replace(TITLE_SITE_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True only for a clean, real product name (not a website title, hedge, placeholder, or junk). */
export function isUsableProductName(raw: string): boolean {
  const name = cleanProductName(raw);
  if (name.length < 3 || name.length > 120) return false;
  if (PLACEHOLDER_NAME.test(name)) return false;
  if (SITE_BLOCKLIST.test(name)) return false;
  if (/^https?:\/\//i.test(name) || /^[a-z0-9.-]+\.(com|org|net|io)\b/i.test(name)) return false; // bare domain/url
  return true;
}

function identityOf(r: AiLookupResult): string {
  const name = isUsableProductName(r.productName) ? cleanProductName(r.productName) : "";
  return `${name} ${r.brand}`.trim();
}

export function decideDecode(params: DecodeParams): DecodeDecision {
  const { codeType, confidenceThreshold } = params;
  const present = params.results.filter((r) => r && identityOf(r).length > 0);
  const a = present[0] ?? null;
  const b = present[1] ?? null;
  const cc = crossCheck(a, b);

  const bestEvidence = strongestEvidence(params.evidences);
  const strong = isStrongEvidence(bestEvidence);
  const isPublicBarcode = PUBLIC_BARCODE_TYPES.includes(codeType);
  const maxConfidence = present.reduce((m, r) => Math.max(m, r.confidence), 0);
  const identityNonEmpty = present.length > 0;
  const passesThreshold = maxConfidence >= confidenceThreshold;

  const baseCrossCheck = cc;

  // Provider disagreement -> Conflict, never guessed.
  if (cc.decision === "conflict") {
    return {
      status: "conflict",
      confidence: cc.confidence,
      reason: `Providers conflict: ${cc.contradictions.join("; ")}. Routed to human review.`,
      evidenceStrength: bestEvidence.strength,
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: baseCrossCheck,
    };
  }

  const canVerify =
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    passesThreshold &&
    (cc.decision === "agree" || cc.decision === "single_provider");

  if (canVerify) {
    return {
      status: "verified",
      confidence: Math.min(1, Math.max(maxConfidence, cc.confidence)),
      reason:
        cc.decision === "agree"
          ? "Verified AI Decode: providers agree and the app independently confirmed the exact code in real evidence."
          : "Verified AI Decode: single provider, but the app independently confirmed the exact code in strong evidence.",
      evidenceStrength: bestEvidence.strength,
      exactCodeEvidenceVerifiedByApp: true,
      crossCheck: baseCrossCheck,
    };
  }

  // ANY usable product identity -> Suggested (show the best sourced product + the reason it was not
  // auto-verified). We never bury a real provider result in a blank Needs Review. needs_review is
  // reserved for "no provider produced a product" (or missing keys, handled upstream).
  if (identityNonEmpty) {
    const why = !isPublicBarcode
      ? "Code type cannot be auto-verified (vendor/label/internal); confirm before saving."
      : !strong
        ? "Evidence is weak (the exact code was not found in a snippet/grounding/fetched source)."
        : !passesThreshold
          ? "Confidence is below the threshold."
          : "Needs human confirmation.";
    return {
      status: "suggested",
      confidence: Math.max(maxConfidence * 0.6, cc.confidence * 0.6),
      reason: `Suggested, not trusted. ${why} Review the sources and approve to save.`,
      evidenceStrength: bestEvidence.strength,
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: baseCrossCheck,
    };
  }

  return {
    status: "needs_review",
    confidence: 0,
    reason: "No provider returned a usable product. Try Retry live decode, or resolve manually.",
    evidenceStrength: bestEvidence.strength,
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: baseCrossCheck,
  };
}
