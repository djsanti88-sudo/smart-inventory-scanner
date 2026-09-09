import brandPrefixMap from "./brandPrefixMap.json";

// GENERAL (not tire-only) catalog-derived brand sanity. The map is generated from the global catalog
// (scripts/_genprefix): a 7-digit GS1 company-prefix bucket -> its single unambiguous brand. Only
// buckets with >=3 entries that are 100% ONE brand are kept, so false-blocks are near zero, and it
// grows automatically as the catalog grows (re-run the generator after a re-import). This is the
// owner's "brand sanity on everything" baseline rule: it is product-type agnostic - any cataloged
// brand family protects its prefix, not just tires.

const MAP = brandPrefixMap as Record<string, string>;

export function normalizeBrand(b: string | undefined): string {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, strip non-alphanumeric, split on whitespace, and keep tokens of length >= 3. Shared by
 *  the prefix firewall's category-token matching and the reverse UPC-set guard's name-overlap check. */
export function tokenize(s: string | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3);
}

/**
 * True ONLY when the scanned code's prefix is a KNOWN single-brand prefix AND the decoded brand is
 * clearly NOT that brand (wrong brand for this barcode). Unknown prefixes and empty brands never
 * conflict, so non-cataloged product types and unbranded results are unaffected. Tolerant on brand
 * spelling (shared leading token counts as a match, e.g. "Cooper" vs "Cooper Trendsetter").
 */
export function prefixBrandConflict(code: string | undefined, brand: string | undefined): boolean {
  const digits = (code || "").replace(/\D/g, "");
  if (digits.length < 8) return false;
  const expected = MAP[digits.slice(0, 7)];
  if (!expected) return false;
  const got = normalizeBrand(brand);
  if (!got) return false;
  if (got === expected) return false;
  const e0 = expected.split(" ")[0];
  const g0 = got.split(" ")[0];
  if (e0 && got.includes(e0)) return false;
  if (g0 && expected.includes(g0)) return false;
  return true; // known single-brand prefix, decoded brand clearly different -> conflict
}
