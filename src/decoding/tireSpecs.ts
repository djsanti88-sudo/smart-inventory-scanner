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

// Metric / P-metric / LT sizes: 275/55R20, LT265/70R17, P225/60R17, 225/60ZR17. Also accept the dash
// notation some barcode DBs use (245/65-17) - it is the SAME size, just a different separator; the spec
// COMPLETENESS check still independently requires a load index + speed rating, so this never relaxes specs.
const METRIC_SIZE = /\b(LT|P|ST)?\d{3}\/\d{2}\s?(Z?R|-)\s?\d{2}\b/i;
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

/** The normalized tire SIZE token (e.g. "245/75R16"), spaces removed + uppercased, or "" if none. Used to
 *  require two independent extractions to agree on the EXACT size before treating them as corroborating. */
export function tireSizeToken(r: IdentityText | null | undefined): string {
  const t = haystack(r);
  const m = t.match(METRIC_SIZE) || t.match(COMMERCIAL_SIZE);
  if (!m) return "";
  // Canonicalize the separator (dash -> R) so "245/65-17" and "245/65R17" compare equal.
  return m[0].replace(/\s+/g, "").replace(/(\d{2})-(\d{2})$/, "$1R$2").toUpperCase();
}

/** The tire load index + speed rating token (e.g. "115T", "94V", "111/110T"), spaces removed + uppercased,
 *  or "" if none. Read AFTER the size is removed so the size's own "R" is never mistaken for a speed letter -
 *  same removal order hasRequiredTireSpecs() uses. Reuses the existing LOAD_SPEED regex (no new pattern). */
export function tireLoadSpeedToken(r: IdentityText | null | undefined): string {
  const t = haystack(r).replace(METRIC_SIZE, " ").replace(COMMERCIAL_SIZE, " ");
  const m = t.match(LOAD_SPEED);
  return m ? m[0].replace(/\s+/g, "").toUpperCase() : "";
}

/**
 * Infer a tire brand from a product NAME when the structured brand field is empty. Barcode-DB page titles
 * (e.g. "Cooper Discoverer A/T3 ... 245/75R16") carry the brand in the name but not in a separate field,
 * which left brand="" and blocked the brand-prefix-family corroboration check. This is a deterministic,
 * read-only extraction (the brand literally appears in the title) - it never invents a brand and only
 * matches the small hand-verified KNOWN_TIRE_BRANDS list, so it cannot weaken any trust gate. Returns the
 * matched brand as it appears in the name, or "".
 */
export function inferTireBrandFromName(name: string): string {
  const src = name ?? "";
  const lower = src.toLowerCase();
  // Longest brand names first so "general tire" / "gt radial" win over a shorter accidental substring.
  for (const b of [...KNOWN_TIRE_BRANDS].sort((x, y) => y.length - x.length)) {
    const i = lower.indexOf(b);
    if (i < 0) continue;
    const before = i === 0 || /[^a-z0-9]/.test(lower[i - 1]);
    const after = i + b.length >= lower.length || /[^a-z0-9]/.test(lower[i + b.length]);
    if (before && after) return src.slice(i, i + b.length);
  }
  return "";
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

// Common non-model noise words to strip when isolating the model name.
const TIRE_NOISE = /\b(tires?|tyres?|radial|all[- ]?season|all[- ]?terrain|mud[- ]?terrain|highway|touring|performance|passenger|new|set of \d+|lt|p|st|xl|bsw|owl|rwl)\b/gi;

/** The model/line name remaining in the product name after removing brand, size, load/speed and noise. */
export function tireModelToken(r: IdentityText | null | undefined): string {
  const name = (r?.productName ?? "");
  let rest = name.replace(METRIC_SIZE, " ").replace(COMMERCIAL_SIZE, " ").replace(LOAD_SPEED, " ");
  const brand = (r?.brand && r.brand.trim()) || inferTireBrandFromName(name);
  if (brand) rest = rest.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  rest = rest.replace(TIRE_NOISE, " ").replace(/[^A-Za-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();
  const words = rest.split(" ").filter((w) => w.replace(/[^A-Za-z0-9]/g, "").length >= 3);
  return words.join(" ");
}

/** A usable model/line name is present (e.g. "Defender", "Discoverer AT3"). */
export function hasTireModel(r: IdentityText | null | undefined): boolean {
  return tireModelToken(r).length >= 3;
}

/** Countable tire identity for inventory: a size AND a model name. Brand comes from the GS1 prefix, not
 *  this check, and load index + speed rating are optional enrichment (not required to count). */
export function hasCountableTireIdentity(r: IdentityText | null | undefined): boolean {
  return hasTireSize(r) && hasTireModel(r);
}
