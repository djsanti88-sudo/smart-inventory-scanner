// Pure text-distance helper (QA Task 8, owner-approved 2026-07-15). No React/next imports - this
// module is used to power a REVIEW-ONLY "Did you mean <X>?" suggestion for near-miss alpha_sku
// typos (e.g. a scanned T432118 when the shop's real SKU is T432119). It never decides identity by
// itself: callers must still require an exact single candidate within a tight bound before
// surfacing anything, and the result is always a suggestion attached to a Needs Review row, never
// an auto-count or auto-alias.

/**
 * Bounded Levenshtein edit distance between two strings, case-insensitive.
 *
 * Returns the true distance when it is <= `maxDistance`, otherwise `null` - the caller should
 * treat `null` as "too far, do not suggest" rather than trusting an approximate/truncated number.
 * Also returns `null` for empty input (there is no meaningful "near match" to an empty code).
 *
 * The early-exit bound keeps this cheap even when scanning many candidates: each row of the DP
 * table is a plain O(len) pass, and rows only ever need `maxDistance` context on either side of
 * the diagonal, but for simplicity/clarity (candidate codes here are always short SKU-length
 * strings) we compute the full row and just cap the reported result - the bound is used to bail
 * out early once the current row's minimum already exceeds it.
 */
export function levenshteinWithin(a: string, b: string, maxDistance: number): number | null {
  if (!a || !b) return null;
  if (maxDistance < 0) return null;

  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();

  if (s1 === s2) return 0;

  const lenDiff = Math.abs(s1.length - s2.length);
  if (lenDiff > maxDistance) return null;

  const m = s1.length;
  const n = s2.length;

  let prevRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    const currRow = new Array(n + 1);
    currRow[0] = i;
    let rowMin = currRow[0];
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost, // substitution
      );
      if (currRow[j] < rowMin) rowMin = currRow[j];
    }
    // Early exit: candidate codes here are short SKU-length strings, so a full row is cheap; the
    // only case worth bailing out of early is a row whose minimum already exceeds the bound by
    // more than the remaining rows could ever repay (each further row lowers the min by at most 1).
    if (rowMin > maxDistance + (m - i)) return null;
    prevRow = currRow;
  }

  const distance = prevRow[n];
  return distance <= maxDistance ? distance : null;
}
