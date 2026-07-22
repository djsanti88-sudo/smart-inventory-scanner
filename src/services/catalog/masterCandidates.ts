// masterCandidates.ts (Phase 5b, Task 3) - pure, client-safe transform from a single master-catalog
// hit (the store's CatalogEntry, read via its optional masterId/masterProvenanceTier fields per the
// GC4 boundary extension) into the MasterCandidate[] shape resolveScanToProductTiered accepts.
//
// GC1 (hard invariant, review F3): the resolver folds every MasterCandidate.productId into the SAME
// distinctProductIds set as real tenant products (aliasMatcher.ts:269-273). A masterCandidates array
// whose only entries are "master:"-prefixed ids with ZERO tenant-origin candidates would make
// resolveScanToProductTiered mint a phantom "known" result pointing at a product id this account does
// not own. So: ZERO tenant candidates for this code -> return [] (never emit a lone master candidate).
//
// Semantics:
//   - find the tenant candidate product already resolvable for this code (reuse
//     resolveScanToProductTiered with an empty master slot - the exact same deterministic tenant-only
//     resolution logic every other caller relies on, never reimplemented here);
//   - none -> [] (GC1 hard invariant);
//   - identity AGREES (brand family-aware equality + name Jaccard >= IDENTITY_JACCARD_THRESHOLD) ->
//     a candidate carrying the EXISTING tenant product id (agreement reinforces, never conflicts);
//   - identity DISAGREES -> a candidate carrying the "master:"+masterId namespace tag, so the resolver
//     sees a genuinely distinct id and emits a real conflict.
//
// Pure, sync, no I/O, no React imports - safe to import from client code (Task 4's scanStore wiring).

import { resolveScanToProductTiered, type MasterCandidate } from "@/services/aliasMatcher";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import { nameTokens, jaccard, IDENTITY_JACCARD_THRESHOLD } from "@/services/catalog/identityMerge";
import { tireSizeToken } from "@/services/ai/tireSpecs";
import type { Product, Alias, CleanedCode, ProvenanceTier } from "@/types";

/** The subset of the store CatalogEntry shape this transform needs (GC4 boundary: masterId /
 *  masterProvenanceTier are the optional fields catalogTypes.CatalogEntry gains in Task 4). */
export interface MasterHit {
  masterId: string;
  name?: string;
  brand?: string;
  masterProvenanceTier?: ProvenanceTier;
}

/** True when two brand+name identities are the SAME product per the app's existing identity rules:
 *  brand-family-aware equality (curated same-company groups, e.g. Michelin/BFGoodrich) AND EITHER
 *  name token-Jaccard similarity at or above the app's single canonical threshold, OR the SUBSET
 *  rule: every token of the sparser (fewer-token) name, after dropping the brand's own tokens, is
 *  contained in the richer name's token set. The subset rule exists because corpus master names are
 *  SLUGS ("wrangler_steadfast_ht") while tenant names are rich strings ("Goodyear Wrangler Steadfast
 *  HT 265/70R17") - plain Jaccard is diluted by the size/brand tokens the slug never had a chance to
 *  match, producing a false conflict on the exact same product. Brand-empty on both sides is treated
 *  as "brands agree" (nothing to disagree about) so a name-only match can still land. */
