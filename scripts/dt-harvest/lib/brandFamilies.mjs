// scripts/dt-harvest/lib/brandFamilies.mjs
// Node-runnable reimplementation of src/services/catalog/brandFamilies.ts's sameBrandFamily + the
// curated FAMILIES table, so the .mjs harvest pipeline (which plain `node` cannot import TS into)
// can consult the same corporate-family firewall the runtime uses. Reimplemented rather than
// imported for the same reason lib/backfill.mjs reimplements normPartKey: this .mjs cannot import
// the server-only TS module.
//
// CRITICAL: the FAMILIES list below MUST stay byte-for-byte equivalent (after normalization) to the
// FAMILIES in src/services/catalog/brandFamilies.ts. A drift-guard vitest test
// (brandFamilies.drift.test.ts) imports BOTH this .mjs and the .ts source and asserts identical
// family membership, so the two can never silently diverge. Wrong/duplicated family data would
// cause a FALSE product-identity merge, which is worse than leaving codes unrecovered - do not edit
// this table without editing the .ts in lockstep and re-running the drift test.
//
// Pure, no imports. See the .ts source for the per-family evidence and evidence-class comments.

/** @type {readonly string[][]} Curated same-company / shared-distributor-prefix groups. */
export const FAMILIES = [
  ["bridgestone", "firestone", "dayton"],
  ["goodyear", "kelly", "cooper", "mastercraft", "roadmaster", "mickey thompson"],
  ["carlstar", "carlisle"],
  ["argus", "advanta"],
  ["michelin", "bfgoodrich", "uniroyal"],
  ["continental", "general"],
  ["toyo", "nitto"],
  ["sumitomo", "falken", "ohtsu"],
  ["hankook", "laufenn"],
  // EVIDENCE CLASS: distributor-shared-prefix - Tireco owns Milestar, exclusively distributes Westlake.
  ["milestar", "westlake"],
  // EVIDENCE CLASS: common-ownership - Shandong Linglong owns both Green Max and Atlas.
  ["green max", "atlas"],
  // EVIDENCE CLASS: distributor-shared-prefix - Taskmaster Components distributes Provider + Diamondback.
  ["taskmaster", "provider", "diamondback"],
];

/** Same brand-normalization as the firewall / the .ts source so lookups line up. */
function norm(b) {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Precompute a normalized brand -> family-index map for O(1) lookup (mirrors the .ts).
const BRAND_TO_FAMILY = new Map();
FAMILIES.forEach((family, i) => {
  for (const brand of family) BRAND_TO_FAMILY.set(norm(brand), i);
});

/**
 * True when `a` and `b` are the SAME corporate family per the curated table (after normalization).
 * Identical brands trivially match. Unknown brands (not in any family) never match unless they
 * normalize identically - absence of family data must NOT invent a relationship. Byte-for-byte the
 * same logic as src/services/catalog/brandFamilies.ts's sameBrandFamily (enforced by the drift test).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameBrandFamily(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = BRAND_TO_FAMILY.get(na);
  const fb = BRAND_TO_FAMILY.get(nb);
  return fa !== undefined && fa === fb;
}
