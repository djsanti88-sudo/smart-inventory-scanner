# Build 3: Batch-Approve for the Suggested Pile - Report

Spec: `docs/superpowers/specs/2026-07-05-batch-approve-design.md` (owner-approved 2026-07-05).
Branch: `feat/option-b-dryrun`. Base: `4c278a9`.

## What was built

1. `src/services/discoveredIdentifiers.ts` - extracted `buildDiscoveredIdentifiers` (previously a
   private helper in `NeedsReviewTable.tsx`) into a shared, pure service so the single-approve row
   and the new batch-approve action can never drift on which discovered identifiers get approved by
   default. `NeedsReviewTable.tsx` now imports it (no behavior change - same function, same logic).

2. `batchApprove(reviewIds: string[])` on `scanStore.ts` (`src/stores/scanStore.ts`). Chunks
   `reviewIds` into groups of 25 and, for each id in order, calls the EXACT same path as the
   existing single-row "Approve suggestion" button: `resolveUnknown(id, "create_new", { applyToCount:
   true, origin: "human", newProduct: {...suggested* fields...}, selectedAliasCodes: <every
   discovered identifier> })`. No new approval semantics or trust rule - idempotency is
   `resolveUnknown`'s own open-status guard (unchanged). Per row:
   - not found -> `failed` with "Review not found"
   - already resolved/ignored (not open) -> silently skipped (neither approved nor failed) - matches
     `resolveUnknown`'s own idempotent no-op
   - no usable suggestion (`hasSuggestion` false or empty `suggestedProductName`) -> `failed` with
     "No suggestion to approve"
   - `resolveUnknown` throws -> caught, `failed` with the error message, loop continues
   - otherwise resolved (left "open") -> `approved`
   Returns `{ approved: string[], failed: Array<{ id, reason }> }`.

3. `src/components/SuggestedApprovalPanel.tsx` - the "Suggested" tab UI: checkbox per row,
   select-all, "Approve selected (N)" button, per-row "Reject" (calls `resolveUnknown(id, "ignore",
   {})` directly - the existing reject/ignore path, unchanged). Each row shows the suggested
   product name/brand, a read-only Build 2 structured-identity preview (brand/model/size chips,
   computed via the existing pure `safeStructuredFieldsFor` - display only, nothing persisted until
   approval), confidence %, source count, and the winning source link (`target="_blank"
   rel="noopener noreferrer"`). After an approve-selected click, a result banner shows "Approved N
   product(s)" plus a per-code failure list with reasons when any row failed.

4. `src/app/(app)/review/page.tsx` - added an "All" / "Suggested" tab switch (local UI state only).
   "All" renders the unchanged `NeedsReviewTable`; "Suggested" renders the new panel. Defaults to
   "All" so every existing e2e spec that loads `/review` is unaffected.

## Tests (TDD, RED confirmed first)

`src/stores/scanStore.batchApprove.test.ts` (7 tests, all initially failed with
`batchApprove is not a function` before implementation):
- approves N suggested rows; each creates its product and counts exactly once
- idempotent: a second call with the same ids approves 0, no double-count, no duplicate products
- per-row failure containment: a mocked `resolveUnknown` throw on the middle row lands in `failed[]`
  with its message; rows before and after it still approve
- 26-row batch (2 chunks) - no row dropped or double-counted across the chunk boundary
- a non-open row (already ignored) is skipped without being marked approved or failed
- a row with no usable suggestion is rejected with reason "No suggestion to approve" and the batch
  continues
- reject path: `resolveUnknown(id, "ignore", {})` moves the review to "ignored", keeps the
  suggestion fields as background info, and never creates a product

