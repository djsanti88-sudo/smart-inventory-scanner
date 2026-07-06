# auto-decode.spec.ts triage report

Date: 2026-07-05
Branch: feat/option-b-dryrun (HEAD at time of triage: 168db73)

## Status
FIXED. `e2e/auto-decode.spec.ts` is green; no cross-damage found.

## Commit
Spec-only adjudication fix committed separately (see `git log -1 -- e2e/auto-decode.spec.ts`
after this report lands). This report itself and the fix are in the same commit
`fix(e2e): auto-decode spec asserted the retired "suggested never counts" contract`.

## Root cause (two sentences)
The spec's failing assertion tested a contract that was already retired before this branch's
Build 1/2 work even started: commit `3669383` ("decode-everything — every scan counts, even with
no AI product", 2026-07-01, an ancestor of the branch's pre-Build-1 baseline `f92969b`) made every
scan that reaches decode land a provisional, unverified row in the final count regardless of
evidence strength, so a weak/"suggested" decode like `111111111119` ("Maybe Energy Bar") now
correctly appears in `final-count-body` — but `e2e/auto-decode.spec.ts` line 88 still asserted
`not.toContainText("Maybe Energy Bar")` from the pre-decode-everything world, and nothing in
Builds 1-2 (the GPT ladder rungs or the polish structurer) touched this file or this code path, so
the test had been silently stale (not run to completion, or not exercised) since before the branch
diverged rather than being broken by this session's work.

## Investigation trail (systematic-debugging Phase 1-2)
1. Ran `npx playwright test e2e/auto-decode.spec.ts` — failure was a single `expect(...).not.toContainText`
   at line 88: `final-count-body` contained `"Maybe Energy Bar"` when the test expected it absent.
2. Read `src/stores/scanStore.ts` around the evidence gate (`evidenceGatePassed`, lines ~2094-2136):
   confirmed a documented "DECODE-EVERYTHING provisional count" `else` branch that counts **every**
   scan reaching decode as an unverified/provisional product, independent of the evidence gate,
   citing "Owner rule: scan 10 = count 10."
3. `git log --oneline -S "DECODE-EVERYTHING" -- src/stores/scanStore.ts` found the originating
   commits `3669383` (decode-everything) and `8577e28` (suggested decodes provisionally count).
4. `git merge-base --is-ancestor 3669383 f92969b` → YES, and `git diff f92969b 168db73 -- src/stores/scanStore.ts`
   shows the provisional-count `else` block itself is byte-for-byte unchanged across the whole
   Build 1/2 window; the only related diffs in that region add a narrower, additive `gptTrusted`
   OR-branch to `evidenceGatePassed` (GPT ladder self-report trust tier), which never removes or
   weakens the provisional-count fallback.
5. `git diff f92969b 168db73 -- e2e/auto-decode.spec.ts` → empty. The spec file itself was not
   touched anywhere in Builds 1-2.
6. Confirmed the "scan N = count N" contract is intentional, documented design (not a bug to fix in
   product code): `docs/superpowers/plans/2026-07-01-plan-c-verified-suggested.md` and
   `docs/superpowers/plans/2026-07-01-count-decouple-breaker.md` describe exactly this provisional
   counting behavior, and a sibling currently-green spec `e2e/suggested-label.spec.ts` (last touched
   2026-07-01, well before this branch) explicitly asserts the opposite of the stale line: an
   unknown/weak-evidence scan DOES produce a `final-count-body` row ("scan N = count N invariant").
7. Attempted to run the spec directly at the pre-Build-1 baseline `f92969b` via `git worktree add`
   with a `node_modules` junction to avoid a second `npm ci`; Next.js Turbopack refused to resolve
   modules through the junction ("Symlink node_modules is invalid, it points out of the filesystem
   root"), so live confirmation at that exact commit was not obtained. This did not block the
   conclusion: steps 3-6 (source-level ancestry + diff + sibling spec) independently and
   sufficiently establish that the behavior predates the branch's Build 1/2 commits, per the
   "cheapest sound method" guidance in the task (reading the spec + source pinpointed the culprit
   without needing a running bisected server).

## Classification
(b) Genuinely stale spec whose assertion predates legitimate, already-shipped product behavior.
Not a regression from Builds 1-2 (GPT ladder rungs `c7f0480..f1adff2`, polish `8473e5e..4c278a9`).

## Fix
Updated `e2e/auto-decode.spec.ts` line 86-89: the comment and assertion for the weak/`suggested`
decode (`111111111119`, url_only evidence) now state and verify the current contract — the
evidence gate blocks a VERIFIED auto-add, but the scan still lands a provisional/unverified row in
`final-count-body` (assert `toContainText`, not `not.toContainText`). The subsequent assertions
(Needs Review row still visible at `review-row-111111111119`) were already correct and unchanged —
they still prove the item is NOT approved/aliased, only provisionally counted.

## Gates
- `npx playwright test e2e/auto-decode.spec.ts` — 1 passed.
- `npx vitest run` — 151 files / 1332 tests passed, 30 skipped (one stale `node_modules/.vite/vitest`
  cache entry for a since-deleted `src/stores/originProbe.test.ts` caused a spurious "Cannot find
  module" failure on the first run; cleared the cache directory — unrelated to this change — and the
  rerun was fully green).
- `npx tsc --noEmit` — clean, no output.
- Cross-damage re-run: `e2e/gpt-ladder-burst.spec.ts`, `e2e/polish-filter.spec.ts`,
  `e2e/batch-approve.spec.ts`, `e2e/fetchv2-count-contract.spec.ts` — 4 passed, no cross-damage.

## Cleanup
`git worktree remove ../inventory-wt-baseline --force` run after the baseline-run attempt;
`git worktree list` confirms no stray worktrees remain.
