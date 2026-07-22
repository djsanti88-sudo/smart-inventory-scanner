# Merge train report - 2026-07-12

Merged four reviewed-and-approved feature branches into `feat/decode-ladder-goupc` (all four branched
from `7213c20`), one at a time with `--no-ff`, verified after each merge, then ran the full gate suite
twice (once surfacing a real regression, once clean after the fix). No push at any point.

## Branches merged (strict order)

1. `feat/free-rungs` - UPCitemdb + Open Food Facts rungs before the paid decode ladder.
2. `feat/camera-scan` - BarcodeDetector + zxing-wasm fallback for camera-based scanning.
3. `feat/variance-report` - count snapshots + shrinkage/variance report.
4. `feat/csv-import` - CSV import preview, firewall sanitization, idempotent apply.

## Commit sequence

```
7213c20 (base, common ancestor of all 4 branches)
  -> 70d8692 merge: free-rungs feature (UPCitemdb + Open Food Facts rungs before paid ladder)
  -> 5d48d0b merge: camera-scan feature (BarcodeDetector + zxing-wasm fallback)
  -> 8a36a19 merge: variance-report feature (count snapshots + shrinkage report)
  -> a341f2f merge: csv-import feature (preview, firewall, idempotent apply)
  -> a7ca019 chore: regenerate lockfile after csv-import merge (csv-parse dev->prod dependency)
  -> 5f98363 fix(counts): clean customer-facing Model column + fix new e2e specs found by merge-train gate
```

Final `feat/decode-ladder-goupc` HEAD: `5f98363`.

## Merge 1: feat/free-rungs -> 70d8692

Clean merge, zero conflicts. 18 files changed (2039 insertions, 32 deletions): new
`OpenFoodFactsProvider`/`UpcItemDbProvider` server modules + usage/cost trackers, new
`openFoodFactsClient`/`upcItemDbClient` service wrappers, `ladder.ts` and `pipeline.ts` extended to
call the new free rungs before the paid ladder, `importBoundary.test.ts` updated.

Verification:
- `npx tsc --noEmit`: clean.
- Targeted vitest (`OpenFoodFactsProvider.test.ts`, `UpcItemDbProvider.test.ts`,
  `openFoodFactsUsage.test.ts`, `upcItemDbUsage.test.ts`, `openFoodFactsClient.test.ts`,
  `upcItemDbClient.test.ts`, `ladder.test.ts`, `importBoundary.test.ts`, `pipeline.test.ts`):
  **9 files / 74 tests passed**.

## Merge 2: feat/camera-scan -> 5d48d0b

Clean merge, zero conflicts. 10 files changed (1211 insertions, 1 deletion): new
`CameraScanButton` component + `cameraScanner` service, `scan/page.tsx` wired to render the button,
`package.json`/`package-lock.json` add `barcode-detector@^3.2.1`, `vitest.config.ts` tweaked for the
new component test, new `e2e/camera-scan.spec.ts`.

`npm install` run per the task brief: **no lockfile diff** - the merged lockfile already resolved
`barcode-detector` correctly.

Verification:
- `npx tsc --noEmit`: clean.
- Targeted vitest (`CameraScanButton.test.tsx`, `cameraScanner.test.ts`): **2 files / 11 tests
  passed** (jsdom logs "Not implemented: HTMLMediaElement's play()" - expected stub warning, not a
  failure).

## Merge 3: feat/variance-report -> 8a36a19

One auto-resolved conflict in `src/app/(app)/scan/page.tsx` - camera-scan's `CameraScanButton` import
+ render call and variance-report's `VarianceReport` import + render call sit in different regions of
the file; git's `ort` merge strategy resolved it automatically with no conflict markers. Verified both
additions landed:
```
7:import { CameraScanButton } from "@/components/CameraScanButton";
12:import { VarianceReport } from "@/components/VarianceReport";
122:            <CameraScanButton onScan={handleScan} />
236:      <VarianceReport />
```
Additive union confirmed, matching the plan's expected-conflict resolution rule exactly.

12 files changed (1061 insertions, 2 deletions): new `VarianceReport` component +
`varianceReport` report-building service, `scanStore.ts` gains `countSnapshots` state +
`snapshotCount` action + persist-version bump (see Regression section below), `scanPersist.ts` adds
`countSnapshots` to the persisted shape, new `e2e/variance-report.spec.ts`, `e2e/fixtures.ts` gets a
one-line additive tweak.

