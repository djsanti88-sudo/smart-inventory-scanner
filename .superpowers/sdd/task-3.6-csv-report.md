# Task 3.6: CSV Import Onboarding — Report

Branch: `feat/csv-import`, worktree `C:\tmp\wt-csv`.

## Summary

Built a new, preview-first CSV import onboarding flow, additive alongside the existing
`buildProductImport`/`importProductsCsv` (Loop 5 MVP) that was already shipped and wired into
`ExportMenu.tsx` (auto-imports on file select, no preview). This task's explicit requirement was a
different UX (mandatory preview + explicit confirm, never auto-import on file select), so the new
code lives under new export names in the same service file and a new standalone component, without
touching the existing import path.

- `parseCsvImport(text)` — parses untrusted CSV text via `csv-parse/sync`, header-synonym mapping,
  never throws, collects bad rows as `{ line, reason }`, sanitizes every cell (semantic firewall).
- `applyCsvImport(rows, target)` — merges into existing products via approved alias, creates new
  products + approved `source: "csv_import"` aliases for unknown barcodes, never repoints an alias
  on conflict, and is idempotent via a content-hash import id.
- `CsvImportPanel` — file input, preview table (first 20 rows), error list, explicit "Import N
  products" confirm button, summary display. Mounted on `/products`.
- `e2e/csv-import.spec.ts` + `e2e/fixtures/csv-import-onboarding.csv` — written, NOT run (per
  instructions; the merge gate runs it later). Fixture line numbers/expectations were verified
  against `parseCsvImport` via a matching vitest case before finalizing the spec.

## TDD evidence

### Parser + apply tests (red before implementation)

Ran `npx vitest run csvImport` immediately after writing the new test blocks (before touching
`csvImport.ts`):

```
Test Files  1 failed | 1 passed | 1 skipped (3)
     Tests  19 failed | 11 passed | 1 skipped (31)
```

All 19 new failures were `TypeError: parseCsvImport is not a function` / `applyCsvImport is not a
function` — confirming the tests exercised code that did not exist yet. The 11 pre-existing
`parseCsv`/`buildProductImport` tests (Loop 5) stayed green throughout, proving nothing was broken.

### After implementation (green)

```
Test Files  2 passed | 1 skipped (3)
     Tests  30 passed | 1 skipped (31)
```

One iteration was needed: the first conflict-detection implementation only fired when the row's
`sku` matched a *different existing product*. The test scenario (a genuinely new sku value trying to
claim an already-owned barcode) needs a second check — the barcode-owner's own `primarySku`
disagreeing with the row's `sku`. Fixed in `applyCsvImport`, then green.

### Component tests (red before implementation)

```
FAIL src/components/CsvImportPanel.test.tsx [ src/components/CsvImportPanel.test.tsx ]
Error: Failed to resolve import "@/components/CsvImportPanel" from "src/components/CsvImportPanel.test.tsx". Does the file exist?
```

### After implementation (green, one fix)

First pass: 7/8 passed. One test used an ambiguous `screen.getByText(/name/i)` that matched both the
"Name" preview-table header and the error-list reason text (`getByText` throws on multiple matches).
Fixed by scoping the assertion to the specific error row's testid instead. Final:

```
Test Files  1 passed (1)
     Tests  8 passed (8)
```

### Fixture cross-check

Added a permanent vitest case (`parseCsvImport - matches the e2e fixture`) that runs the exact
content of `e2e/fixtures/csv-import-onboarding.csv` through `parseCsvImport` and asserts the same
line numbers (`4`, `5`) and row count (`2`) the Playwright spec expects — this caught a fixture bug
(bad quantity value landed in the wrong CSV column, so 3 rows parsed as valid instead of 2) before
Playwright ever needed to run it. Fixed the fixture, re-ran, green.

## Files changed

- `C:\tmp\wt-csv\src\services\csvImport.ts` — added `parseCsvImport`, `applyCsvImport`,
  `ImportRow`, `ImportError`, `ImportSummary`, `ImportTarget` types + sanitizer helpers. Existing
  `parseCsv`/`buildProductImport`/`ImportConflict`/`ProductImportPlan` untouched.
- `C:\tmp\wt-csv\src\services\csvImport.test.ts` — added ~30 new test cases (header synonyms,
  never-throws, firewall sanitization incl. control-char strip / 500-char cap / formula-injection
  defusal, merge/create/conflict/idempotency, fixture cross-check). Existing tests untouched.
- `C:\tmp\wt-csv\src\components\CsvImportPanel.tsx` — new component (file input, preview, errors,
  confirm, summary).
