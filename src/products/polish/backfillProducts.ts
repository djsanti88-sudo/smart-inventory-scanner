// Build 2 / Task 4: pure backfill transform reused by scripts/polish-backfill.mts (offline JSON
// snapshots) and the scanStore persist migration (real users' browser-local data - see scanStore.ts
// `migrate` v5 -> v6). Pure, no React/next/fs imports so it is unit-testable and safe on both sides.

// NOTE: relative + explicit ".ts" extensions - see structuredFields.ts for why (this module is also
// imported directly, standalone, by scripts/polish-backfill.mts under plain `node`).
import { safeStructuredFieldsFor } from "./structuredFields.ts";
import { enrichProductIdentity } from "../catalog/enrichProductIdentity.ts";
import { brandIsOnlyFloorGuess } from "../catalog/prefixFloorEnrich.ts";
import type { Product } from "../../types.ts";

export interface BackfillResult {
  products: Product[];
  changedIds: string[];
  skippedHumanIds: string[];
}

/**
 * Applies deterministic structuring to every product NOT already marked `structuredBy: "human"`.
 * Idempotent: structureProduct is a pure function of (name, brand), so running this twice on the
 * same input yields the same output and an empty `changedIds` the second time.
 *
 * Task 2 (owner-reported live bug, 2026-07-20): also runs the SAME shared enrichProductIdentity
 * helper the live decode/suggestion apply sites use, fill-if-empty, so a row saved BEFORE that fix
 * shipped (blank brand/category/specsShort/specsFull despite a parseable name, e.g. "Falken Azenis
 * RT660 P 245 /40 R18 97W XL BSW") gets its structured columns filled retroactively on the next
 * rehydrate. Never overwrites a field the row already carries a non-empty value for (human-entered
 * or an earlier decode already won) - same fill-if-empty contract as the live apply sites.
 *
 * Group C item 11 (owner mandate 2026-07-21): also re-cleans a legacy JUNKY `name` into the app's
 * own canonical tire display form via that SAME enrichProductIdentity call (its `name` output is the
 * canonical form whenever brand+model+size confidently parse and the row is not multiVariant, else
 * the existing cleanListingTitle output - see enrichProductIdentity.ts). Applied unconditionally
 * (not fill-if-empty) since a NAME rewrite is a cleanup, not a "field was empty" backfill - but never
 * for a `structuredBy: "human"` row (skipped above) and never a no-op change when the name is
 * already in canonical/clean form (naturally idempotent, since cleanListingTitle/canonicalTireDisplayName
 * are pure functions of the current name).
 */
export function backfillProducts(products: Product[]): BackfillResult {
  const changedIds: string[] = [];
  const skippedHumanIds: string[] = [];

  const updated = products.map((p) => {
    if (p.structuredBy === "human") {
      skippedHumanIds.push(p.id);
      return p;
    }
    // MEDIUM review finding (2026-08-05, follow-up to commit cd9e7c51 "floor-guess brands never beat
    // verified decode identity (class fix)"): that commit propagated `existingBrandIsFloorGuess` to
    // the three scanStore.ts apply sites but missed this 4th call site - which runs on EVERY
    // localStorage rehydrate (scanStore's migrate v5->v6) and scripts/polish-backfill.mts. A row
    // already poisoned by the floor-guess bug (a non-empty statistical GS1-prefix guess, e.g.
    // "Coca-Cola" for a 049000-prefixed Michelin) has a non-empty `p.brand`, so the old unconditional
    // `!p.brand` gate below never even considered healing it. Computed once here so both the
    // enrichProductIdentity call and the widened brand-patch gate share the exact same signal.
    const brandIsFloorGuess = brandIsOnlyFloorGuess(p.name, p.primaryBarcode);
    // Identity-field fill-if-empty backfill (brand/category/specsShort/specsFull) runs FIRST, parsed
    // from the name when the row itself carries nothing - so the structurer pass right below sees
    // the SAME (already brand-filled) input on every run, keeping the whole function idempotent from
    // the first call (a brand backfilled on pass 1 must not change what pass 2's structurer sees).
    const enriched = enrichProductIdentity({
      payload: { name: p.name },
      existing: { name: p.name, brand: p.brand, category: p.category, specsShort: p.specsShort, specsFull: p.specsFull },
      existingBrandIsFloorGuess: brandIsFloorGuess,
    });
    const identityPatch: Partial<Product> = {};
    // Widened (not just `!p.brand`): a floor-guess-poisoned brand must also heal, but ONLY when
    // enrichment actually derives a DIFFERENT real brand from the row's own name/decode fields - a
    // floor guess with no better data available (`enriched.brand` still "" or unchanged) must stay
    // exactly as-is (the naming aid is preserved, never blanked or churned into a no-op "change").
    if ((!p.brand || brandIsFloorGuess) && enriched.brand && enriched.brand !== p.brand) {
      identityPatch.brand = enriched.brand;
    }
    if (!p.category && enriched.category) identityPatch.category = enriched.category;
    if (!p.specsShort && enriched.specsShort) identityPatch.specsShort = enriched.specsShort;
    if (!p.specsFull && enriched.specsFull) identityPatch.specsFull = enriched.specsFull;
    // Name re-clean (Group C item 11): enriched.name is already the canonical display form for a
    // confidently-parsed row, or the cleaned listing title otherwise - always safe to adopt when it
    // differs from the stored name (never fabricates anything new; it is a pure re-derivation of the
    // SAME name string already on the row).
    if (enriched.name && enriched.name !== p.name) identityPatch.name = enriched.name;
    const withIdentity: Product = Object.keys(identityPatch).length > 0 ? { ...p, ...identityPatch } : p;

    // safeStructuredFieldsFor (not structuredFieldsFor): a structurer throw on one bad row must
    // never brick the whole backfill (persist hydration on real users' data, or this CLI's run).
    const patch = safeStructuredFieldsFor(withIdentity.name, withIdentity.brand, p.structuredBy);
    let next: Product = { ...withIdentity, ...patch };
    if (!next.structuredModel && enriched.structuredModel) next = { ...next, structuredModel: enriched.structuredModel };

    const changed =
      next.structuredBrand !== p.structuredBrand ||
      next.structuredModel !== p.structuredModel ||
      next.structuredDescription !== p.structuredDescription ||
      next.sizeTag !== p.sizeTag ||
      next.structuredBy !== p.structuredBy ||
      next.brand !== p.brand ||
      next.category !== p.category ||
      next.specsShort !== p.specsShort ||
      next.specsFull !== p.specsFull ||
      next.name !== p.name;
    if (changed) changedIds.push(p.id);
    return next;
  });

  return { products: updated, changedIds, skippedHumanIds };
}
