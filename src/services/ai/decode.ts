import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult } from "@/types";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { isTireContext, hasRequiredTireSpecs, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
import { isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";

// decideDecode: the gate that turns provider results + APP-verified evidence into a final decode
// status. MASTER BASELINE v1 (owner-locked, supersedes the older two-provider rule): a "verified"
// decode (auto-counted) requires ALL of:
//   - public barcode code type (never X00/FNSKU/vendor_label/internal_code/messy)
//   - strong app-verified evidence (snippet / grounding_chunk / fetched_source), set by the app
//   - non-empty product identity
//   - confidence >= threshold (baseline 0.8)
//   - NO catalog-derived brand-prefix conflict
// A SINGLE source is ENOUGH: one provider (e.g. Gemini Flash) whose result the app independently
// verified to contain the EXACT code in strong evidence auto-counts ("one source is enough") - no
// second provider and no trusted-host requirement (singleSourceVerified). Two providers that AGREE
// also verify (canVerify). What is NEVER trusted is a provider's own self-claim of evidence - only
// the app's EvidenceVerifier output decides. Anything short -> suggested / needs_review. Provider
// disagreement is a conflict.

const PUBLIC_BARCODE_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14"];

export interface DecodeParams {
  codeType: CodeType;
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  confidenceThreshold: number;
  code?: string; // the exact scanned code, for deterministic brand-prefix-family corroboration
  scanContext?: "any" | "tire"; // business scan context; "tire" enables deterministic tire corroboration
  // GENERAL catalog-derived brand sanity (owner baseline v1): true when the code's prefix is a known
  // single-brand family in the global catalog AND the decoded brand clearly differs (wrong brand for
  // this barcode). Computed by the caller via prefixBrandConflict(); blocks every auto-count path.
  brandPrefixConflict?: boolean;
  // OPTION 3 (owner): when true, a NON-public code (vendor_label/internal/sku/part-number/FNSKU/alphanumeric)
  // may auto-verify from a single app-verified source (incl. a trusted retailer/barcode-DB url_only) - "found
  // it on Amazon = enough". Default off in this pure fn; the route passes the user setting (default on). The
  // brand-prefix firewall, 0.8 threshold, non-empty identity, and app-verified evidence all still apply, so
  // an evidence-LESS guess never reaches it (Velvet Torch stays dead).
  allowNonPublicAutoCount?: boolean;
}

// --- Product-name quality gate (junk firewall) ------------------------------------------------
// Providers and page scrapes sometimes hand back a website/search/error page TITLE, an AI hedge,
// or a placeholder instead of a real product. None of these may be trusted or auto-added.

// Hedge parentheticals/tails like "(likely wholesale listing)" or "- exact variant unknown".
const HEDGE_PAREN = /\s*\((?:likely|possibly|probably|maybe|uncertain|unverified|unconfirmed|best guess|guess|approx\.?|exact variant unknown|variant unknown|wholesale listing)[^)]*\)/gi;
const HEDGE_TAIL = /\s*[-–—]\s*(?:exact variant unknown|variant unknown|unverified|unconfirmed|best guess)\s*$/i;

// Barcode-site / search / error / store-nav titles that are NOT products.
// "search for", "suchergebnisse" (German search results), "codecheck", "upc database" observed live
// verifying as products in the 2026-07-04 ladder dry run (barcode-list.com "Search For:<code>",
// codecheck.info "CodeCheck - Suchergebnisse", upcdatabase.org "UPC Database | <code>").
const SITE_BLOCKLIST =
  /\b(upc barcode search|barcode lookup|look ?up any (upc|ean|isbn)|go-?upc|upcitemdb|barcodefinder|barcode finder|barcodespider|barcodes? database|barcode database|upc database|ean-?search|eandata|barcodes?\.(com|net|org)|gtin ?lookup|buy ?upc|product ?lookup|barcode ?india|barcodable|scandit|codecheck|search results|search for|suchergebnisse?|results for|page not found|404 (not found|error)|error 404|add to cart|your cart|shopping cart|all categories)\b/i;
const PLACEHOLDER_NAME = /^\s*(unknown|unidentified|n\/a)\b|no (public )?match|not found|no result/i;

// A SCRAPED page can hand back an error / bot-challenge / maintenance TITLE (e.g. "Error", "Error 500",
// "Just a moment", "Access Denied", "Attention Required"). Anchored to the WHOLE name (^...$) so a real
// product that merely CONTAINS a word (e.g. "Error Coin 1955 Double Die") is not blocked. Observed live:
// a scrape titled "Error" auto-counted as a Verified product (2026-07-01).
const SCRAPE_ERROR_TITLE =
  /^(?:error(?:\s*\d{3})?|oops|access denied|forbidden|unauthorized|just a moment|attention required|are you (?:a )?(?:human|robot)|(?:please )?enable javascript|service unavailable|bad gateway|gateway timeout|temporarily unavailable|(?:site )?under maintenance)\s*$/i;

// AI REFUSAL sentences returned as if they were product names ("Unable to identify product for
// UPC ...", "... is not a recognized product ..."). Observed live in the preview mass-scan bots
// (reports/human-bots/preview-mass-scan, 2026-07-01) where they auto-counted as Verified rows.
// A refusal is an answer SHAPE, never a product identity - reject it everywhere.
const REFUSAL_NAME =
  /\b(?:unable to (?:identify|find|determine|locate)|cannot (?:identify|find|determine|locate)|can(?:no|')t (?:identify|find|determine|locate)|could not (?:identify|find|determine|locate)|not a recognized product|not recognized as a product|does not (?:correspond|match|appear)|no product (?:information|match|listing)|no information (?:is )?available)\b/i;

// Nutrition-facts DB page titles ("Nutrition Facts for <brand> - <product>", "<product> by <brand>
// nutrition facts and analysis."). These sites map RECYCLED UPCs to the wrong same-brand product
// (2026-07-04 dry run: Lay's <-> Munchies identity swap), so their titles never name a product here.
const NUTRITION_DB_TITLE = /^\s*nutrition facts for\b|\bnutrition facts (?:and analysis|for)\b/i;

// Barcode-site title cruft appended after a separator (incl. em/en dash), e.g.
// "Bic Lighter Texas — UPC 70330645936 — Go-UPC" or "Widget | Barcode Lookup".
const TITLE_CODE_SUFFIX = /\s*[|–—-]\s*(?:upc|ean|gtin|isbn|barcode)\b[\s\S]*$/i;
// Leading code cruft ("UPC 745125495781 - Manstel Rivet Kit"): stripped so the real product behind it
// survives the code-echo check below.
const TITLE_CODE_PREFIX = /^\s*(?:upc|ean|gtin|isbn|barcode)?[\s#:]*\d{8,14}\s*[|–—:-]\s*/i;
const TITLE_SITE_SUFFIX =
  /\s*[|–—-]\s*(?:barcode lookup|upcitemdb|go-?upc|buycott|barcodespider|barcode ?finder|barcodes? ?database|ean-?search|eandata|barcodes?\.(?:com|net|org)|gtin ?lookup)\b[\s\S]*$/i;

/** Strip AI hedges + barcode-site title cruft; keep real descriptors like "(Texas)" and hyphens. */
export function cleanProductName(name: string): string {
  return (name ?? "")
    .replace(HEDGE_PAREN, "")
    .replace(HEDGE_TAIL, "")
    .replace(TITLE_CODE_SUFFIX, "")
    .replace(TITLE_SITE_SUFFIX, "")
    .replace(TITLE_CODE_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True only for a clean, real product name (not a website title, hedge, placeholder, or junk).
 * When the scanned `code` is passed, a name that still CONTAINS that code after cleaning is
 * rejected: search/lookup pages echo the queried code in their title ("Search For:<code>",
 * "UPC Database | <code>"), and a real product name never carries the full barcode.
 */
export function isUsableProductName(raw: string, code?: string): boolean {
  const name = cleanProductName(raw);
  if (name.length < 3 || name.length > 120) return false;
  if (PLACEHOLDER_NAME.test(name)) return false;
  if (REFUSAL_NAME.test(name)) return false;
  if (SCRAPE_ERROR_TITLE.test(name)) return false;
  if (SITE_BLOCKLIST.test(name)) return false;
  if (NUTRITION_DB_TITLE.test(name)) return false;
  if (/^https?:\/\//i.test(name) || /^[a-z0-9.-]+\.(com|org|net|io)\b/i.test(name)) return false; // bare domain/url
  if (code) {
    const digits = code.replace(/\D/g, "");
    const echoes = [code.trim(), digits, digits.padStart(12, "0"), digits.padStart(13, "0"), digits.padStart(14, "0")]
      .filter((v) => v.length >= 8); // short fragments would false-positive on sizes/quantities
    if (echoes.some((v) => name.includes(v))) return false;
  }
  return true;
}

function identityOf(r: AiLookupResult, code?: string): string {
  const name = isUsableProductName(r.productName, code) ? cleanProductName(r.productName) : "";
  return `${name} ${r.brand}`.trim();
}

export function decideDecode(params: DecodeParams): DecodeDecision {
  const { codeType, confidenceThreshold, code, scanContext } = params;
  const present = params.results.filter((r) => r && identityOf(r, code).length > 0);
  const a = present[0] ?? null;
  const b = present[1] ?? null;
  const cc = crossCheck(a, b);

  const bestEvidence = strongestEvidence(params.evidences);
  const strong = isStrongEvidence(bestEvidence);
  // PLAN C (owner rule): the catalog-derived brand-prefix conflict is ADVISORY, not a hard block. GS1
  // prefixes are many-to-one, so a brand-prefix mismatch alone must NEVER block a verify when the app
  // independently confirmed the EXACT code in STRONG evidence (grounding/corpus wins over the prefix).
  // It still blocks weaker verify paths (no strong app-verified exact-code evidence). The CATEGORY /
  // poison guard (wrong product TYPE) is separate (scanContextFirewall) and STAYS a hard block downstream.
  const prefixBlocks = !!params.brandPrefixConflict && !strong;
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

  // canVerify: the two-provider AGREEMENT path - both providers independently land on the same identity.
  // This is ONE of several verify paths (NOT the only one); the single-source path below
  // (singleSourceVerified) auto-counts a lone app-verified provider without a second one.
  const canVerify =
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    passesThreshold &&
    !prefixBlocks &&
    cc.decision === "agree";

  // SINGLE SOURCE (owner policy, supersedes the old two-provider / trusted-only rules): one provider
  // (e.g. Gemini Flash) is enough to auto-count when the app independently verified the EXACT code in
  // strong evidence (the code appears in a real snippet / grounding chunk / fetched page) - ANY source,
  // not just a trusted-tier site. Catalog-miss fallback for ANY item. Still rejects vendor/label code
  // types, weak/unverified evidence, and below-threshold (those stay "suggested" -> human review). The
  // downstream identity firewall + >=0.8 store gate still apply.
  const singleSourceVerified =
    isPublicBarcode &&
    strong &&
    identityNonEmpty &&
    passesThreshold &&
    !prefixBlocks &&
    !!a &&
    (cc.decision === "single_provider" || cc.decision === "agree");

  // OPTION 3 (owner) - NON-PUBLIC single trusted source. A SKU/part-number/vendor/internal/FNSKU/alphanumeric
  // code auto-verifies when the app independently confirmed the EXACT code in a real source - INCLUDING a
  // single TRUSTED retailer / barcode-DB url_only (verifyEvidence returns verified:true for trusted hosts),
  // so a product found on Amazon/Walmart/Go-UPC etc. is enough ("found it on Amazon = enough"). Uses
  // bestEvidence.verified (NOT isStrongEvidence) so a trusted-host url_only counts. Same hard floors as the
  // public path: >= threshold, non-empty identity, NO brand-prefix conflict, single/agreeing provider. An
  // evidence-LESS guess (verified===false) never reaches it, so Velvet Torch stays dead. Off unless the owner
  // setting is on (route passes it; default on).
  const nonPublicTrustedVerified =
    params.allowNonPublicAutoCount === true &&
    !isPublicBarcode &&
    bestEvidence.verified &&
    identityNonEmpty &&
    passesThreshold &&
    !prefixBlocks &&
    !!a &&
    (cc.decision === "single_provider" || cc.decision === "agree");

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
  // the >=0.8 store gate still apply downstream, so a non-tire (poison) can never reach a count this way.
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
  // deterministically (public GS1 fact, not AI text). a.sizeAgreement is set ONLY by the app's own route-side
  // two-source race (compares a grounded-search size vs an independent page-fetch size) - it is NEVER an AI
  // self-claim, so it cannot be injected by a provider. That app-computed agreement is the second independent
  // source, so - BY DESIGN, and unlike the three paths above - this path intentionally does NOT require the
  // `strong` app-verified exact-code evidence; two independent Internet sources agreeing on the size IS the
  // corroboration (owner-approved Internet-only path). The local DB is never consulted. Poison / non-tire /
  // weak-prefix / single-source (sizeAgreement !== true) can never satisfy it; weak exact-code evidence CAN,
  // which is the intended relaxation.
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

  // BRAND SANITY (Plan C, owner rule): a catalog-derived brand-prefix conflict is ADVISORY, not a hard
  // block. It only vetoes a verify when the app did NOT confirm the exact code in STRONG evidence
  // (prefixBlocks). With strong app-verified exact-code evidence, grounding/corpus wins over the prefix,
  // so a brand-prefix mismatch alone never blocks. The CATEGORY / poison guard is enforced separately
  // (scanContextFirewall) and still blocks a wrong-product-TYPE identity downstream.
  if (!prefixBlocks && (canVerify || singleSourceVerified || tireCorroborated || pageFetchModelAgreement || internetTwoSourceSize || nonPublicTrustedVerified)) {
    const corroborationPath = canVerify
      ? "two_ai_agreement"
      : singleSourceVerified
        ? "single_source"
        : tireCorroborated
          ? "deterministic_prefix"
          : pageFetchModelAgreement
            ? "page_fetch_model_agreement"
            : internetTwoSourceSize
              ? "internet_two_source_size"
              : "non_public_trusted_source";
    return {
      status: "verified",
      confidence: Math.min(1, Math.max(maxConfidence, cc.confidence)),
      reason: canVerify
        ? "Verified AI Decode: both providers independently agree and the app confirmed the exact code in real evidence."
        : singleSourceVerified
          ? "Verified AI Decode: the app confirmed the exact code in a real source (one source is enough)."
          : tireCorroborated
            ? "Verified AI Decode: tire corroborated by the barcode's strong brand-prefix family + size + model + app-verified exact code (independent of the AI text)."
            : pageFetchModelAgreement
              ? "Verified AI Decode: the app's page-fetch and an independent model read agree on the tire identity, with size + model + app-verified exact code."
              : internetTwoSourceSize
                ? "Verified AI Decode: brand from the strong GS1 prefix and two independent Internet sources agree on the size."
                : "Verified AI Decode: the app confirmed the exact code in a trusted source (one trusted source is enough for this code type).",
      evidenceStrength: bestEvidence.strength,
      exactCodeEvidenceVerifiedByApp: canVerify || singleSourceVerified || tireCorroborated || pageFetchModelAgreement || nonPublicTrustedVerified,
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