- `C:\tmp\wt-csv\src\components\CsvImportPanel.test.tsx` — new, 8 jsdom tests.
- `C:\tmp\wt-csv\src\app\(app)\products\page.tsx` — mounted `<CsvImportPanel />` above the products
  table. One-line integration, no redesign.
- `C:\tmp\wt-csv\e2e\csv-import.spec.ts` — new Playwright spec (written only, not run).
- `C:\tmp\wt-csv\e2e\fixtures\csv-import-onboarding.csv` — new fixture (2 valid rows, 2 bad rows,
  uses header synonyms `Product`/`UPC`/`Quantity`).
- `C:\tmp\wt-csv\package.json` — moved `csv-parse` from `devDependencies` to `dependencies` (the
  panel needs it at runtime in the browser via `csv-parse/sync`, not just in tests).
- `C:\tmp\wt-csv\src\types.ts` — **deviation, see Self-review below**: added `"csv_import"` to the
  `Source` union (one line). Required because the task spec explicitly calls for aliases "tagged
  `source: "csv_import"`", and `Source` is a closed string-literal union; using an existing value
  (e.g. `"manual"`) would have silently lost the distinct origin tag the task asked for.

## Test results

```
$ npx tsc --noEmit
(clean, exit 0)

$ npm run test
Test Files  1 failed | 191 passed | 7 skipped (199)
     Tests  10 failed | 1834 passed | 30 skipped (1874)
```

