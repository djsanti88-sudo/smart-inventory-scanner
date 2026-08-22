import type { AiLookupResult, CodeType, DecodeDecision, EvidenceResult } from "@/types";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { isStrongEvidence, strongestEvidence } from "@/services/ai/evidenceVerifier";
import { isTireContext, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
import { isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";
import { isTrustedProductHost } from "@/services/ai/trustedProductHosts";

// decideDecode: the gate that turns provider results + APP-verified evidence into a final decode
// status. MASTER BASELINE v1 (owner-locked, supersedes the older two-provider rule): a "verified"
// decode (auto-counted) requires ALL of:
//   - public barcode code type (never X00/FNSKU/vendor_label/internal_code/messy)
//   - strong app-verified evidence (snippet / grounding_chunk / fetched_source), set by the app
//   - non-empty product identity
//   - confidence >= threshold (baseline 0.8)
//   - NO catalog-derived brand-prefix conflict
// A single source can be enough when the app independently
// verified to contain the EXACT code in strong evidence auto-counts ("one source is enough") - no
// second provider and no trusted-host requirement (singleSourceVerified). Two providers that AGREE
// also verify (canVerify). What is NEVER trusted is a provider's own self-claim of evidence - only
// the app's EvidenceVerifier output decides. Anything short -> suggested / needs_review. Provider
// disagreement is a conflict.

const PUBLIC_BARCODE_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14"];

// LANE C ITEM C3 (owner data review, 2026-07-20): a suggestion with confidence EXACTLY 0 has no signal
// behind it at all - live regression 6959956718368 stored "Pneu 195X40 R17 81V - LINGLONG ...
// (suggested, 0%)" because both maxConfidence and cc.confidence were 0, so `Math.max(0*0.6, 0*0.6)`
// computed exactly 0. A confidence of 0 must never be treated as "this identity was suggested with
// some (if weak) signal" - it reads to a human reviewer as "the app found nothing", which is honest,
// but storing/showing it as a numeric "0%" on an otherwise-named suggestion misrepresents it as an
// evaluated-and-rejected guess rather than "no signal". Floor every suggestion's confidence at this
// minimum so a suggestion is never indistinguishable from a hard needs_review with 0 confidence. Only
// RAISES a computed value that would otherwise round to (near) zero; never lowers a stronger signal.
export const MIN_SUGGESTION_CONFIDENCE = 0.2;

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
// verifying as products in an earlier evidence dry run (barcode-list.com "Search For:<code>",
// codecheck.info "CodeCheck - Suchergebnisse", upcdatabase.org "UPC Database | <code>").
const SITE_BLOCKLIST =
  /\b(upc barcode search|barcode lookup|look ?up any (upc|ean|isbn)|go-?upc|upcitemdb|barcodefinder|barcode finder|barcodespider|barcodes? database|barcode database|upc database|ean-?search|eandata|barcodes?\.(com|net|org)|gtin ?lookup|buy ?upc|product ?lookup|barcode ?india|barcodable|scandit|codecheck|search results|search for|suchergebnisse?|results for|page not found|404 (not found|error)|error 404|add to cart|your cart|shopping cart|all categories)\b/i;
const PLACEHOLDER_NAME = /^\s*(unknown|unidentified|n\/a)\b|no (public )?match|not found|no result/i;

// A SCRAPED page can hand back an error / bot-challenge / maintenance TITLE (e.g. "Error", "Error 500",
// "Just a moment", "Access Denied", "Attention Required"). Anchored to the WHOLE name (^...$) so a real
// product that merely CONTAINS a word (e.g. "Error Coin 1955 Double Die") is not blocked. Observed live:
// a scrape titled "Error" auto-counted as a Verified product (2026-07-01).
const SCRAPE_ERROR_TITLE =
  /^(?:error(?:\s*\d{3})?|oops|access denied|forbidden|unauthorized|just a moment|attention required(?:\s*[|!].*)?|are you (?:a )?(?:human|robot)|robot check|(?:please )?enable javascript|service unavailable|bad gateway|gateway timeout|temporarily unavailable|(?:site )?under maintenance)\s*$/i;

// LANE C ITEM C1 (owner data review, 268-code stress batch, 2026-07-20): a client-side or CDN 404/
// error-page TITLE passed the junk gate whole and was stored as a product identity for 721749249238
// ("We couldn't find this page" - a curly-apostrophe React/Next.js style 404 title, not caught by any
// existing pattern since it names neither "404" nor "not found" literally). This is a SEPARATE, NOT
// whole-name-anchored pattern (unlike SCRAPE_ERROR_TITLE) because "not found"/"not available" phrasing
// can appear mid-sentence in a page's error copy, not only as the entire title. Covers the exact live
// string plus the owner-named localized/provider variants ("page not found", "404", "not available",
// "access denied", "robot check", "attention required").
const ERROR_PAGE_NAME_RE =
  /\b(?:we (?:couldn['’]?t|can['’]?t|could not|cannot) find (?:this|that|the) page|(?:this|that) page (?:is(?:n['’]?t| not)|does not exist|cannot be found)|page not found|404(?:\s*(?:error|not found))?|not available\b|access denied|robot check|attention required)\b/i;

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
  if (ERROR_PAGE_NAME_RE.test(name)) return false;
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

// --- Example/test-row firewall (QA hardening fix #5, 2026-07-16) -----------------------------
// The 4M-row Open Food Facts retail corpus is a crowdsourced dump that includes literal GS1-standard
// TEXTBOOK EXAMPLE barcodes and demo/placeholder rows contributed by testers, ingested VERBATIM by
// scripts/build-retail-knowledge.mjs (which only checks barcode shape + name length - never checks for
// a test/example row). Live-proven: 4006381333931 -> "Test Shopidoo", 5901234123457 -> "Sauce
// chiltepin"/"La lumbre", 0012345670121/0012345674020/0012345674037 -> brand "Healthyholics", plus rows
// literally named "Test"/"Fakeer"/"Fakewine"/"BrandTest". A confident retail-rung match on one of these
// is a WRONG IDENTITY, which is worse than Unidentified. This is a READ-TIME guard (not a corpus edit):
// it rejects the hit and falls through to an honest "no identity", never a leaked "test row" reason.

// EXACT-VALUE barcode blocklist. Deliberately NOT a fuzzy prefix (e.g. never `/^0012345/`) - a fuzzy
// prefix could suppress a real GTIN that happens to share the same leading digits. Every entry here is
// either a well-known GS1/ISBN textbook example, a degenerate shape (all-zero/all-same-digit/fully
// sequential), or one of the exact live-proven Healthyholics example codes.
const EXAMPLE_BARCODE_BLOCKLIST = new Set<string>([
  "012345678905", // classic GS1 UPC-A textbook example
  "4006381333931", // classic GS1/GTIN EAN-13 textbook example ("Test Shopidoo")
  "5901234123457", // classic GS1 EAN-13 textbook example ("Sauce chiltepin" / "La lumbre")
  "0012345670121", // documented Healthyholics example GTIN
  "0012345674020", // documented Healthyholics example GTIN
  "0012345674037", // documented Healthyholics example GTIN
]);

/** Zero-pad `code` to 12/13/14 digits, mirroring retailKnowledgeIndex.ts's barcodeVariants so the same
 *  normalized shapes that the retail lookup itself tries are checked against the blocklist. */
function exampleBarcodeVariants(code: string): string[] {
  const digits = code.replace(/\D/g, "");
  if (!digits) return [];
  const stripped = digits.replace(/^0+/, "") || "0";
  const variants = new Set<string>([digits, stripped]);
  for (const base of [digits, stripped]) {
    if (base.length <= 14) variants.add(base.padStart(14, "0"));
    if (base.length <= 13) variants.add(base.padStart(13, "0"));
    if (base.length <= 12) variants.add(base.padStart(12, "0"));
  }
  return [...variants];
}

/** True for an all-zero, all-same-digit, or fully-sequential barcode shape (degenerate placeholder,
 *  never a real product's GTIN). Checked on the raw digit string, not zero-padded variants, so a
 *  genuinely short real code is never coincidentally caught by padding. */
function isDegenerateBarcodeShape(digits: string): boolean {
  if (!digits) return false;
  if (/^0+$/.test(digits)) return true; // all-zero (any length 8-14)
  if (/^(\d)\1+$/.test(digits)) return true; // all-same-digit (e.g. 1111111111111)
  if (digits === "0123456789012" || digits === "1234567890128") return true; // fully sequential GS1 examples
  return false;
}

// WHOLE-WORD strong test/demo markers. Word-boundary anchored so "Latest"/"Testarossa"/"contest"/
// "attesting" never false-positive - only a standalone marker word matches.
const TEST_NAME_PATTERN =
  /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;

/**
 * True when a retail-corpus row is a textbook GS1 EXAMPLE barcode or a demo/test/placeholder row that
 * must never be surfaced as a confident product match. Checks the barcode (exact-value blocklist +
 * degenerate shapes, using the same zero-pad normalization the retail index itself uses) OR the name OR
 * the brand (whole-word test/demo markers). Pure function: no I/O, no imports beyond what this module
 * already has.
 */
export function isExampleOrTestRow(code: string, name: string, brand?: string): boolean {
  const digits = (code ?? "").replace(/\D/g, "");
  if (digits && isDegenerateBarcodeShape(digits)) return true;
  const variants = exampleBarcodeVariants(code ?? "");
  if (variants.some((v) => EXAMPLE_BARCODE_BLOCKLIST.has(v))) return true;
  if (name && TEST_NAME_PATTERN.test(name)) return true;
  if (brand && TEST_NAME_PATTERN.test(brand)) return true;
  return false;
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
  // is enough to auto-count when the app independently verified the exact code in
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
  // so a product found on a commercial listing can be enough. Uses
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
    const exactCodeEvidenceVerifiedByApp = canVerify || singleSourceVerified || tireCorroborated || pageFetchModelAgreement || nonPublicTrustedVerified;
    const computedConfidence = Math.min(1, Math.max(maxConfidence, cc.confidence));

    // TASK 21 (owner-ratified 2026-07-15): TRUSTED-SOURCE CONFIDENCE FLOOR. One LEGIT source
    // (manufacturer site, Walmart, Target, Discount Tire, Tire Rack class) that the app itself
    // FETCHED and independently confirmed carries the exact code deserves near-certain confidence -
    // 0.95, never higher (retail pages still carry a small wrong-UPC rate; human override stays
    // supreme, so this NEVER floors to a literal 1.0) and never LOWER than whatever was already
    // computed (a stronger signal must never be pulled down to the floor). The floor applies ONLY
    // when ALL of these hold simultaneously:
    //   - evidence strength is "fetched_source" (the app actually retrieved and read the page -
    //     "strong association" for a fetched-source result, since earlier source scoring
    //     (scoring.ts) only ever emits a verified fetched_source evidence off a strong-association
    //     winner - a snippet/grounding_chunk/url_only match never qualifies, no matter how trusted
    //     the host, because the app never actually fetched and read that page);
    //   - exactCodeEvidenceVerifiedByApp is true (the APP's own verifier confirmed the code, never
    //     the model's self-claim);
    //   - the winning source URL's host is on the curated trusted-product allowlist
    //     (trustedProductHosts.ts - major retailers + the KNOWN_TIRE_BRANDS manufacturer domains);
    //   - there is NO catalog-derived brand-prefix conflict (params.brandPrefixConflict) - a wrong
    //     brand for this barcode's GS1 prefix must never be floored to near-certain, even if a
    //     trusted host happened to also confirm the code (a recycled/scanned-wrong-item case).
    const trustedFetchedSource =
      bestEvidence.strength === "fetched_source" &&
      exactCodeEvidenceVerifiedByApp &&
      !params.brandPrefixConflict &&
      (bestEvidence.matchedSources ?? []).some((u) => isTrustedProductHost(u));
    const confidence = trustedFetchedSource ? Math.max(computedConfidence, 0.95) : computedConfidence;

    return {
      status: "verified",
      confidence,
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
      exactCodeEvidenceVerifiedByApp,
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
      confidence: Math.max(maxConfidence * 0.6, cc.confidence * 0.6, MIN_SUGGESTION_CONFIDENCE),
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
