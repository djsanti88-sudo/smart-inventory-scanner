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

/** Collapse a run of consecutive duplicate whitespace-separated tokens (case-insensitive) down to
 *  one occurrence, e.g. "Greenball Greenball Greenball Tow-Master" -> "Greenball Tow-Master". Only
 *  ADJACENT repeats collapse (never removes a legitimately repeated word elsewhere in a real model). */
function collapseConsecutiveDuplicateTokens(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    if (out.length > 0 && out[out.length - 1].toLowerCase() === t.toLowerCase()) continue;
    out.push(t);
  }
  return out.join(" ");
}

/** When `model`'s LEADING whitespace-separated token run already equals `brand`'s own tokens
 *  (case-insensitive) - i.e. the model text already starts with the brand, so prepending the brand
 *  again would duplicate it - returns the model with that leading brand-token run stripped (the
 *  genuine remaining model text, if any). Otherwise returns `model` unchanged. Handles a multi-word
 *  brand ("Van Den Ban") the same as a single-word one. */
function stripLeadingBrandFromModel(model: string, brand: string): string {
  const brandTokens = brand.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  if (brandTokens.length === 0) return model;
  const modelTokens = model.trim().split(/\s+/).filter(Boolean);
  if (modelTokens.length < brandTokens.length) return model;
  const leadsWithBrand = brandTokens.every((t, i) => modelTokens[i].toLowerCase() === t);
  if (!leadsWithBrand) return model;
  return modelTokens.slice(brandTokens.length).join(" ");
}

/**
 * Assemble the ONE canonical tire display name the app itself owns: "<Brand> <Model> <Size>
 * <LoadSpeed> <Sidewall>", omitting empty parts, single-space-joined. Never fabricates: a part
 * missing from the parse is simply left out, never guessed.
 *
 * Bug 4 fix (CRITICAL mechanism, owner mandate 2026-07-21): assembly is now idempotent and never
 * duplicates the brand. Live-observed: "Greenball Greenball Greenball Tow-Master", "Goodyear Farm
 * Made By Titan Farm Made By Titan" - each enrichment pass (apply-site, then backfill, then any
 * re-apply) prepended ANOTHER copy of the brand because the model text already started with it (or
 * already carried a baked-in duplicate run from a prior pass). Fixed at the single assembly
 * chokepoint: (a) never prepend the brand when the model already begins with it, (b) collapse any
 * existing consecutive duplicate token run in the model first, so a row damaged by an earlier buggy
 * pass self-heals on the next enrich rather than accumulating further.
 */
export function canonicalTireDisplayName(parts: {
  brand: string;
  model: string;
  size: string;
  loadSpeed: string;
  sidewall: string;
}): string {
  const brand = (parts.brand ?? "").trim();
  const dedupedModel = collapseConsecutiveDuplicateTokens((parts.model ?? "").trim());
  const model = brand ? stripLeadingBrandFromModel(dedupedModel, brand) : dedupedModel;
  return [brand, model, parts.size, parts.loadSpeed, parts.sidewall]
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
  // Bug 4 fix (owner mandate 2026-07-21): collapse a consecutive duplicate token run (e.g. a brand
  // repeated by an earlier buggy enrichment pass, "Greenball Greenball Greenball Tow-Master") at the
  // GENERAL name level too - not just inside the confident-tire canonical-assembly path - so a
  // brand-duplicated row self-heals on re-enrich even when brand+model+size don't all confidently
  // parse (e.g. no known tire brand, no size at all).
  const cleanName = collapseConsecutiveDuplicateTokens(cleanListingTitle(rawName) || rawName);

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

  // Category default requires a size PLUS either a KNOWN tire brand or extra tire-specific
  // corroboration (a load/speed rating or a sidewall marker) - never a bare size plus arbitrary
  // leftover "model" text alone. multiVariant does NOT gate this - a listing's brand+size identity is
  // still trustworthy as "a Tire" even when the exact variant model/rating is ambiguous.
  //
  // (Bug 2c fix, owner mandate 2026-07-21): `parsed.model` used to satisfy this on its own - but
  // parseTireIdentity ALWAYS returns SOME leftover non-noise text as "model" for almost any input, so
  // that check degraded to "any parsedSize alone", tire-ifying non-tire products whose text happened
  // to contain a coincidentally range-plausible size (live-observed: "Rivet Kit 195 65 15 Pieces" and
  // an essential-oil bottle both got category "Tire"). A load/speed rating or sidewall marker is
  // tire-specific corroboration a rivet-count or a volume/ml label essentially never produces.
  const tireCategoryConfident = Boolean(parsedSize && (brand || parsed.loadSpeed || parsed.sidewall));

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

  // Bug 4 fix: dedupe the same way as the display name - structuredModel must never carry a
  // duplicated brand-token run baked in by an earlier buggy pass either.
  const dedupedParsedModel = collapseConsecutiveDuplicateTokens(parsed.model ?? "");
  const structuredModel = brand ? stripLeadingBrandFromModel(dedupedParsedModel, brand) : dedupedParsedModel;

  return { name, brand, category, specsShort, specsFull, structuredModel, multiVariant: parsed.multiVariant };
}
