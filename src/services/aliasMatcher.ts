import type { Alias, CleanedCode, MatchType, Product, ProvenanceTier, ScanResolution } from "@/types";

// Deterministic alias matching. THE heart of the product. No AI here, ever.
// One product can own many scannable codes; any of them must resolve to the same product.
//
// Match priority (most to least specific):
//   1. exact raw/clean alias match            -> "exact_alias"
//   2. normalized candidate alias match        -> "normalized_alias"
//   3. product primary barcode                 -> "primary_barcode"
//   4. product primary SKU                      -> "primary_sku"
//   5. product GTIN / UPC / EAN                 -> "gtin" | "upc" | "ean"
//   6. no deterministic match                   -> "unknown" (route to Needs Review)
//
// Rules enforced here:
//   - All matching is scoped by businessId.
//   - matchType is labeled ACCURATELY (never collapse a barcode/gtin match into "sku").
//   - If a single code maps to MORE THAN ONE product within a tier, return "conflict"
//     (never guess) so the caller routes it to Needs Review.

const NO_MATCH: ScanResolution = { matchType: "unknown", productId: null, matchedOn: null };

function uniq(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}

/** Uppercase fold for CASE-INSENSITIVE comparison only. Never used to mutate stored/displayed
 *  values - callers still store/echo the original cleanCode/rawCode untouched. A case-only
 *  difference (e.g. scanned "t432119" vs a stored alias "T432119") is the SAME identity.
 *
 *  QA ROUND-2 (unit-adversarial): folds ASCII letters ONLY. `.toUpperCase()` EXPANDS certain
 *  non-ASCII codepoints ("straße".toUpperCase() === "STRASSE"), which could collapse a scanned
 *  "straße" into an unrelated "STRASSE" SKU - a codepoint-expansion false merge. Mapping only [a-z]
 *  keeps every non-ASCII byte a single, untouched codepoint, so it can never expand into different
 *  ASCII. Plain ASCII case-insensitivity (the only kind real barcode/SKU codes need) is preserved. */
