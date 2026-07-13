# Task 2.1 Report - Remove dead `autoAcceptVerifiedDecodes` setting

Branch: `feat/decode-ladder-goupc`. Status: **COMPLETE**.

## Grep-before output (safety check)

Full repo `grep -rn autoAcceptVerifiedDecodes`: 8 files hit - `CLAUDE.md:106`, `DECISIONS.md:71`,
`docs/DECODER_ARCHITECTURE.md:46`, `TESTING.md:154`, `docs/BACKLOG.md:58`,
`docs/archive/PROGRESS_HISTORY_2026-06.md:317,351`,
`docs/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md` (this task's own spec),
`e2e/fixtures.ts:33` - plus the two expected code hits.

Scoped `src/` grep: exactly 2 hits, matching the audit finding -
- `src/types.ts:353` - the `autoAcceptVerifiedDecodes: boolean;` field declaration in `Settings`.
- `src/stores/scanStore.ts:367` - the `autoAcceptVerifiedDecodes: false,` default literal.

No STOP condition triggered: no production logic reads or branches on the field anywhere in `src/`.
`e2e/fixtures.ts:33` was one extra hit beyond the brief's prediction (a duplicated settings object
for generic-category E2E specs) - not a behavior test, just a mirrored defaults object; updated for
consistency.

## Files changed

- `src/types.ts` - removed `autoAcceptVerifiedDecodes: boolean;` field + comment from `Settings`.
- `src/stores/scanStore.ts` - removed `autoAcceptVerifiedDecodes: false,` from `DEFAULT_SETTINGS`
  (`autoAddDecodedProducts: true`, the real gate, untouched).
- `e2e/fixtures.ts` - removed matching line from `GENERIC_SETTINGS`.
- `CLAUDE.md` - dropped the "declared but UNUSED/dead" caveat sentence.
- `docs/DECODER_ARCHITECTURE.md` - dropped the "declared but DEAD" parenthetical.
- `DECISIONS.md` - removed the now-false "Auto-accept of verified decodes is a setting" bullet.
- `TESTING.md` - corrected the liveDecode auto-save description to reference the real gate
  (`autoAddDecodedProducts`) instead of the removed field.
- `docs/BACKLOG.md` - checked off the TIER 2 "Remove dead code: autoAcceptVerifiedDecodes" item.
- `docs/archive/PROGRESS_HISTORY_2026-06.md` and the plan doc were deliberately left untouched
  (historical archive / task spec, not living docs).

## Migrate-tolerance finding

`scanStoreMigrate` (`src/stores/scanStore.ts`, persist `version: 6`) merges settings as
`{ ...DEFAULT_SETTINGS, ...(persisted.settings ?? {}) }` in every branch - a plain object spread
with no schema/allowlist validation. An old browser's persisted state still carrying
`settings.autoAcceptVerifiedDecodes` spreads it in as a harmless extra property that nothing reads
(confirmed by the `src/` grep) and that TypeScript can no longer type as part of `Settings`. **Safe
to remove with no migration version bump.**

## Test file check

No test in `src/` asserts on `autoAcceptVerifiedDecodes`'s default value or toggles it to observe
behavior (confirmed via grep on `src/services` and full `src/`). No test needed re-pointing.

## Gate results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npm run test` | `Test Files 186 passed \| 7 skipped (193)` / `Tests 1723 passed \| 30 skipped (1753)`, exit 0 |
| `cloudDrainRace.store.test.ts` flake | Did not trip this run; passed as part of the full suite |

## Post-edit safety re-grep

3 remaining hits, all intentional: `docs/BACKLOG.md` (completed `[x]` history line), the unmodified
task-spec plan doc, and the unmodified June archive log. Zero hits in `src/`, `e2e/`, or any active
doc.

## Full execution log

See `docs/superpowers/reports/2026-07-12-free-work-execution.md` -> "## Task 2.1" section for the
complete step-by-step trace.
