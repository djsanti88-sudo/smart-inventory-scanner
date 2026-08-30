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

/**
 * The identifier tiers, in priority order, shared by matchProductByIdentifiers and
 * collectAllIdentifierHits. These were duplicated verbatim in both functions; the two MUST agree,
 * because a tier present in one and missing from the other makes the two disagree about which
 * product a code belongs to, and wrong identity is a product failure (see Resolver Trust Rules).
 * One definition makes that class of drift impossible.
 */
const IDENTIFIER_TIERS: Array<{ type: MatchType; pick: (p: Product) => string | undefined }> = [
  { type: "primary_barcode", pick: (p) => p.primaryBarcode },
  { type: "primary_sku", pick: (p) => p.primarySku },
  { type: "gtin", pick: (p) => p.gtin },
  { type: "upc", pick: (p) => p.upc },
  { type: "ean", pick: (p) => p.ean },
];

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

  for (const tier of IDENTIFIER_TIERS) {
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
 * Same field tiers as matchProductByIdentifiers, but collects hits from EVERY tier instead of
 * early-returning at the first one that resolves. Used only by resolveScanToProductTiered (D5),
 * which must see a lower-priority-tier disagreement even when a higher-priority tier already hit.
 * Same trust gate as matchProductByIdentifiers: only verified products' identifiers participate.
 */
function collectAllIdentifierHits(
  cleaned: CleanedCode,
  products: Product[],
  businessId: string,
): Array<{ productId: string; matchType: MatchType; matchedOn: string }> {
  const scoped = products.filter((p) => p.businessId === businessId && p.verified === true);
  const candidates = uniq([cleaned.cleanCode, ...cleaned.normalizedCandidates]);
  const hit = (field: string | undefined) => candidatesInclude(candidates, field);

  const out: Array<{ productId: string; matchType: MatchType; matchedOn: string }> = [];
  for (const tier of IDENTIFIER_TIERS) {
    for (const p of scoped) {
      const field = tier.pick(p);
      if (hit(field)) out.push({ productId: p.id, matchType: tier.type, matchedOn: field as string });
    }
  }

  for (const p of scoped) {
    const vendorHit = p.vendorCodes?.find((v) => candidatesInclude(candidates, v));
    if (vendorHit) out.push({ productId: p.id, matchType: "normalized_alias", matchedOn: vendorHit });
  }

  return out;
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

// Resolver tier interface (P2, cross-tier conflict logic added P5/D5). Presents tenant truth (the
// account's own products/aliases) and, in a slot, master truth (corpus/catalogEntries candidates
// carrying a provenanceTier). The master slot stays EMPTY in production until P5b supplies a real
// feed; this function's collect-all-then-conflict logic is proven here with synthetic candidates.
export type MasterCandidate = { productId: string; matchedOn: string; provenanceTier: ProvenanceTier };
export type TierInput = { products: Product[]; aliases: Alias[]; masterCandidates?: MasterCandidate[] };

// Tier priority, highest to lowest, ONLY used to pick the reported matchType/matchedOn when every
// tier that produced a hit agrees on the SAME product (never used to break a genuine disagreement -
// any distinct productId anywhere is a conflict, full stop).
const TIER_RESULT_PRIORITY: ScanResolution["matchType"][] = [
  "exact_alias",
  "normalized_alias",
  "primary_barcode",
  "primary_sku",
  "gtin",
  "upc",
  "ean",
];

/**
 * D5: collect ALL trusted matches across tiers (alias table, product identifiers, and any supplied
 * master candidates) before deciding known-vs-conflict. Never short-circuits at the first non-null
 * tier - a code that resolves cleanly within one tier can still disagree with another tier, and that
 * disagreement MUST become a conflict, never a silent first-match guess.
 *
 *   0 distinct productIds  -> fall through to the existing no-match ("unknown") shape.
 *   1 distinct productId   -> known; matchType/matchedOn taken from the highest-priority tier that
 *                             produced it (tier priority applies ONLY when every tier agrees).
 *   >1 distinct productIds -> conflict, productId null, conflictProductIds sorted-unique.
 *
 * Does NOT weaken the underlying trust gates: matchAlias/matchProductByIdentifiers still only ever
 * consider `alias.approved === true` / `product.verified === true` records.
 */
export function resolveScanToProductTiered(
  cleaned: CleanedCode,
  input: TierInput,
  businessId: string,
): ScanResolution {
  const aliasRes = matchAlias(cleaned, input.aliases, businessId);

  // Candidate hits, each carrying the matchType/matchedOn that would apply IF this were the only
  // tier that resolved. A same-tier conflict (matchAlias already collapsed a tier's own ambiguity
  // into "conflict") contributes ALL of its conflicting productIds (never just one), so a same-tier
  // ambiguity is never silently dropped when merged with other tiers. Identifier-tier hits are
  // collected from EVERY field tier (not just the first that resolves), so a lower-priority tier's
  // disagreement with a higher-priority tier is never missed.
  const candidates: Array<{ productId: string; matchType: ScanResolution["matchType"]; matchedOn: string | null }> = [];

  const addResolution = (res: ScanResolution | null) => {
    if (!res) return;
    if (res.matchType === "conflict") {
      for (const pid of res.conflictProductIds ?? []) {
        candidates.push({ productId: pid, matchType: "conflict", matchedOn: null });
      }
      return;
    }
    if (res.productId) candidates.push({ productId: res.productId, matchType: res.matchType, matchedOn: res.matchedOn });
  };

  addResolution(aliasRes);
  for (const idHit of collectAllIdentifierHits(cleaned, input.products, businessId)) {
    candidates.push(idHit);
  }
  for (const mc of input.masterCandidates ?? []) {
    candidates.push({ productId: mc.productId, matchType: mc.provenanceTier === "human_verified" ? "exact_alias" : "gtin", matchedOn: mc.matchedOn });
  }

  const distinctProductIds = uniq(candidates.map((c) => c.productId));

  if (distinctProductIds.length === 0) return NO_MATCH;

  if (distinctProductIds.length === 1) {
    const productId = distinctProductIds[0];
    // Every tier agrees on this product - pick the highest-priority matchType/matchedOn among the
    // tiers that actually produced a (non-conflict) hit for it.
    const hitsForProduct = candidates.filter((c) => c.productId === productId && c.matchType !== "conflict");
    let best = hitsForProduct[0] ?? candidates.find((c) => c.productId === productId)!;
    for (const c of hitsForProduct) {
      if (TIER_RESULT_PRIORITY.indexOf(c.matchType) < TIER_RESULT_PRIORITY.indexOf(best.matchType)) best = c;
    }
    return { matchType: best.matchType, productId, matchedOn: best.matchedOn };
  }

  return {
    matchType: "conflict",
    productId: null,
    matchedOn: null,
    conflictProductIds: distinctProductIds.slice().sort(),
  };
}