function foldCase(v: string | undefined | null): string {
  return (v ?? "").replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** True when any candidate equals `field`, case-insensitively. */
function candidatesInclude(candidates: string[], field: string | undefined): boolean {
  if (!field) return false;
  const folded = foldCase(field);
  return candidates.some((c) => foldCase(c) === folded);
}

/** Reduce a tier's hits to a resolution: 0 -> null, 1 distinct product -> match, >1 -> conflict. */
function pickTier(
  hits: Array<{ productId: string; matchedOn: string }>,
  matchType: MatchType,
): ScanResolution | null {
  if (hits.length === 0) return null;
  const byProduct = new Map<string, string>();
  for (const h of hits) if (!byProduct.has(h.productId)) byProduct.set(h.productId, h.matchedOn);

  if (byProduct.size === 1) {
    const [productId, matchedOn] = [...byProduct.entries()][0];
    return { matchType, productId, matchedOn };
  }
  return {
    matchType: "conflict",
    productId: null,
    matchedOn: null,
    conflictProductIds: [...byProduct.keys()],
  };
}

/** Tier 1+2: match against the APPROVED alias table only. Unapproved aliases never yield "known". */
export function matchAlias(
  cleaned: CleanedCode,
  aliases: Alias[],
  businessId: string,
): ScanResolution | null {
  // Trust gate: only approved aliases participate in deterministic matching.
  const scoped = aliases.filter((a) => a.businessId === businessId && a.approved === true);
  const candidates = uniq([cleaned.cleanCode, ...cleaned.normalizedCandidates]);

  // Tier 1: exact raw or exact clean code. Case-insensitive: a case-only difference (scanned
  // "t432119" vs stored "T432119") is the SAME identity, not a lower tier and not a miss.
  const exact = scoped
    .filter(
      (a) =>
        foldCase(a.rawCodeExample) === foldCase(cleaned.rawCode) ||
        foldCase(a.cleanCode) === foldCase(cleaned.cleanCode),
    )
    .map((a) => ({ productId: a.productId, matchedOn: a.cleanCode || a.rawCodeExample }));
  const exactRes = pickTier(exact, "exact_alias");
  if (exactRes) return exactRes;

  // Tier 2: any normalized candidate equals a stored alias value, case-insensitively.
  const norm = scoped
    .filter(
      (a) =>
        candidatesInclude(candidates, a.cleanCode) ||
        candidatesInclude(candidates, a.normalizedCode) ||
        candidatesInclude(candidates, a.rawCodeExample),
    )
    .map((a) => ({ productId: a.productId, matchedOn: a.cleanCode || a.normalizedCode }));
  return pickTier(norm, "normalized_alias");
}

/** Tier 3-5: match against a product's own identifier fields, labeled by which field hit. */
export function matchProductByIdentifiers(
  cleaned: CleanedCode,
  products: Product[],
  businessId: string,
): ScanResolution | null {
  // Trust gate: only VERIFIED products' identifiers yield "known". AI-created (unverified)
  // products can never be matched by identifier - they must be human-approved first.
  const scoped = products.filter((p) => p.businessId === businessId && p.verified === true);
  const candidates = uniq([cleaned.cleanCode, ...cleaned.normalizedCandidates]);
  const hit = (field: string | undefined) => candidatesInclude(candidates, field);

  const tiers: Array<{ type: MatchType; pick: (p: Product) => string | undefined }> = [
    { type: "primary_barcode", pick: (p) => p.primaryBarcode },
    { type: "primary_sku", pick: (p) => p.primarySku },
    { type: "gtin", pick: (p) => p.gtin },
    { type: "upc", pick: (p) => p.upc },
    { type: "ean", pick: (p) => p.ean },
  ];

  for (const tier of tiers) {
    const hits = scoped
      .filter((p) => hit(tier.pick(p)))
      .map((p) => ({ productId: p.id, matchedOn: tier.pick(p) as string }));
    const res = pickTier(hits, tier.type);
    if (res) return res;
  }

  // Also check vendorCodes as a low-priority identifier match (labeled normalized_alias-ish).
  // Case-insensitive, same rationale as the tiers above.
  const vendorHits = scoped
    .filter((p) => p.vendorCodes?.some((v) => candidatesInclude(candidates, v)))
    .map((p) => ({
      productId: p.id,
      matchedOn: p.vendorCodes.find((v) => candidatesInclude(candidates, v)) as string,
    }));
  return pickTier(vendorHits, "normalized_alias");
}

/**
 * Full resolution: alias table first, then product identifier fields. Returns "unknown" when
 * nothing matches (caller routes to Needs Review) and "conflict" when a tier is ambiguous.
 */
export function resolveScanToProduct(
  cleaned: CleanedCode,
  products: Product[],
  aliases: Alias[],
  businessId: string,
): ScanResolution {
  const aliasRes = matchAlias(cleaned, aliases, businessId);
  if (aliasRes) return aliasRes;

  const idRes = matchProductByIdentifiers(cleaned, products, businessId);
  if (idRes) return idRes;

  return NO_MATCH;
}

/** True when a resolution means the scan needs human attention (unknown or conflicting). */
export function needsReview(resolution: ScanResolution): boolean {
  return resolution.matchType === "unknown" || resolution.matchType === "conflict";
}

// Resolver tier interface (P2). Presents tenant truth (the account's own products/aliases) and, in a
// slot, master truth (corpus/catalogEntries candidates carrying a provenanceTier). In P2 the master slot
// is CARRIED but not compared - it exists so P5 can add cross-tier conflict detection (D5) without
// re-plumbing callers. P2 outcome is identical to resolveScanToProduct (tenant tiers only, short-circuit
// preserved). Do NOT add conflict logic here; that is P5.
export type MasterCandidate = { productId: string; matchedOn: string; provenanceTier: ProvenanceTier };
export type TierInput = { products: Product[]; aliases: Alias[]; masterCandidates?: MasterCandidate[] };

export function resolveScanToProductTiered(
  cleaned: CleanedCode,
  input: TierInput,
  businessId: string,
): ScanResolution {
  // P2: tenant-only resolution, unchanged. masterCandidates intentionally unused until P5 (D5).
  void input.masterCandidates;
  return resolveScanToProduct(cleaned, input.products, input.aliases, businessId);
}
