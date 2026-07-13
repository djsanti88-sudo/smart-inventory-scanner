# Task 3.5: Variance / Shrinkage Report

Worktree: `C:\tmp\wt-variance` (branch `feat/variance-report`). Non-persisted `node_modules` junction
shared with the main repo (untouched).

## TDD evidence (red -> green per file)

### 1. `src/services/reports/varianceReport.test.ts` -> `varianceReport.ts`
Wrote the full test file first (10 cases: both-empty, one-empty, added, removed, changed, unchanged-
included, sort-by-magnitude, tie-break-by-name, duplicate-in-a-throws, duplicate-in-b-throws). Ran it
against a nonexistent implementation:

```
$ npx vitest run --project unit src/services/reports/varianceReport.test.ts
FAIL  |unit| src/services/reports/varianceReport.test.ts
Error: Cannot find package '@/services/reports/varianceReport' imported from
  .../varianceReport.test.ts
Test Files  1 failed (1)
```
RED confirmed for the right reason (module missing). Implemented `computeVariance` +
`exportVarianceCsv`, re-ran:
```
$ npx vitest run --project unit src/services/reports/varianceReport.test.ts
Test Files  1 passed (1)
     Tests  10 passed (10)
```

### 2. `src/stores/varianceSnapshot.store.test.ts` -> `scanStore.ts` / `scanPersist.ts`
Wrote the store test file first (8 cases: snapshot captures finalCounts, returns + appends, caps at
12 evicting oldest, included in persisted platform state, JSON round-trip, migrate defaults
`countSnapshots` to `[]` from a v5 blob, from a v6 blob, and leaves an existing array untouched at
v7). Ran before any store change:
```
$ npx vitest run --project dom src/stores/varianceSnapshot.store.test.ts
FAIL  ... TypeError: store.getState(...).snapshotCount is not a function
FAIL  ... AssertionError: expected undefined to deeply equal [] (countSnapshots after migrate)
Tests  7 failed | 1 passed (8)
```
RED confirmed for the right reasons (missing action, missing migrate default). Added `CountSnapshot`
state/action to `scanStore.ts`, added `countSnapshots` to `PersistableScanState` /
`buildPersistedScanState` in `scanPersist.ts`, extended `scanStoreMigrate`, bumped persist version.
Re-ran:
```
$ npx vitest run --project dom src/stores/varianceSnapshot.store.test.ts
Test Files  1 passed (1)
     Tests  8 passed (8)
```
Also re-ran the pre-existing `scanStoreMigrate.test.ts` + `scanPersist.test.ts` + `scanStore.test.ts`
to confirm no regressions from the version bump / interface change (54/54 passed; one pre-existing
fixture in `scanPersist.test.ts` needed the new required `countSnapshots: []` field added - see
"Files modified").

### 3. `src/components/VarianceReport.test.tsx` -> `VarianceReport.tsx`
Wrote the component test file first (9 cases: renders Save button, click calls `snapshotCount`, empty
state at 0 and 1 snapshots, dropdowns populate + variance table renders on selecting two snapshots,
positive delta shows a leading `+`, no barcode/cleanCode/matchType/provider columns rendered, CSV
export calls the mocked `downloadCsv` with variance content, export button disabled until two
snapshots are picked). Ran before the component existed:
```
$ npx vitest run --project dom src/components/VarianceReport.test.tsx
FAIL  |dom| src/components/VarianceReport.test.tsx
Error: Failed to resolve import "@/components/VarianceReport" ...
Test Files  1 failed (1)
```
RED confirmed. Implemented `VarianceReport.tsx` (button + label input, two `<select>` dropdowns,
variance table, CSV export button wired to `downloadCsv`/`exportVarianceCsv`), integrated it into
`src/app/(app)/scan/page.tsx` under `FinalCountTable`. Re-ran:
```
$ npx vitest run --project dom src/components/VarianceReport.test.tsx
Test Files  1 passed (1)
     Tests  9 passed (9)
```

## Files created

- `C:\tmp\wt-variance\src\services\reports\varianceReport.ts` - `CountSnapshot`, `VarianceRow`,
  `computeVariance`, `exportVarianceCsv` (pure, no React/next imports; imports `buildCsv` from
  `@/services/csvExport`).
