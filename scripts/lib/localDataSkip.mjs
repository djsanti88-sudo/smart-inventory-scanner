// scripts/lib/localDataSkip.mjs
//
// Some node:test suites exercise REAL local data that is deliberately gitignored (the tire-DB repair
// package under backups/, the boss export ledger). On a fresh clone, a new worktree, or CI that data
// is absent, and until 2026-08-19 those suites threw ENOENT out of a `before()` hook - 77 red tests
// that meant "data missing", not "code broken", and that `npm run proof:all` could not tell apart
// from a genuine failure. A gate that intermittently lies teaches people to re-run red instead of
// reading it.
//
// `skipUnlessLocalData` returns the value for node:test's `{ skip }` option: `false` when the data is
// present (the suite runs normally, nothing changes), otherwise a visible reason string so the skip is
// reported by name in `node --test` output and counted by scripts/proof-all.mjs. It never hides a
// real failure: a present-but-corrupt dataset still fails loudly inside the suite.
import { existsSync } from "node:fs";

/**
 * @param {string} absolutePath  the local-only file or directory the suite needs
 * @param {string} label         short human name, e.g. "tire-DB repair package"
 * @returns {false | string}     node:test `skip` option value
 */
export function skipUnlessLocalData(absolutePath, label) {
  return existsSync(absolutePath) ? false : `${label} absent in this checkout (gitignored local data: ${absolutePath})`;
}
