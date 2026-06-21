// Architecture Version: v1.0.0
//
// tireSpecs.ts (Phase 7) - detect tire context and require a COMPLETE tire identity (size + load index +
// speed rating) before a tire decode is allowed to auto-count. Heuristic detection + a small VERIFIED
// brand list (never a fabricated bulk table). A tire missing its size is not a usable inventory product.

// Minimal identity shape the tire/domain heuristics read. Both AiLookupResult and a stored Product
// (mapped name -> productName) satisfy it, so the SAME checks can guard the AI decode path and the
// deterministic (already-known) count path. Phase 8C.
export type IdentityText = {
  productName?: string;
  brand?: string;
  category?: string;
  specsShort?: string;
  specsFull?: string;
};

// Small, hand-verified list of real tire brands (used only to recognise tire context, e.g. "Falken
// Wildpeak AT" which never contains the word "tire"). Not a manufacturer-prefix table.
export const KNOWN_TIRE_BRANDS = [
  "falken", "nexen", "michelin", "bridgestone", "goodyear", "continental", "pirelli", "yokohama",
  "hankook", "kumho", "toyo", "cooper", "bfgoodrich", "firestone", "dunlop", "general tire", "nitto",
  "sailun", "nokian", "maxxis", "kenda", "hercules", "ironman", "mastercraft", "uniroyal", "sumitomo",
  "gt radial", "atturo", "milestar", "lexani",
];

// Metric / P-metric / LT sizes: 275/55R20, LT265/70R17, P225/60R17, 225/60ZR17.
const METRIC_SIZE = /\b(LT|P|ST)?\d{3}\/\d{2}\s?Z?R\s?\d{2}\b/i;
// Commercial / flotation: 11R22.5, 295/75R22.5, 35X12.5R20.
const COMMERCIAL_SIZE = /\b\d{2}(\.\d)?(X\d{2}(\.\d)?)?R\d{2}(\.\d)?\b/i;
// Load index (2-3 digits, optional dual) + speed-rating letter as a standalone token: 111T, 111/110T, 116 S.
const LOAD_SPEED = /\b\d{2,3}(\/\d{2,3})?\s?[A-Z]\b/;

function haystack(r: IdentityText | null | undefined): string {
  if (!r) return "";
  return [r.productName, r.brand, r.category, r.specsShort, r.specsFull].filter(Boolean).join(" ");
}

/** A tire size pattern (metric or commercial) appears anywhere in the result text. */
export function hasTireSize(r: IdentityText | null | undefined): boolean {
  const t = haystack(r);
  return METRIC_SIZE.test(t) || COMMERCIAL_SIZE.test(t);
}

/** Tire context if the decode looks tire-related at all: keyword, a size pattern, or a known tire brand. */
export function isTireContext(r: IdentityText | null | undefined): boolean {
  const t = haystack(r).toLowerCase();
  if (/\btires?\b|\btyres?\b/.test(t)) return true;
  if (hasTireSize(r)) return true;
  return KNOWN_TIRE_BRANDS.some((b) => t.includes(b));
}

/**
 * Full tire identity present: size + (load index & speed rating). Commercial sizes may stand alone.
 * The size token is removed before scanning for load/speed so the size's own "R" is not mistaken for a
 * speed rating.
 */
export function hasRequiredTireSpecs(r: IdentityText | null | undefined): boolean {
  const t = haystack(r);
  if (!hasTireSize(r)) return false;
  const isCommercial = COMMERCIAL_SIZE.test(t) && !METRIC_SIZE.test(t);
  if (isCommercial) return true; // commercial/flotation: a valid size is sufficient
  const rest = t.replace(METRIC_SIZE, " ").replace(COMMERCIAL_SIZE, " ");
  return LOAD_SPEED.test(rest); // consumer/LT metric: require load index + speed rating too
}