- `C:\tmp\wt-variance\src\services\reports\varianceReport.test.ts` - 10 unit tests.
- `C:\tmp\wt-variance\src\components\VarianceReport.tsx` - Save-snapshot button + compare view +
  variance table + CSV export.
- `C:\tmp\wt-variance\src\components\VarianceReport.test.tsx` - 9 jsdom component tests.
- `C:\tmp\wt-variance\src\stores\varianceSnapshot.store.test.ts` - 8 store tests (snapshotCount,
  persistence, migrate defaults).
- `C:\tmp\wt-variance\e2e\variance-report.spec.ts` - Playwright spec (written, NOT run - see
  "Required deviations" below).

## Files modified

- `C:\tmp\wt-variance\src\stores\scanStore.ts`:
  - Added `import type { CountSnapshot } from "@/services/reports/varianceReport";`.
  - Added `countSnapshots: CountSnapshot[]` field to `ScanState`, next to `finalCounts`/
    `needsReviewQueue`.
  - Added `snapshotCount: (label: string) => CountSnapshot;` to the actions section of `ScanState`.
  - Added `COUNT_SNAPSHOT_CAP = 12` constant near `MAX_CONCURRENT_DECODES`.
  - Added `countSnapshots: []` to the store's default initial state.
  - Implemented `snapshotCount` immediately after `recordFeedback` (same file region), building lines
    from `finalCounts` joined against `products` for the name, using `idFactory()`/`now()` (the same
    injected deps every other action uses, so it is deterministic in tests via `createTestScanStore`).
  - Extended `scanStoreMigrate` to default `countSnapshots` to `[]` in both the `< 5` (full reset) and
    `>= 5` (additive) branches, preserving an existing array if one is already present.
  - Bumped the zustand `persist` `version` from `6` to `7`.
- `C:\tmp\wt-variance\src\stores\scanPersist.ts`:
  - Added `countSnapshots: unknown[]` to `PersistableScanState`.
  - Added `countSnapshots: s.countSnapshots` to the shared `base` object in `buildPersistedScanState`
    (persisted for every access level - see "Customer-data-firewall" decision below).
- `C:\tmp\wt-variance\src\stores\scanPersist.test.ts`: added `countSnapshots: []` to the pre-existing
  `makeState()` fixture (this file's `PersistableScanState` object literal became invalid after the
  interface gained a new required field; the fix is the minimal one-line addition, no other lines in
  this file changed, all 4 pre-existing tests in it still pass).
- `C:\tmp\wt-variance\src\app\(app)\scan\page.tsx`: imported `VarianceReport` and rendered it directly
  under `<FinalCountTable />` inside the existing `BusinessContextGate` wrapper (minimal integration,
  no other changes to this file).
- `C:\tmp\wt-variance\e2e\fixtures.ts`: bumped the local `PERSIST_VERSION` constant (used only to seed
  a matching-version localStorage blob for the generic e2e fixture) from `6` to `7` to track the real
  store's version bump. This is a 1-line, safe, in-scope companion change - without it the e2e seed
  would still work (an older-version seed just takes the harmless additive migrate branch and gets
  `countSnapshots: []`), but leaving it stale would be misleading. Not run in this task (Playwright
  gate is separate, per the controller decision below).

## Test results (actual terminal output)

Targeted gate exactly as specified in the task:
```
$ npx vitest run src/services/reports src/stores src/components/VarianceReport.test.tsx
 Test Files  47 passed (47)
      Tests  286 passed (286)
   Duration  8.70s
```
(47 files / 286 tests = every existing test under `src/services/reports`, all of `src/stores`
including the pre-existing 39 store test files, plus the new `VarianceReport.test.tsx`. Nothing
skipped, nothing failed, no regressions.)

```
$ npx tsc --noEmit
(no output - clean exit)
```
No pre-existing TypeScript errors were found or left unrelated to this change; the two errors tsc
initially surfaced were both caused by this change and were fixed in-scope (the e2e spec's
`selectOption({ label: RegExp })` typing, and the pre-existing `scanPersist.test.ts` fixture missing
the new required field) - both listed under "Files modified" above.