Verification:
- `npx tsc --noEmit`: clean.
- Targeted vitest (`VarianceReport.test.tsx`, `varianceReport.test.ts`,
  `varianceSnapshot.store.test.ts`, `scanPersist.test.ts`): **4 files / 31 tests passed**.
- Extra safety since `scanStore.ts` was touched: full `src/stores/scanStore*` suite - **7 files / 80
  tests passed**.

## Merge 4: feat/csv-import -> a341f2f

One auto-resolved conflict in `package.json` - camera-scan's `barcode-detector` dependency addition
and csv-import's `csv-parse` devDependencies -> dependencies move both landed correctly via git's
`ort` strategy with no conflict markers. Verified by reading the merged `package.json`:
`barcode-detector` present under `dependencies`, `csv-parse` present under `dependencies` (removed
from `devDependencies`).

10 files changed (1455 insertions, 4 deletions): new `CsvImportPanel` component +
`csvImport` service (parse/validate/build-import), `products/page.tsx` wired to render the panel,
`types.ts` adds the `"csv_import"` Source enum value, new `e2e/csv-import.spec.ts` +
`e2e/fixtures/csv-import-onboarding.csv`.

`npm install` per the resolution rule ("regenerate the lock with npm install and commit the
regenerated lock; never hand-edit"): produced a real diff -
```diff
+        "csv-parse": "^7.0.0",   (moved into the dependencies block)
-        "csv-parse": "^7.0.0",   (removed from devDependencies block)
...
-      "dev": true,               (csv-parse package entry no longer marked dev-only)
```
Regenerated lock committed separately as `a7ca019` (`chore: regenerate lockfile after csv-import
merge`) so the merge commit itself stays a pure merge.

Verification:
- `npx tsc --noEmit`: clean.
- Targeted vitest (`CsvImportPanel.test.tsx`, `csvImport.test.ts`): **2 files / 39 tests passed**.

## Full gates - first pass (before the regression fix)

1. **`npm run proof:full`** (tsc + full vitest + next build): PASS.
   - `tsc --noEmit`: clean.
   - vitest: **203 files / 1944 tests passed, 30 skipped** (pre-existing skip count, unrelated).
   - `next build`: succeeded (one pre-existing Turbopack informational NFT-list warning on
     `next.config.ts` -> `src/services/security/aiSpendGuard.ts` -> `api/ai-lookup/route.ts`; present
     before this merge train, unrelated to any of the four branches).

2. **`npm run test:e2e`**: PASS on the first attempt only after two spec-side fixes (see below);
   **34/34** once fixed.
   - Initial run of the full suite failed to even *load* `e2e/csv-import.spec.ts`:
     `ReferenceError: require is not defined in ES module scope` pointing at the spec's own
     `import { test, expect } from "./fixtures"` line. Root-caused to
     `fileURLToPath(import.meta.url)` (used to derive `__dirname`) - Playwright compiles `.ts` specs
     as CommonJS in this project (`package.json` has no `"type": "module"`), so `import.meta` does
     not exist at load time in that compiled module, and the loader errors before running any test.
     No other spec in the repo uses `import.meta.url`. Confirmed by testing `e2e/camera-scan.spec.ts`
     (which imports the same `./fixtures` module) in isolation - it loads fine, isolating the bug to
     `import.meta.url` specifically, not the `fixtures.ts`/`fixtures/` directory name collision that
     was the first (incorrect) hypothesis. **Fix:** removed the `node:url` import and the
     `fileURLToPath` line; Playwright already provides `__dirname` natively in its CJS-compiled test
     files. Verified: passes in isolation and in the full run.
   - `e2e/variance-report.spec.ts` (never run before this gate, per its own header comment) failed:
     `expect(table).toContainText("-1")` - the Coca-Cola row's delta stayed `0`, not `-1`, meaning the
     "remove Coca-Cola from the count" step silently did nothing. Root cause: `FinalCountTable`'s
     remove action calls `window.confirm(...)`; the spec's inline comment claimed "Playwright
     auto-accepts by default in this suite" - **this is false**. Playwright's actual default is to
     **dismiss** dialogs unless a `page.on("dialog", d => d.accept())` listener is registered, exactly
     as `e2e/delete-product.spec.ts` already does elsewhere in this repo. **Fix:** added the listener.
     After that fix, the wrong row was removed (Falken, not Coca-Cola) because
     `page.getByTestId(/^remove-count-/).first()` is DOM-order-dependent, not "the Coca-Cola row"
     specifically. **Fix:** scoped the locator to `page.locator("tr", { hasText: "Coca-Cola" })`
     first. Verified: passes in isolation and in the full run. Also corrected the spec's stale header
     comment ("NOT run in this task") since it now runs in this gate.
   - Final run: **34/34 passed** (31 pre-existing + 3 new: `camera-scan.spec.ts`,
     `variance-report.spec.ts`, `csv-import.spec.ts`). `camera-scan.spec.ts` passed without needing
     the fake-media-stream Chromium launch flags suggested as a fallback in the task brief.
   - Screenshot proof confirmed present in `e2e/proof/`: `csv-import-01-preview.png`,
     `csv-import-02-summary.png`, `variance-report.png`, plus all 26 pre-existing proof screenshots
     (untouched).

3. **`npm run qa:bots:all`**: **11/12 passed, 1 failed** -
   `e2e/human-bots/scenarios/customer-clean-names.spec.ts` (P5 - "CustomerCleanNamesBot: Counts shows
   clean Brand Model Size, no UPC/Fits").
   ```
   Expected substring: not "UPC 086699205636"
   Received string:    "3\tDefender LTX M/S 275/70R18\tMichelin\tUPC 086699205636 - Defender LTX M/S
                         Fits: 2004 Chevrolet\ttire\t275/70R18\t275/70R18\t\t086699205636\t-\t
                         Invalid Date\tVerified match\tSaved\tEdit details\tRemove from count"
   ```

## Regression investigation (P5 bot failure)

Treated as a possible real regression per the task's gate-failure rule (fix for a real reason, note
any app-code change). Investigation steps, in order:

1. **Confirmed it is not a pre-existing failure.** Created a disposable `git worktree` at the base
   commit `7213c20` (before any of the 4 merges), ran `npm install` + the bot spec there: **passed**.
   This proves the failure was introduced somewhere in the 4 merges, not a stale/known-flaky bot.

2. **Bisected across the 4 merge commits**, each in its own disposable worktree
   (`70d8692`, `5d48d0b`, `8a36a19`, running the same install + bot-spec-only command each time):
   - `70d8692` (free-rungs): bot **passed**.
   - `5d48d0b` (camera-scan): bot **passed**.
   - `8a36a19` (variance-report): bot **FAILED** (same error as above).

   Root cause isolated to `feat/variance-report`. All bisection worktrees removed via
   `git worktree remove --force` before returning to the main tree; the task's pre-existing
   `C:\tmp\wt-*` worktrees were never touched.

3. **Traced the mechanism** by reading `feat/variance-report`'s `scanStore.ts` diff directly (not
   guessed): Task 3.5 bumped the zustand-persist `version` from `6` to `7` (to default-in the new
   `countSnapshots: []` field for every install). The bot's fixture seeds `localStorage` at
   `version: 6`.
   - **Before the bump:** a v6-tagged install was already "current" for a `version: 6` store - zustand
     persist's `migrate` callback never ran at all.
   - **After the bump:** `6 < 7` now triggers `scanStoreMigrate`'s `version >= 5` branch on load,
     which calls `backfillProducts(existingProducts)` - a **pre-existing** polish/structuring feature
     (unrelated to variance-report, unchanged by any of the 4 merges) that runs
     `structureProduct(name, brand)` on every product missing a `structuredModel`, to populate
     Brand/Model/Size columns for legacy rows.
   - The bot's fixture product has a deliberately messy raw `name`:
     `"UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet"`, and no `structuredModel`
     set (simulating a legacy/pre-structuring row). Running the structurer against this raw name **for
     the first time** (because the migration now runs, where it never did before) derives a
     `structuredModel` whose brand/junk-detection heuristics do not fully strip the leading "UPC
     <code> - " prefix or the trailing "Fits: ..." clause in this specific input shape.
   - `FinalCountTable.tsx`'s Name column already cleans its customer-facing value via
     `customerDisplayName()` (a small, dedicated render-only cleaner in
     `src/services/displayName.ts`, unrelated to any of the 4 merges) - but the Model column's
     `resolvedModel()` helper never applied that same cleaning, so the raw UPC prefix / fitment clause
     leaked straight into the Model column for a non-platform (customer) role. The bot's
     `body.innerText()` assertion correctly caught this leak.

   This is a genuine regression: the version bump is legitimate and necessary for the new feature, but
   it has the side effect of running a pre-existing backfill path for the first time on installs that
   had never exercised it, exposing a pre-existing gap in a different, unrelated column's
   customer-facing cleaning.