`e2e/batch-approve.spec.ts` (Playwright, all mocked via `page.route` on `/api/ai-lookup` -
`IS_E2E` webServer, zero live calls): seeds 6 unknown codes that decode as "suggested" with weak
(`url_only`) evidence (never auto-counted), goes to `/review` -> Suggested tab, selects all,
approves once, asserts the result banner + all 6 products land in the final count table with
quantity 1. Then proves re-approval is a no-op two ways: (a) the UI itself hides resolved rows so
there is nothing left to re-select, and (b) directly re-invokes the exposed dev-only
`window.__scanStore.getState().batchApprove(sameIds)` with the SAME review ids captured before the
first approval - asserts `approved.length === 0` and that `finalCounts` are byte-identical before
and after, then reloads the page and re-confirms all 6 counts persisted correctly. Screenshots in
`e2e/proof/batch-approve/` (`01-suggested-pile.png`, `02-approved.png`, `03-reapprove-no-op.png`).

## Gates

- `npx vitest run` (bare, not piped): **1332 passed, 30 skipped** (151 files passed, 7 skipped) -
  full suite green, no regressions.
- `npx tsc --noEmit`: clean.
- `npx eslint` on all touched files: clean.
- `npx playwright test batch-approve.spec.ts`: **1 passed**.
- Regression check: `npx playwright test auto-decode.spec.ts` fails on THIS branch, but reproduced
  identically on the base commit `4c278a9` with my changes stashed out (`git stash` / `git stash
  pop`) - confirmed PRE-EXISTING, unrelated to this task (an unrelated evidence-gate issue where a
  weak "suggested" decode auto-counts "Maybe Energy Bar" when it shouldn't). Not touched or fixed
  here; flagged as a pre-existing bug for a separate task, out of scope for Build 3.

## Files changed

- `src/stores/scanStore.ts` (added `batchApprove` action + interface entry + import)
- `src/components/NeedsReviewTable.tsx` (refactor only: import `buildDiscoveredIdentifiers` from
  the new shared service instead of a private local copy)
- `src/app/(app)/review/page.tsx` (All/Suggested tabs)
- `src/services/discoveredIdentifiers.ts` (new, extracted pure helper)
- `src/components/SuggestedApprovalPanel.tsx` (new)
- `src/stores/scanStore.batchApprove.test.ts` (new)
- `e2e/batch-approve.spec.ts` (new)
- `e2e/proof/batch-approve/*.png` (new proof screenshots)

## Concerns / notes

- `auto-decode.spec.ts` has a pre-existing failure on `master`/this branch's base, unrelated to
  Build 3 (see above). Recommend a follow-up task; not fixed here to stay in scope.
- Batch approval's default alias selection (every discovered identifier approved) mirrors the
  single-row button's default UI state (all checked, human unchecks to exclude) since there is no
  per-row checkbox interaction in a bulk operation. If the owner wants a different default for bulk
  (e.g. never auto-approve discovered identifiers in a batch), that is a one-line change in
  `batchApprove`'s `selectedAliasCodes` computation.
- The Suggested tab is visible to all roles (matching the existing "Approve suggestion" button,
  which is not platform-gated); raw/clean code columns stay platform-owner-only, consistent with
  the rest of the review screen.

## Build 3 review fixes (2026-07-05)

Environment note: `node_modules` was empty at the start of this task (0 bytes) - restored via
`npm ci` from the committed `package-lock.json` before any gate could run. Not a new dependency
decision, just recreating the project's own locked deps; noted for the record.

### Finding 1 (HIGH, trust rule violation) - FIXED

`batchApprove` passed `origin: "human"` to `resolveUnknown`, which disables the weak-guess poison
guard at the two provisional-reuse branches in `resolveUnknown`
(`isWeakGuessReuse = isWeakGuess(review, np) && payload.origin !== "human"`,
`src/stores/scanStore.ts` ~L2828/L2862), while the single-approve button
(`NeedsReviewTable.tsx` "Approve suggestion") passes no `origin` field at all and keeps the guard
active. Net effect: a zero-evidence AI suggestion (empty brand, no gtin/upc/ean, no `sourceUrls`)
landed `verified: true` / `provisional: false` via batch but stayed `verified: false` /
`provisional: true` via the single button - a real trust-rule divergence, violating the spec
invariant "Trust rules do NOT change."

Fix: removed `origin: "human"` from `batchApprove`'s `resolveUnknown` call so its payload now
matches the single-approve button's payload exactly (same keys, no `origin`). Updated the
`batchApprove` interface docstring and the in-function comment to state this explicitly so it
cannot regress silently.

TDD: added `src/stores/scanStore.batchApprove.test.ts` ->
`describe("scanStore - batchApprove trust rule parity (Build 3 review Finding 1)")` with a
`weakSuggestedReview` helper (hasSuggestion true, empty brand, empty `sourceUrls`, no gtin/upc/ean
- `isWeakGuess` true). Two tests:
- RED confirmed first on the pre-fix code: `batchApprove` on a weak suggestion asserted
  `product.verified === false` / `product.provisional === true` and failed with
  `expected true to be false` (the bug reproduced exactly as predicted).
- After the fix: both the batch test and a parity-baseline test (calling `resolveUnknown` directly
  with the exact no-`origin` NeedsReviewTable payload) pass, proving batch and single now agree.
- Also added an explicit STRONG-evidence test (`brand` + one `sourceUrl`) confirming batch approval
  still fully verifies (`verified: true`, `provisional: false`) - existing behavior unchanged.

### Finding 2 (Medium, doc-only) - FIXED

The 25-row chunking in `batchApprove` was cosmetic: no per-chunk `set()`, no `await`/tick boundary,
the whole loop (all chunks) runs in one synchronous pass. The comment above it previously implied
more than that. Reworded the comment (and the interface docstring, which said "25/commit") to state
plainly what chunking provides - per-row containment inside a bounded, readable slice - and what it
does NOT provide - no state isolation between chunks, no resumability, single synchronous tick. No
behavior change.

### Finding 3 (Low) - FIXED

`SuggestedApprovalPanel.tsx`: a row with zero `sourceUrls` now renders a visible "No sources" marker
(`data-testid="suggested-no-sources-<cleanCode>"`, plain text, no em/en dash) next to the source
count instead of just showing "0" with no link, so a bulk approver scanning a long list can spot and
skip evidence-free rows. Added `src/components/SuggestedApprovalPanel.test.tsx` with two tests: the
marker renders for a source-less row and does not render for a row with a real source URL.

### Gates (all run bare, not piped)

- `npx vitest run src/stores/scanStore.batchApprove.test.ts`: RED confirmed pre-fix (1 failed, the
  predicted assertion), GREEN post-fix (10 passed).
- `npx vitest run src/components/SuggestedApprovalPanel.test.tsx`: 2 passed.
- `npx vitest run` (full suite): **1337 passed, 30 skipped** (152 files passed, 7 skipped) - up from
  the prior 1332 passed by exactly the 5 new tests added (2 Finding 1 + 1 strong-evidence parity +
  2 Finding 3), no regressions.
- `npx tsc --noEmit`: clean.
- `npx playwright test e2e/batch-approve.spec.ts`: 1 passed (no changes needed to the e2e spec -
  the trust-rule fix does not change the spec's weak/`url_only` fixture behavior, since that fixture
  already exercises the fresh-mint path where the guard was never origin-gated).

### Files touched in this fix pass

- `src/stores/scanStore.ts` (removed `origin: "human"`; corrected chunking comment + docstring)
- `src/stores/scanStore.batchApprove.test.ts` (new Finding-1 trust-parity tests + strong-evidence test)
- `src/components/SuggestedApprovalPanel.tsx` (no-sources marker)
- `src/components/SuggestedApprovalPanel.test.tsx` (new)

### Concerns / notes

- Environment had to be restored via `npm ci` (see note above) before any gate could run at all.
- `e2e/batch-approve.spec.ts` was left untouched - its fixtures already used weak (`url_only`)
  evidence that never auto-counted, so it did not need updating to exercise the Finding 1 fix; the
  new unit tests are the ones that pin the trust-rule regression directly.