function identitiesAgree(aName: string | undefined, aBrand: string | undefined, bName: string | undefined, bBrand: string | undefined): boolean {
  const an = (aName ?? "").trim();
  const bn = (bName ?? "").trim();
  const ab = (aBrand ?? "").trim();
  const bb = (bBrand ?? "").trim();

  // Empty master name: never conflict, never agree - emit nothing (caller returns [] on !agree only
  // when the caller itself special-cases this; here we simply refuse to call it agreement, and the
  // caller's empty-name guard upstream keeps this path from ever reaching a "master:" candidate).
  if (!an || !bn) return false;

  const brandsAgree = (!ab && !bb) || sameBrandFamily(ab, bb);
  if (!brandsAgree) return false;

  // Size-aware DISAGREEMENT (max-review): corpus law says same-model-DIFFERENT-SIZE is a DISTINCT
  // product (identityMerge is size-aware; CLAUDE.md identity-merge rule). Name-Jaccard and the subset
  // rule can BOTH false-agree a long, verbose model name that differs only by size (e.g. Jaccard clears
  // 0.75 because the two size-derived tokens are a small fraction of a 12+ token name). So: if BOTH
  // sides carry a parseable tire size token and the tokens DIFFER, the identities DISAGREE outright.
  // If only one side (or neither) has a size token, the size is indeterminate and behavior is unchanged
  // (a slug-without-size vs rich-with-size stays agree-eligible via the subset rule below). Reuses the
  // existing tireSizeToken extractor (tireSpecs.ts) rather than minting a new size regex.
  const aSize = tireSizeToken({ productName: an, brand: ab });
  const bSize = tireSizeToken({ productName: bn, brand: bb });
  if (aSize && bSize && aSize !== bSize) return false;

  const aTokens = nameTokens(an);
  const bTokens = nameTokens(bn);

  const sim = jaccard(aTokens, bTokens);
  if (sim >= IDENTITY_JACCARD_THRESHOLD) return true;

  // Subset rule: drop each side's own brand tokens (so "goodyear" in the rich name doesn't count
  // against the sparser slug), then check whether the sparser token set is fully contained in the
  // richer one. Order-independent: try both directions since we don't know which side is the slug.
  // "+"-joined tokens (e.g. "t+h") are also split into their component letters for this comparison
  // only, since a hyphenated slug ("t-h") naturally tokenizes to separate "t"/"h" tokens while the
  // rich name's nameTokens() keeps "t+h" fused - both spellings mean the same product line.
  const splitPlus = (tokens: string[]) => tokens.flatMap((t) => (t.includes("+") ? t.split("+").filter(Boolean) : [t]));
  const brandTokens = new Set([...nameTokens(ab), ...nameTokens(bb)]);
  const stripBrand = (tokens: string[]) => splitPlus(tokens).filter((t) => !brandTokens.has(t));
  const aStripped = stripBrand(aTokens);
  const bStripped = stripBrand(bTokens);

  const isSubset = (sparse: string[], rich: string[]) => sparse.length > 0 && sparse.every((t) => rich.includes(t));

  if (aStripped.length <= bStripped.length) {
    return isSubset(aStripped, bStripped);
  }
  return isSubset(bStripped, aStripped);
}

/**
 * GC1 semantics (see file header). `tenantProducts`/`aliases` are the current store state for this
 * account; `cleaned` is the scanned code being resolved.
 */
export function toMasterCandidates(
  hit: MasterHit,
  tenantProducts: Product[],
  aliases: Alias[],
  cleaned: CleanedCode,
  businessId: string,
): MasterCandidate[] {
  // Find the tenant candidate product already resolvable for this code, using the SAME
  // tenant-only tiered resolution every other caller uses (empty master slot - never reimplemented).
  const tenantOnly = resolveScanToProductTiered(cleaned, { products: tenantProducts, aliases, masterCandidates: [] }, businessId);

  // HARD INVARIANT (GC1 / review F3): no resolvable tenant candidate for this code -> emit nothing.
  // A lone "master:"-namespaced candidate with zero tenant-origin candidates would make the resolver
  // mint a phantom "known" result; the existing cloudCatalogResolve enrichment already owns that case.
  if (!tenantOnly.productId) return [];

  const tenantProduct = tenantProducts.find((p) => p.id === tenantOnly.productId);
  // Defensive: the resolver returned an id but it is not in the supplied product list (should not
  // happen in practice - resolveScanToProductTiered only ever returns ids drawn from tenantProducts
  // when masterCandidates is empty). Treat as "no tenant candidate" rather than trusting an id we
  // cannot verify.
  if (!tenantProduct) return [];

  // Empty master name: never conflict, never agree - safest is to emit nothing rather than mint a
  // "master:" disagreement candidate off an identity we cannot compare at all.
  if (!(hit.name ?? "").trim()) return [];

  const tier: ProvenanceTier = hit.masterProvenanceTier ?? "corpus_verified";
  const agree = identitiesAgree(hit.name, hit.brand, tenantProduct.name, tenantProduct.brand);

  if (agree) {
    return [{ productId: tenantProduct.id, matchedOn: cleaned.cleanCode, provenanceTier: tier }];
  }

  return [{ productId: `master:${hit.masterId}`, matchedOn: cleaned.cleanCode, provenanceTier: tier }];
}
