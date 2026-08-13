// Pure guard logic for scripts/import-retail-turso.mjs's pre-drop sanity check (mirrors
// build-tire-knowledge.mjs's MIN_RETAINED_FRACTION output-sanity guard, F1 2026-08-12).
// Extracted so it can be unit-tested without touching a real Turso database.

export const MIN_RETAINED_FRACTION = 0.9;

/**
 * Decide whether a --force reimport should be refused because the local source would replace
 * the live table with materially fewer rows than it currently holds.
 *
 * @param {number} localEntryCount - rows the local JSON source will produce.
 * @param {number} liveRowCount - rows currently in the live Turso table (about to be dropped).
 * @param {boolean} forceShrink - explicit override for a deliberate corpus replacement.
 * @param {number} minRetainedFraction - refuse below this fraction of liveRowCount.
 * @returns {{ refuse: boolean, reason: string | null }}
 */
export function evaluateShrinkGuard(localEntryCount, liveRowCount, forceShrink, minRetainedFraction = MIN_RETAINED_FRACTION) {
  if (forceShrink) return { refuse: false, reason: null };
  if (liveRowCount <= 0) return { refuse: false, reason: null }; // nothing to protect
  if (localEntryCount >= liveRowCount * minRetainedFraction) return { refuse: false, reason: null };
  return {
    refuse: true,
    reason:
      `local source has ${localEntryCount} rows, live Turso table has ${liveRowCount} rows ` +
      `(local is below ${Math.round(minRetainedFraction * 100)}% of live). This looks like a stale or ` +
      `truncated local file, not a deliberate corpus replacement. Pass --force-shrink in addition to ` +
      `--force only if you intend to replace the live corpus with a smaller one.`,
  };
}