## Fix applied (app code)

`src/components/FinalCountTable.tsx`:
- `resolvedModel(product: Product)` -> `resolvedModel(product: Product, isPlatform: boolean)`. For a
  non-platform role, the resolved model string is now passed through
  `prettifyProductName(customerDisplayName(model))` - the exact same cleaning chain the Name column
  already uses. The platformOwner role is unaffected (still sees the raw `structuredModel`) -
  consistent with the documented "render-only, platformOwner keeps the full raw name" contract in
  `displayName.ts`.
- The row-render call site (`resolvedModel(displayProduct, isPlatform)`) now passes the role flag.
- The separate filter/search-index call site (`resolvedModel(r.product)` inside the `visibleRows`
  `useMemo`) intentionally passes `true` (i.e. "platform" / uncleaned) so the search index keeps
  matching the raw structured value for both roles - filtering behavior is a search index, not a
  rendered cell, and this keeps it byte-identical to before the fix.

`src/components/FinalCountTable.test.tsx`: added 2 regression tests under a new
`describe("FinalCountTable Model column customer cleaning (regression, 2026-07-12 merge-train gate)")`
block:
1. A customer-role row with a messy `structuredModel` (the exact bot fixture string) - asserts the
   rendered Model cell contains neither `"UPC 086699205636"` nor `"Fits"`.