## Persist-migration approach

- **Version bump:** zustand `persist` `version` in `scanStore.ts` goes from `6` to `7`.
- **What `migrate` does:** `scanStoreMigrate(persisted, version)` now computes
  `existingSnapshots = Array.isArray(p.countSnapshots) ? p.countSnapshots : []` up front and threads
  it into both return branches:
  - `version < 5` (full poison-cleanup reset): returns `countSnapshots: existingSnapshots` (in
    practice always `[]`, since no version before 7 ever wrote this field, but the guard means a
    future re-run of migrate on an already-migrated blob does not wipe real snapshots).
  - `version >= 5` (additive backfill, the common real-user path): returns
    `countSnapshots: existingSnapshots`, i.e. defaults missing to `[]`, leaves a present array
    untouched.
- **Why it's safe:** no version prior to 7 ever wrote `countSnapshots`, so every existing real install
  (v5 or v6) simply gains an empty array - identical in spirit to how `syncedScanEventIds`/
  `pendingSyncQueue` etc. were introduced. No existing field is touched, removed, or reshaped. The
  store's default initial state also sets `countSnapshots: []` (for a first-ever install with no
  persisted blob at all), and the persisted round-trip test proves a snapshot survives a JSON
  serialize/parse cycle unchanged.

## Documented decisions

1. **Zero-delta rows are INCLUDED**, not filtered, in `computeVariance`'s output. Rationale (also in
   the `varianceReport.ts` doc comment): a shrinkage report's purpose is a full reconciliation - an
   owner needs "counted, no change" as a positive confirmation row, not just the movers. Callers that
   want only changes can `rows.filter(r => r.delta !== 0)`.
2. **Duplicate `productId` within one snapshot's `lines` THROWS** (`Error`, not a silent filter).
   Rationale: `snapshotCount` builds one line per `finalCounts` row, which is already unique by
   `productId` by construction, so a duplicate can only mean the snapshot was built by a different,
   buggy path. Silently keeping one row would hide that bug and could misreport variance; throwing
   surfaces it immediately. Both directions are tested (duplicate in snapshot A, duplicate in
   snapshot B).
3. **Snapshot id/timestamp generation:** `snapshotCount` uses the store's existing injected
   `idFactory()` and `now()` deps (same ones every other store action already uses, e.g.
   `recordFeedback`), so it is deterministic under `createTestScanStore` in tests and consistent with
   the rest of the codebase's id/timestamp conventions - no new pattern introduced.
