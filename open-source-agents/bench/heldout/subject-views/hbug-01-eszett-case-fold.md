# Case: hbug-01-eszett-case-fold
## Task prompt (what the subject model sees)
Review the following code for real defects. This is the deterministic alias/SKU matcher for a
barcode inventory app: `foldCase` normalizes a scanned code and a stored product's identifiers
for CASE-INSENSITIVE comparison only (never used to mutate stored/displayed values). A scanned
code must resolve to a product ONLY if it is genuinely the same identity as a stored alias/SKU.
## Input code
```ts
// src/services/aliasMatcher.ts

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
 *  difference (e.g. scanned "t432119" vs a stored alias "T432119") is the SAME identity. */
function foldCase(v: string | undefined | null): string {
  return (v ?? "").toUpperCase();
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
```
