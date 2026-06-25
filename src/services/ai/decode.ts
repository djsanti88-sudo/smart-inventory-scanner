import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult } from "@/types";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { isTireContext, hasRequiredTireSpecs, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
import { isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";

// decideDecode: the gate that turns provider results + APP-verified evidence into a final decode
// status. A "verified" decode (auto-counted) requires ALL of:
//   - public barcode code type (never X00/FNSKU/vendor_label/internal_code/messy)
//   - strong app-verified evidence (snippet / grounding_chunk / fetched_source), set by the app
//   - BOTH providers (Gemini Flash + ChatGPT mini, run in parallel) AGREE on the identity
//   - non-empty product identity
//   - confidence >= threshold
// A SINGLE provider on its own is NOT enough to auto-count (it becomes a Suggested, human-reviewed
// result) - two independent providers must agree before we trust a code enough to count it. This is
// what stopped a lone provider's wrong web-data (e.g. a mis-decoded UPC) from being auto-counted.
// Anything short of full agreement is suggested / needs_review. Provider disagreement is a conflict.

const PUBLIC_BARCODE_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14"];

export interface DecodeParams {
  codeType: CodeType;
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  confidenceThreshold: number;
  code?: string; // the exact scanned code, for deterministic brand-prefix-family corroboration
  scanContext?: "any" | "tire"; // business scan context; "tire" enables deterministic tire corroboration
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
  const { codeType, confidenceThreshold, code, scanContext } = params;
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

  // Auto-count ONLY when BOTH providers agree. A single provider, even with strong app-verified
  // evidence, is downgraded to "suggested" (human review) - two providers must independently land on
  // the same identity before we trust it enough to count.
  const canVerify =
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    passesThreshold &&
    cc.decision === "agree";

  // DETERMINISTIC TIRE CORROBORATION: the barcode's STRONG brand-prefix family + tire context + full tire
  // specs + the app's own exact-code verification act as an INDEPENDENT agreeing source - equivalent to
  // two-provider agreement, but grounded in signals that do NOT come from the AI text (prefix table, spec
  // structure, business context). This lets an accurate single-provider tire decode auto-count without a
  // second AI provider. A brand/prefix MISMATCH, non-tire product, missing specs, or weak/unverified
  // evidence can never satisfy it - and confidence alone never does (it is not one of the conditions).
  const tireCorroborated =
    scanContext === "tire" &&
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    !!a &&
    isTireContext(a) &&
    hasCountableTireIdentity(a) &&
    !!code &&
    isBrandInPrefixFamily(code, a.brand, { strongOnly: true });

  // PATH 2 (Phase 9) - PAGE-FETCH + ONE MODEL AGREEMENT. The page-fetch is the app's own retrieval of the
  // REAL product page (exact code confirmed in the page text -> strong fetched_source evidence). When an
  // INDEPENDENT model read of that SAME page agreed on the normalized tire identity (set as
  // a.corroboratedByModel by enrichWithPageFetch via crossCheck), that is a genuine two-source agreement -
  // page-fetch (deterministic) + model - and unlocks auto-count WITHOUT needing the strong prefix family.
  // It is NOT confidence-only and NOT page-fetch alone: it requires the model agreement flag AND strong
  // app-verified exact-code evidence AND tire domain AND a countable identity (size + model). The firewall + brand_prefix conflict +
  // the >=0.9 store gate still apply downstream, so a non-tire (poison) can never reach a count this way.
  const pageFetchModelAgreement =
    scanContext === "tire" &&
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    !!a &&
    a.corroboratedByModel === true &&
    isTireContext(a) &&
    hasCountableTireIdentity(a);

  // PATH 3 - INTERNET TWO-SOURCE SIZE AGREEMENT. The barcode's STRONG brand-prefix family gives the brand
  // deterministically (public GS1 fact, not the AI text). When two INDEPENDENT Internet retrievals (grounded
  // search + a direct page fetch) agreed on the SIZE (a.sizeAgreement, set by the route race), that
  // agreement is the second source - so we do NOT require the exact code echoed on a page. The local DB is
  // never consulted. Poison / non-tire / weak-prefix / single-source can never satisfy it.
  const internetTwoSourceSize =
    scanContext === "tire" &&
    isPublicBarcode &&
    identityNonEmpty &&
    passesThreshold &&
    !!a &&
    a.sizeAgreement === true &&
    isTireContext(a) &&
    hasCountableTireIdentity(a) &&
    !!code &&
    isBrandInPrefixFamily(code, a.brand, { strongOnly: true });

  if (canVerify || tireCorroborated || pageFetchModelAgreement || internetTwoSourceSize) {
    const corroborationPath = canVerify
      ? "two_ai_agreement"
      : tireCorroborated
        ? "deterministic_prefix"
        : pageFetchModelAgreement
          ? "page_fetch_model_agreement"
          : "internet_two_source_size";
    return {
      status: "verified",
      confidence: Math.min(1, Math.max(maxConfidence, cc.confidence)),
      reason: canVerify
        ? "Verified AI Decode: both providers independently agree and the app confirmed the exact code in real evidence."
        : tireCorroborated
          ? "Verified AI Decode: tire corroborated by the barcode's strong brand-prefix family + size + model + app-verified exact code (independent of the AI text)."
          : pageFetchModelAgreement
            ? "Verified AI Decode: the app's page-fetch and an independent model read agree on the tire identity, with size + model + app-verified exact code."
            : "Verified AI Decode: brand from the strong GS1 prefix and two independent Internet sources agree on the size.",
      evidenceStrength: bestEvidence.strength,
      exactCodeEvidenceVerifiedByApp: canVerify || tireCorroborated || pageFetchModelAgreement,
      crossCheck: baseCrossCheck,
      corroborationPath,
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
          : cc.decision !== "agree"
            ? "Only one source could confirm this; a second source must agree before it is auto-counted."
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
