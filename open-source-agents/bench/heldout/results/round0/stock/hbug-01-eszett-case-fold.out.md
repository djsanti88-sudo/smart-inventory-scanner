<!-- subject=stock case=hbug-01-eszett-case-fold round=0 elapsed=146s rc=0 -->
**Defects / Issues Found**

| # | Function | Defect | Why it matters | Suggested fix |
|---|-----------|--------|----------------|---------------|
| 1 | `uniq` | O(n²) duplicate check (`out.includes`) | For large lists this is a performance hit. | Replace with a `Set`: `return [...new Set(values.filter(v => !!v))]`. |
| 2 | `foldCase` | Returns `""` for `null/undefined` instead of `null` | The rest of the code treats an empty string as a valid value (e.g., `candidatesInclude` will treat `""` as a candidate). | Return `null` for missing input: `return v ? v.toUpperCase() : null;`. |
| 3 | `candidatesInclude` | Uses `foldCase(field)` even when `field` is falsy → returns `false` but still calls `foldCase(field)`. | Minor, but unnecessary call. | Move the `if (!field) return false;` *before* folding: `if (!field) return false; const folded = foldCase(field); …`. |
| 4 | `pickTier` | Conflict object contains a property (`conflictProductIds`) that is **not** part of the declared `ScanResolution` type. | TypeScript will error or the consumer will ignore the field. | Either add `conflictProductIds?: string[];` to `ScanResolution`, or drop it from the returned object. |
| 5 | `pickTier` | Returns `null` for an empty hit list, but callers may expect a `ScanResolution` with `matchType: "unknown"`. | Inconsistent return type can lead to runtime checks (`=== null`) that are fragile. | Return `{ matchType:"unknown", productId:null, matchedOn:null }` instead of `null`. |
| 6 | Export visibility | None of the helper functions are exported. | The module is likely imported elsewhere; without exports nothing works. | Add `export { uniq, foldCase, candidatesInclude, pickTier };`. |

**Quick Fixes**

```ts
// src/services/aliasMatcher.ts

export function uniq(values: string[]): string[] {
  return [...new Set(values.filter(v => !!v))];
}

export function foldCase(v: string | undefined | null): string | null {
  return v ? v.toUpperCase() : null;
}

export function candidatesInclude(
  candidates: string[],
  field: string | undefined,
): boolean {
  if (!field) return false;
  const folded = foldCase(field)!; // non‑null after guard
  return candidates.some(c => foldCase(c) === folded);
}

/** Reduce a tier's hits to a resolution: 0 -> unknown, 1 distinct product -> match, >1 -> conflict. */
export function pickTier(
  hits: Array<{ productId: string; matchedOn: string }>,
  matchType: MatchType,
): ScanResolution {
  if (hits.length === 0) {
    return { matchType: "unknown", productId: null, matchedOn: null };
  }

  const byProduct = new Map<string, string>();
  for (const h of hits) {
    if (!byProduct.has(h.productId)) byProduct.set(h.productId, h.matchedOn);
  }

  if (byProduct.size === 1) {
    const [productId, matchedOn] = [...byProduct.entries()][0];
    return { matchType, productId, matchedOn };
  }

  // conflict
  return {
    matchType: "conflict",
    productId: null,
    matchedOn: null,
    // optional – only if ScanResolution declares it
    conflictProductIds: [...byProduct.keys()],
  };
}
```

With these changes the helpers are efficient, type‑safe, and exportable.
