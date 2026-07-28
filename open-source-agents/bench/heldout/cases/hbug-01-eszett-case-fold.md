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
## GROUND TRUTH (never shown to subject)
- Defect: `foldCase` uses JavaScript's `.toUpperCase()`, which for a handful of non-ASCII codepoints
  performs a locale-independent EXPANSION rather than a 1:1 case mapping - most notably the German
  eszett `"ß"`, where `"straße".toUpperCase() === "STRASSE"`. Because `candidatesInclude`/the matcher
  compares folded strings for equality, a scanned code containing `"straße"` folds to `"STRASSE"` and
  will match a completely unrelated stored SKU/alias literally spelled `"STRASSE"` - a false identity
  merge between two different products caused purely by a codepoint-expansion artifact of case folding,
  not a real code collision.
- Fix commit: 7b6228d fix(scan): eszett-safe ASCII-only case fold (no codepoint-expansion merge)
- Key evidence: `foldCase` changed from `(v ?? "").toUpperCase()` to
  `(v ?? "").replace(/[a-z]/g, (c) => c.toUpperCase())` - i.e. only ASCII `[a-z]` characters are folded;
  every non-ASCII codepoint (including `ß`) is passed through untouched, so it can never expand into
  different ASCII characters and can never accidentally equal an unrelated ASCII SKU.
- Scoring: HIT if the subject identifies that `.toUpperCase()` is a locale-independent case-fold that
  can EXPAND certain non-ASCII characters (eszett `ß` -> `SS`, or names similar issues like Turkish
  dotless-i or ligature expansion) into multiple ASCII characters, and that this can cause two
  genuinely different codes/products to be treated as the same identity via `candidatesInclude`'s
  case-insensitive equality check. PARTIAL if the subject flags `.toUpperCase()` as "unsafe" or
  "locale-dependent" in general terms without naming the specific expansion-causes-false-merge
  mechanism, or without connecting it to the deterministic-matcher's "never guess identity" contract.
  Plausible-but-wrong findings: (1) claiming `foldCase` should not touch non-ASCII at all for
  performance reasons (irrelevant, not the real risk); (2) flagging that folded values are never stored
  or displayed as a bug (this is intentional and correctly documented in the comment - display/storage
  always uses the original untouched code); (3) claiming `pickTier`'s Map insertion order is
  nondeterministic and therefore a bug (Maps preserve insertion order in JS; not a real defect here).