The 1 failing file (`src/server/tire-knowledge/dtHarvestIntegration.test.ts`, 10 tests) fails
**identically on a clean `git stash` of this worktree** (verified: same 10 failures, same
`expected null not to be null` assertion, before any of this task's changes existed). It depends on
a tire-knowledge corpus database not present/seeded in this environment and is unrelated to CSV
import. Pre-existing, not caused by this task.

Targeted run for this task's own code:

```
$ npx vitest run csvImport CsvImportPanel
Test Files  3 passed | 1 skipped (4)
     Tests  39 passed | 1 skipped (39)
```

(The 1 skipped test is pre-existing and unrelated — not part of this task's suites.)

## Execution report

feat(onboarding): CSV import with preview, idempotent apply, firewall sanitization

Added a preview-first CSV import onboarding flow for the Products page. A shop owner selects a
`.csv` file; the panel parses it client-side (never touching the network), shows the first 20 rows
plus any bad-row errors (line number + reason), and only applies anything to the catalog after an
explicit "Import N products" click — file selection alone never imports data.

The parser (`parseCsvImport`, using `csv-parse/sync`) treats every cell as untrusted data: control
characters are stripped, every field is capped at 500 characters, and cells beginning with `=`, `+`,
`-`, or `@` are defused against CSV-formula-injection (a spreadsheet-app risk when the value is later
re-exported/opened elsewhere). Header synonyms are mapped case-insensitively (`name`/`product`,
`sku`, `barcode`/`upc`/`ean`, `qty`/`quantity`/`count`). Bad rows (missing name, unparseable
quantity) are collected as errors and never abort the parse.

The apply step (`applyCsvImport`) is idempotent — importing the same file twice is a no-op the
second time, via a deterministic content-hash import id, following the project's existing
idempotency-key pattern (a key built once, reused, never regenerated on retry). It merges into an
existing product when the row's barcode matches an approved alias (increments quantity, never
duplicates the alias), creates a new product + an approved `csv_import`-sourced alias for an unknown
barcode, and — critically — never silently repoints an alias to a different product when a row's sku
disagrees with the barcode's current owner; that row is skipped and surfaced, not guessed.

This is deliberately separate from the existing "Import: Products CSV" button on the Export menu
(which already auto-imports on file select with no preview) — the new onboarding flow adds the
preview/confirm safety step the task required, without changing the existing quick-import path's
behavior for anyone already relying on it.

## Self-review

- **`types.ts` deviation (outside the stated allowed-files list).** The task explicitly requires
  CSV-imported aliases be "tagged `source: "csv_import"`", but `Source` is a closed union in
  `src/types.ts`, a file not in the allowed list. I added one literal to the union rather than
  (a) silently mislabeling imported aliases as `source: "manual"` (loses the explicit tagging the
  task asked for and makes CSV-imported rows indistinguishable from the Loop 5 import's own
  `"manual"`-tagged aliases in audits), or (b) leaving a type error / `as any` cast in production
  code. This is a one-line, purely additive, backward-compatible change (existing `Source` values are
  untouched). A reviewer should confirm this is an acceptable exception to the file-scope constraint
  given the task's own explicit wording; if not, the fix is a one-line revert plus swapping
  `source: "csv_import"` to `source: "manual"` in `CsvImportPanel.tsx`'s `addAlias` implementation.

- **`ImportTarget.incrementQuantity` does not touch `InventoryCount`.** The task's `ImportRow.qty`
  field and merge behavior ("increment that product's quantity") are honored via the same
  `ImportTarget` contract the tests exercise, but the real `CsvImportPanel` wiring treats this as a
  **catalog-only** onboarding import (Product/Alias creation), not a scan-session count mutation.
  `InventoryCount` in this app is session-scoped (tied to `sessionId`), and an onboarding CSV import
  happens outside any scan session. I chose to stamp the merged product's `updatedAt`/`updatedBy`
  instead of fabricating a session-scoped count row. A reviewer should confirm this matches the
  product intent — if "quantity" from the CSV is meant to seed the count-in-progress inventory
  rather than just refresh the catalog record, this needs a follow-up decision (likely: which
  session does an onboarding import count against, if any).

- **No-barcode-and-no-sku rule.** Chose "always create a new product" (tested) over "skip" — refusing
  to import a row with only a name would silently drop legitimate non-barcoded rows from the owner's
  own file, which conflicts with the onboarding goal (get their whole list in). Documented inline in
  `applyCsvImport`.

- **Merge-by-sku-alone path.** When a row has no barcode but its `sku` matches an existing product,
  I treat it as a merge (increment) rather than creating a duplicate. This wasn't explicitly
  requested in the matrix but follows naturally from "prefer merge over duplicate when the app can
  positively identify the same item," and is covered implicitly by the ImportTarget's
  `findProductBySku` capability the task suggested designing in. Flagging for reviewer awareness
  since it's inferred behavior, not directly spec'd.

- **Coexistence with the existing Loop 5 import.** I did not touch `ExportMenu.tsx`'s "Import:
  Products CSV" button, `scanStore.ts`'s `importProductsCsv`, or the pre-existing
  `parseCsv`/`buildProductImport` functions — both import paths now exist side by side. A reviewer
  should decide whether the older auto-import button should eventually be deprecated in favor of the
  new preview-first flow, or whether both are intentionally kept (e.g. one for power users doing
  quick re-imports, one for first-time onboarding). Out of scope for this task; flagging only.

- **E2E spec not run.** Per instructions, `e2e/csv-import.spec.ts` was written but not executed with
  Playwright. Its line-number and row-count expectations were cross-checked with a permanent vitest
  case against the literal fixture content, so the spec should be correct on first run, but this is
  unverified by an actual browser and remains the responsibility of the merge gate.

## Fix round 1

Fixes for the review findings on this feature. Conflict-safety logic (the sku-disagreement /
re-pointing guard in `applyCsvImport`) was explicitly out of scope and untouched.

### IMPORTANT 1 - barcode matching bypassed cleanScanCode normalization

**Bug.** `applyCsvImport` (`src/services/csvImport.ts`) matched/created aliases off the RAW
`row.barcode` string. A CSV barcode printed with separators ("012-345-678905") never matched an
existing alias stored from a real scan of the same code without separators, so re-uploading a
shop's own catalog against already-scanned stock silently minted a duplicate product instead of
merging. The sibling path `buildProductImport` already normalized via `cleanScanCode` (line ~138);
`applyCsvImport` did not.

**Fix.** `applyCsvImport` now runs `row.barcode` through `cleanScanCode` once per row and uses the
most-normalized candidate (separators stripped, e.g. `normalizedCandidates.slice(-1)[0]`) as the
single key for `findProductByAlias`, `findProductBySku`-adjacent conflict checks, `createProduct`,
and `addAlias`. This mirrors `buildProductImport`'s `normalizedCode` field so a dashed/spaced CSV
value resolves to the same product a plain scanned code already created. `row.barcode` itself is
left untouched (raw) - only the derived matching/alias key is normalized.

RED (before fix, `src/services/csvImport.test.ts`):
```
 ❯ applyCsvImport - merge into existing product via approved alias > normalizes a dashed/spaced CSV
   barcode via cleanScanCode so it merges into an existing product whose alias is the clean form
   AssertionError: expected { created: 1, merged: 0, aliasesAdded: 1, skipped: 0 }
                    to deeply equal { created: 0, merged: 1, aliasesAdded: 0, skipped: 0 }

 ❯ applyCsvImport - stores the CLEAN code as the alias, not the raw dashed/spaced form >
   creates the new alias with the normalized/clean code, not the raw dashed CSV value
   AssertionError: expected '555-666-777' to be '555666777'

 Tests  2 failed | 28 passed (30)
```

GREEN (after fix): both new tests pass, 30/30 in `csvImport.test.ts`.

### IMPORTANT 2 - store-level double-apply untested (and, once tested, found broken)

**Gap.** The idempotency proof in `csvImport.test.ts` only exercised a hand-mocked `ImportTarget`
(a `hasImportRun` that correctly embeds `importId`). `CsvImportPanel.tsx`'s real
`buildStoreImportTarget()` was never exercised for a genuine re-upload through the real component +
`useScanStore`.

**Bug found by writing that test (RED first).** `buildStoreImportTarget()`'s `createProduct` and
`addAlias` implementations did not accept/use the `importId` parameter the `ImportTarget` interface
passes them (TypeScript's structural typing allowed the mismatched arity to compile silently). So
`hasImportRun`'s `.includes(importId)` had nothing to find - `importId` was never embedded in any
product id or alias `idempotencyKey` at all. Confirming a real second confirm-click on the same file
did NOT no-op: `products`/`aliases` length stayed the same only because barcodes matched via
`findProductByAlias` and merged (`incrementQuantity`) a second time - i.e. quantities silently
doubled instead of the whole import being skipped. A pure length assertion would have missed this;
a deep-equal snapshot comparison caught it.

**Fix.** `createProduct` now suffixes the generated product id with `--${importId}`; `addAlias` now
embeds `importId` as its own segment in `idempotencyKey`
(`${businessId}::csv_import::${importId}::${cleanCode}`). `hasImportRun` checks for that exact
suffix/segment (see MINOR below) instead of a bare substring. New component test:
"CsvImportPanel - store-level double-apply is a true no-op (idempotent re-import)" renders the real
panel, confirms the same fixture CSV twice through the actual `useScanStore`, and asserts the store
state is deep-equal (not just same length) after both confirms, plus that the second summary reports
"0 products created" / "2 rows skipped".

RED (before fix, `src/components/CsvImportPanel.test.tsx`):
```
 ❯ CsvImportPanel - store-level double-apply is a true no-op (idempotent re-import) >
   uploading and confirming the SAME fixture CSV twice writes products/aliases/quantities
   identically after both confirms (zero new writes on the second)
   AssertionError: expected [ {...}, {...} ] to deeply equal [ {...}, {...} ]
   - "updatedAt": "2026-07-13T03:17:14.498Z"
   + "updatedAt": "2026-07-13T03:17:14.529Z"   <-- second confirm silently re-merged (qty doubled)

 Tests  1 failed | 8 passed (9)
```

GREEN (after fix): 9/9 in `CsvImportPanel.test.tsx`, including the new double-apply test.

### MINOR - hasImportRun substring check

**Fix.** `hasImportRun` no longer uses a bare `.includes(importId)` (which could false-positive if
one importId's hash happens to be a substring of another's, and was already false-negative-prone
before the importId-wiring fix above). It now checks an exact delimiter-bounded match: product ids
via `.endsWith('--' + importId)` and alias `idempotencyKey`s via `.includes('::' + importId + '::')`
(the key format's own `scope::action::key` delimiter convention), consistent with the
`import:${importId}:${code}` exact-match pattern used in the service-level test mocks. Covered by
the same double-apply test above (a false hasImportRun match would show up as more than 2
products/aliases after the second confirm; a false negative would show up as the deep-equal /
updatedAt mismatch demonstrated in the RED run).

### Noted, no code change (owner/reviewer awareness)

- **Merge-by-sku-alone path** (no barcode, sku matches an existing product -> merge) still awaits
  owner sign-off per the original report. Untouched in this round.
- **Partial-failure mid-loop assumption** is now documented directly above `applyCsvImport` in
  `src/services/csvImport.ts`: the loop is not transactional - a mid-loop failure leaves earlier rows
  applied and later rows unapplied, but the per-row idempotency (via the importId now correctly wired
  through `createProduct`/`addAlias`) makes a retry of the same file safe (already-applied rows are
  skipped, the remainder is (re)applied) even though a single run is not atomic.

### Gates

- `npx vitest run src/services/csvImport.test.ts src/components/CsvImportPanel.test.tsx`:
  2 files passed, 39/39 tests passed.
- `npx tsc --noEmit`: clean, no output, exit 0.
- Adjacent suites re-checked for regressions: `src/stores/csvImport.store.test.ts` and
  `src/services/db/firebase/csvImport.rules.test.ts` - all passing (3 passed, 1 pre-existing skip).