4. **Cap-at-12 eviction** reuses the exact ring-buffer shape already proven by
   `appendFeedback`/`FEEDBACK_EVENT_CAP` in `src/services/feedback/feedback.ts` (append newest to the
   end, `slice` off the oldest once length exceeds the cap, most-recent-last). `COUNT_SNAPSHOT_CAP =
   12` lives next to `MAX_CONCURRENT_DECODES` at the top of `scanStore.ts`; the eviction logic itself
   is inlined in `snapshotCount` rather than extracted to a shared helper (the task brief did not ask
   for one and the existing `appendFeedback` helper's signature is feedback-log-specific).
5. **Customer-data-firewall mechanism reused, not reinvented.** The existing mechanism is
   `buildPersistedScanState` in `scanPersist.ts`, which computes an `AccessLevel` ("platform" vs
   "business"/customer) from the signed-in uid and decides what reaches `localStorage`. I added
   `countSnapshots` to the **shared `base`** object (persisted for every role, not gated to
   `platform`), because `CountSnapshot.lines` only ever carries `{ productId, name, qty }` - the exact
   same product-facing shape a customer already receives in their own persisted `finalCounts` (no
   barcode/cleanCode/matchType/provider/alias fields ever enter a snapshot in the first place, since
   `snapshotCount` builds lines from `finalCounts` + `product.name` only). The UI-level firewall
   mirrors this: `VarianceReport`'s table only ever renders `name`/`prevQty`/`currQty`/`delta` columns
   (never barcode/cleanCode/matchType/provider - explicitly tested in
   `VarianceReport.test.tsx`'s "customer data firewall" case), matching how `FinalCountTable` gates
   its *extra* platform-only columns (`Other codes scanned`) rather than inventing a new gating
   mechanism. No `useAccessLevel`/`useIsPlatformOwner` check was needed inside `VarianceReport` itself
   because the report never has platform-only data to hide.

## Execution-report section (for the shared free-work execution report)

Built the count-snapshot + variance/shrinkage report feature end to end with TDD: a pure
`computeVariance` service comparing two named count snapshots (added/removed/changed/unchanged
products, sorted by magnitude of change), a `snapshotCount` store action that captures the current
counts into a capped rolling history (persisted across reload via a safe, additive persist-version
bump), and a `VarianceReport` UI component with a "Save count snapshot" button, a two-snapshot compare
view, and CSV export - wired into the existing counts page. All new logic is product-facing only
(name + quantities), reusing the app's existing customer-data-firewall persistence split rather than
adding a new one. 27 new automated tests (10 service, 8 store, 9 component) plus a written (not yet
run) Playwright e2e spec, all passing; project-wide `tsc --noEmit` is clean.

## Self-review

- **Playwright not run**, per the controller-mandated deviation #1. The spec
  (`e2e/variance-report.spec.ts`) was written to the best of my ability by mirroring
  `e2e/scan.spec.ts`'s scan helper and `e2e/export-menu.spec.ts`'s download-assertion pattern, and I
  updated `e2e/fixtures.ts`'s `PERSIST_VERSION` constant to stay consistent with the real store's
  version bump, but I have **not verified it actually passes** - the "Sessions and export" `<details>`
  open/click logic, the option-value lookup for the two `<select>` dropdowns, and the
  `window.confirm` auto-accept assumption for "Remove from count" are my best guesses at the right
  Playwright incantations, unverified by an actual run. Flag this as the main risk before merge: a
  separate gate must run `npx playwright test variance-report.spec.ts` and fix anything that doesn't
  match reality (most likely candidates: the `details` open-state check, or the confirm-dialog
  handling, since I did not find an existing example of a spec clicking a `window.confirm`-guarded
  button in the files I inspected).
- **`e2e/fixtures.ts` was not in the "stage only" list** in the task brief. I judged it a necessary,
  minimal, in-scope companion to the persist-version bump (a stale constant there would be misleading
  even though it doesn't break anything, since the migrate path handles a mismatched version
  gracefully). I'm flagging this explicitly rather than silently expanding scope - happy to leave it
  unstaged if the owner would rather keep the diff to exactly the listed files; the version bump works
  correctly either way because `scanStoreMigrate`'s additive branch is idempotent.
- **`src/stores/scanPersist.test.ts` was not in the "stage only" list either**, but its existing fixture
  became a TypeScript error (`Property 'countSnapshots' is missing`) purely as a mechanical
  consequence of `PersistableScanState` gaining a new required field. This is the same category as
  "the minimal scanStore.ts diff + its test file" already called out in the brief; I'm treating
  `scanPersist.ts`/`scanPersist.test.ts` as part of that same minimal diff since `scanPersist.ts` is
  the store's dedicated persist module (imported directly by `scanStore.ts`'s `partialize`), not a
  separate unrelated file.
- **CSV export column choice**: I named the CSV headers `product_name, previous_quantity,
  current_quantity, delta` (matching the existing `snake_case` convention in `csvExport.ts`) rather
  than reusing the human-facing table headers verbatim. Low risk, but worth noting since it's a new
  precedent (previous exports don't have a "delta" concept).
- **No explicit role gate inside `VarianceReport`**: since the component never renders or exports any
  platform-only field, I did not add a `useIsPlatformOwner`/`useAccessLevel` check to hide anything -
  confirmed by the "customer data firewall" test asserting no barcode/cleanCode/matchType/provider
  text appears. If a future requirement adds a platform-only column to this report, that gate will
  need to be added then; today there is nothing to gate.
- **`countSnapshots` persisted for every role** (not platform-only) was a judgment call under
  investigation step 6 - it is the correct call given the data is already product-facing-only, but
  it's a new category of "customer keeps their own operational history" data, so flagging it as a
  decision an owner should sanity-check rather than something obviously dictated by the existing code.
