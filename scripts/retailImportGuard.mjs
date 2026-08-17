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

const EXISTING_ROWS_THRESHOLD = 3_000_000;

/**
 * The full drop-or-skip decision for scripts/import-retail-turso.mjs's pre-drop sanity check
 * (DT2-4, 2026-08-13). Extracted into a pure, Turso-free function so the wiring between "the guard
 * refuses" and "DROP TABLE never runs" can be proven by a normal unit test, without the real script
 * ever opening a live database connection -- import-retail-turso.mjs's only DROP TABLE call site is
 * reachable exclusively through this function returning `{ action: "drop" }`.
 *
 * @param {object} args
 * @param {number} args.existingCount - rows currently in the live Turso table.
 * @param {number} args.localEntryCount - rows the local JSON source will produce.
 * @param {boolean} args.force - the `--force` flag (reimport even though the table looks populated).
 * @param {boolean} args.forceShrink - the `--force-shrink` flag (allow a deliberate shrink).
 * @param {number} [args.existingThreshold] - row count above which the table is considered
 *   "already imported" and protected by this guard.
 * @param {number} [args.minRetainedFraction] - forwarded to evaluateShrinkGuard.
 * @returns {{ action: "proceed" | "skip" | "refuse" | "drop", reason: string | null }}
 */
export function decideRetailImportAction({
  existingCount,
  localEntryCount,
  force,
  forceShrink,
  existingThreshold = EXISTING_ROWS_THRESHOLD,
  minRetainedFraction = MIN_RETAINED_FRACTION,
}) {
  if (existingCount <= existingThreshold) return { action: "proceed", reason: null };
  if (!force) return { action: "skip", reason: null };

  const guard = evaluateShrinkGuard(localEntryCount, existingCount, forceShrink, minRetainedFraction);
  if (guard.refuse) return { action: "refuse", reason: guard.reason };
  return { action: "drop", reason: null };
}