2. The same row rendered as platformOwner - asserts the Model cell still contains `"086699205636"`
   (proving the cleaning is render-only and does not touch platform visibility).

**Verified the regression test actually catches the bug**, per the doctrine's regression-protection
rule: temporarily `git stash`-reverted only `FinalCountTable.tsx` (keeping the new test), reran -
test 1 failed with exactly the reported string (`"UPC 086699205636 - Defender LTX M/S Fits: 2004
Chevrolet"` not stripped); test 2 still passed (unaffected). Restored the fix (`git stash pop`),
reran - both pass. Full `FinalCountTable.test.tsx` suite: **15/15 passed** (13 pre-existing + 2 new).

Committed as `5f98363`: `fix(counts): clean customer-facing Model column + fix new e2e specs found by
merge-train gate` (combines the app-code fix + both e2e spec fixes, since they came out of the same
gate-failure investigation pass).

## Full gates - second pass (after the fix commit)

1. **`npm run proof:full`**: PASS.
   - `tsc --noEmit`: clean.
   - vitest: **203 files / 1946 tests passed, 30 skipped** (2 more than the first pass - the 2 new
     regression tests).
   - `next build`: succeeded (same pre-existing NFT warning, unrelated).

2. **`npm run test:e2e`**: PASS, **34/34**.

3. **`npm run qa:bots:all`**: PASS, **12/12** (including the previously-failing
   `customer-clean-names.spec.ts`).

## Files changed by the fix commit (5f98363)

```
 e2e/csv-import.spec.ts              |  6 ++---   (spec-only)
 e2e/variance-report.spec.ts         | 17 +++++++---   (spec-only)
 src/components/FinalCountTable.test.tsx |  ... (new regression tests)
 src/components/FinalCountTable.tsx  |  ... (app-code fix)
 4 files changed, 67 insertions(+), 11 deletions(-)
```

## Concerns / residual notes

- The Model-column cleaning gap was pre-existing (the structurer + `resolvedModel()` predate this
  merge train); the version-bump in variance-report only exposed it by running the backfill migration
  for the first time on a class of installs it had never touched. No other rendered column was found
  to carry the same gap in this pass - Brand/Size/Category/Specs cells do not carry free-text raw
  names the way Model does.
- Every persist-version bump going forward should be treated as a trigger for backfill/migration paths
  running on installs that previously skipped them - worth a note for future work touching
  `scanStoreMigrate`.
- Nothing was pushed at any point. The four `C:\tmp\wt-*` / `C:\tmp\inventory-*` worktrees listed by
  `git worktree list` are pre-existing and were never touched by this task; only disposable worktrees
  created under this session's scratchpad temp directory were used for bisection, all removed
  afterward.
- Working tree still carries the pre-existing unrelated dirty files noted at session start
  (`.claude/settings.local.json`, `.superpowers/sdd/task-3-report.md`,
  `.superpowers/sdd/task-6-report.md`, plus untracked `.serena/`, `mockups/`,
  `scripts/polish-eval-results.json`) - untouched by this task, left as found.

## Commit message footers

Every merge commit and the two additional commits (lockfile regen, regression fix) end with:
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013yU2vvVrFj9kuSYHTNUBp8
```
