// enrichProductIdentity.ts - the SINGLE shared enrichment helper for every identity-apply site in
// scanStore.ts (suggestion auto-apply, "(suggested)" inline path, verified auto-count, the
// decode-complete feed-row update, resolveUnknown's three mint/reuse/upgrade branches, universal
// import). Pure, no React/next imports - matches the CLAUDE.md "services stay pure and testable"
// convention.
//
// Owner-reported live bug (2026-07-20, deployed preview): a counted row showed name "Falken Azenis
// RT660 P 245 /40 R18 97W XL BSW (suggested)" for barcode 848983017918, but Brand/Model/Category/
// Specs/Size table columns were all blank even though the size (245/40R18), load/speed (97W), and
// sidewall (BSW) markers are all cleanly parseable from the name. A prior fix (commit 0570ca9) added
// this fill-if-empty + name-parse behavior ONLY inside resolveUnknown's "reuse existing product"
// branch - every other apply site (including the fresh-mint branch the owner's single-scan bug row
// actually took) kept writing a decode payload's raw structured fields verbatim with no fallback.
//
// Rule (matches Resolver Trust Rules / "prefer blank over wrong"): the payload's OWN structured
// field always wins when present. When it is empty, parse the (cleaned) name via
// parseTireIdentity/canonicalTireSize - never guess; an unparseable name yields "", same as the
// payload having nothing. Fill-if-empty only: the caller passes the row's EXISTING current values,
// and this helper only proposes overwriting a field that is still empty on that existing row (a
// human edit or an earlier decode already won).

import { cleanListingTitle, parseTireIdentity, canonicalTireSize } from "@/services/catalog/tireListingNormalizer";

export type ProductIdentityPayload = {
  name?: string;
  brand?: string;
  category?: string;
  specsShort?: string;
  specsFull?: string;
};

export type ProductIdentityExisting = {
  name?: string;
  brand?: string;
  category?: string;
  specsShort?: string;
  specsFull?: string;
};

export type EnrichedProductIdentity = {
  name: string;
  brand: string;
  category: string;
  specsShort: string;
  specsFull: string;
  /** Parsed model/line text (e.g. "Azenis RT660") - maps to Product.structuredModel at call sites
   *  that track it separately from `name`. "" when nothing confidently parses. */
  structuredModel: string;
  /** True when the source name describes a LISTING covering multiple product variants (e.g.
   *  several speed ratings for one size) rather than one confident product identity. Call sites
   *  must force human review and never auto-apply/auto-count when this is true. */
  multiVariant: boolean;
};

function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    if (v && v.trim()) return v;
  }
  return "";
}

/** Build a human-readable specsFull string from parsed tire-identity parts when the payload/existing
 *  row carries no specsFull at all. Never fabricates: only includes parts that were actually parsed. */
function synthesizeSpecsFull(size: string, loadSpeed: string, sidewall: string): string {
  const parts: string[] = [];
  if (size) parts.push(size);
  if (loadSpeed) parts.push(loadSpeed);
  if (sidewall) parts.push(sidewall);
  return parts.join(" ");
}

/**
 * Assemble the ONE canonical tire display name the app itself owns: "<Brand> <Model> <Size>
 * <LoadSpeed> <Sidewall>", omitting empty parts, single-space-joined. Never fabricates: a part
 * missing from the parse is simply left out, never guessed.
 */
export function canonicalTireDisplayName(parts: {
  brand: string;
  model: string;
  size: string;
  loadSpeed: string;
  sidewall: string;
}): string {
  return [parts.brand, parts.model, parts.size, parts.loadSpeed, parts.sidewall]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Compute the normalized identity fields to apply at a decode/suggestion apply site, with
 * fill-if-empty semantics baked in: a field already non-empty on `existing` is always preserved.
 */
export function enrichProductIdentity(args: {
  payload: ProductIdentityPayload;
  existing?: ProductIdentityExisting;
}): EnrichedProductIdentity {
  const { payload } = args;
  const existing = args.existing ?? {};

  const rawName = payload.name ?? existing.name ?? "";
  const cleanName = cleanListingTitle(rawName) || rawName;

  const parsed = parseTireIdentity(rawName);
  const parsedSize = canonicalTireSize(rawName) || parsed.size;

  const brand = (existing.brand && existing.brand.trim())
    ? existing.brand
    : firstNonEmpty(payload.brand, parsed.brand);

  // Confident tire parse: brand AND model AND size all present, and not a multi-variant listing
  // page. Only then does the app replace raw listing text with its OWN assembled canonical name -
  // never for an unconfident parse (keeps the existing cleanListingTitle output unchanged).
  const confidentTireParse = Boolean(brand && parsed.model && parsedSize) && !parsed.multiVariant;

  const name = confidentTireParse
    ? canonicalTireDisplayName({ brand, model: parsed.model, size: parsedSize, loadSpeed: parsed.loadSpeed, sidewall: parsed.sidewall })
    : cleanName;

  // Category default requires a size PLUS either a brand or a model (never fabricated from a bare
  // size alone). multiVariant does NOT gate this - a listing's brand+size identity is still
  // trustworthy as "a Tire" even when the exact variant model/rating is ambiguous.
  const tireCategoryConfident = Boolean(parsedSize && (brand || parsed.model));

  const category = (existing.category && existing.category.trim())
    ? existing.category
    : firstNonEmpty(payload.category) || (tireCategoryConfident ? "Tire" : "");

  const specsShort = (existing.specsShort && existing.specsShort.trim())
    ? existing.specsShort
    : firstNonEmpty(
        payload.specsShort,
        parsed.loadSpeed ? [parsedSize, parsed.loadSpeed, parsed.sidewall].filter(Boolean).join(" ") : parsedSize,
      );

  const specsFull = (existing.specsFull && existing.specsFull.trim())
    ? existing.specsFull
    : firstNonEmpty(payload.specsFull, synthesizeSpecsFull(parsedSize, parsed.loadSpeed, parsed.sidewall));

  const structuredModel = parsed.model ?? "";

  return { name, brand, category, specsShort, specsFull, structuredModel, multiVariant: parsed.multiVariant };
}
