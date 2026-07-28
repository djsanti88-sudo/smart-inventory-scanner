// e2e/teach/callCoverage.mjs
//
// Pure call-coverage helper for the Teach Bot harness. Given the set of
// backend paths a lesson actually observed firing (e.g. via attachLadderCapture's
// apiCalls()) and the set of paths a lesson expects to fire, reports which
// expected paths never appeared - so a lesson can assert nothing was silently
// skipped, rather than only asserting on what DID happen.

/**
 * Strip a leading query string (and hash) from a URL path, and normalize case
 * for comparison. Not a full URL parser - callers pass path-like strings
 * ("/api/ai-lookup?code=123"), not full origins.
 * @param {string} p
 */
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  const withoutHash = p.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  return withoutQuery.toLowerCase();
}

/**
 * Return the expected paths that never appeared among the observed paths.
 * Case-insensitive, query-string-stripped, deduped, order-preserving.
 * @param {string[]} observedPaths
 * @param {string[]} expectedPaths
 * @returns {string[]}
 */
export function missingExpectedCalls(observedPaths, expectedPaths) {
  const observed = new Set(
    (Array.isArray(observedPaths) ? observedPaths : []).map(normalizePath)
  );
  const expectedList = Array.isArray(expectedPaths) ? expectedPaths : [];

  const seen = new Set();
  const missing = [];
  for (const raw of expectedList) {
    const normalized = normalizePath(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (!observed.has(normalized)) missing.push(raw);
  }
  return missing;
}
