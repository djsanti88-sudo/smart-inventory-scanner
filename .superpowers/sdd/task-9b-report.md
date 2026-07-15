# Task 9b Report: Inline suggestion approve/decline (suggestions bypass Needs Review)

Status: DONE (both coordinator decisions executed, including the Decision 1 addition). One
pre-existing e2e failure pair flagged (NOT mine - proven below).

## What was built

Owner-ratified rule: a decode whose decision is a SUGGESTION no longer sits in Needs Review. The
scan still counts immediately (count-decouple unchanged). The counted feed row gains
`suggestion: { productName, brand, confidence, status: "pending"|"approved"|"declined" }`, shown as
an honest "(suggested, NN%)" tag with pointer-only ✓/✕ controls. The review record is PARKED at a
new `UnknownCodeReview.status` value `"suggested"` (audit trail kept; dropped from the open
queue/badge; still shown on the /review Suggested tab for batch cleanup).

- APPROVED SEAM (Decision 1): inline routing fires only when `autoAddOn && !autoSuggestApplied &&
  decision.status === "suggested" && usable name && !contextConflict && !(tireScan && !fastWasVerified)`.
  The tire background-verify escalation is untouched and still owns its open review while running.
- DECISION 1 ADDITION: when `backgroundVerifyDeep` COMPLETES without verifying, the still-open
  suggestion-bearing review converts to the same pending inline state (guarded on open status,
  usable identity, autoAdd master switch, and a context-firewall re-check when the deep pass
  returned a NEW identity). Implemented cleanly - no races (the open-status guard makes duplicate
  deep responses no-ops).
- APPROVE (`approveSuggestion(scanEventId)`): no-op unless the row's suggestion is pending; locates
  the parked review (cleanCode, with reload-resilient provisionalProductId fallback) and calls
  `batchApprove([id])` - which IS the single-row human-approval path (`resolveUnknown "create_new"`,
  applyToCount, no origin, selectedAliasCodes = discovered identifiers). ZERO alias-writing logic
  was duplicated; idempotency keys, Phase-2 poison guard, dedup guard, and the no-double-count
  provisional upgrade are all inherited. `resolveUnknown`'s guard was widened to accept "suggested"
  (semantically still-awaiting-human; resolved/ignored stays a hard no-op).
- DECLINE (`declineSuggestion(scanEventId)`): no-op unless pending. Renames the counted provisional
  row to the Task 8 prefix floor (brand + "product unconfirmed") or the safe Unidentified
  placeholder FIRST, then (only then) creates/reopens the OPEN review via the existing
  `reopenNeedsReview` core with reason "Suggestion declined by operator - needs a correct name"
  (which also clears the declined suggestion fields so the Suggested pile can never re-offer it).
- BATCH SURFACE: `SuggestedApprovalPanel.isSuggestedRow` includes status "suggested"; its Reject
  calls the SAME declineSuggestion (reopenNeedsReview fallback after a customer reload);
  `batchApprove` accepts "suggested" reviews, settles the row tags on success, and on a no-op
  approve (identity-merge suggest_link / dedup conflict) honestly flips the review back to OPEN.
- MASTER SWITCH preserved: `autoAddDecodedProducts=false` still routes every decode to manual
  review (seam checks autoAddOn) - the pinning test was NOT flipped.
- Conflicts, genuinely-empty decodes, blocked-verified decodes, cap/failure paths: unchanged, all
  still create/keep open reviews (regression-tested).

## TDD evidence

1. Wrote `src/stores/scanStore.suggestionInline.test.ts` (7 tests: the brief's 4 + poison-guard
   inheritance + conflict-unchanged + empty-unchanged) on decodeCap's mocked-fetch scaffolding.
2. Ran: 5 failed (approveSuggestion/declineSuggestion undefined, review still open), 2 passed
   (the unchanged conflict/empty paths - expected).
3. Implemented types -> store routing -> actions -> guard widening -> batchApprove -> deep-completion
   addition. Reran: 7/7 green.
4. Component tests (LiveScanFeedSuggestion.test.tsx, +2): real ScanPage render, mocked fetch, real
   typed scan -> tag "(suggested, 30%)" + controls -> click ✓/✕ -> `document.activeElement` is STILL
   scanner-input (jsdom focus assertions, tabindex -1 asserted) -> alias approved / floor+review.
5. E2E (suggested-decode.spec.ts, +2 tests): mocked decode -> tag+controls visible + tabindex -1 ->
   approve -> tag clears + browser activeElement check -> rescan deterministic-known with POST
   counter proving NO second decode -> screenshots. Decline test: Pellicano prefix-floor rename +
   review opens with the honest reason.

## Test results (all mocked, zero live provider calls)

- `npx vitest run src/stores/ src/components/ src/eval/eval.test.ts`: 370/370 pass.
- Full `npm run test`: 2005 passed, 30 skipped (pre-existing skips), 0 failed.
- `npx tsc --noEmit`: clean. eslint on all touched files: clean (repo-wide script errors pre-exist).
- `npx playwright test e2e/suggested-decode.spec.ts`: 3/3 pass.
- Adjacent e2e (suggested-label, batch-approve, count-always, scanner-focus, auto-decode, decode):
  9/9 pass.
- Proof screenshots: `e2e/proof/suggestion-inline-pending.png`, `suggestion-inline-approved.png`,
  `suggestion-inline-declined.png` (gitignored per repo convention, kept locally).

## Trust-test migration (Decision 2 limits honored)

Files with ONLY the review-status expectation flipped "open" -> "suggested", each carrying the
mandated comment `owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)`; every
alias/verified/catalog/count assertion byte-identical:
autoDecode.test.ts (1), autoVerify.store.test.ts (1), backgroundVerifyDeep.store.test.ts (1, the
deep-completion addition), catalogFirst.test.ts (1), nonPublicAutoCount.store.test.ts (1),
retailResolve.store.test.ts (1), scanStore.gptLadder.test.ts (2), scanStore.test.ts (2 of 3 - the
autoAdd-off master-switch test was deliberately NOT flipped; the seam respects the switch instead).
E2E equivalents: batch-approve.spec.ts (fixture status filter widened), auto-decode.spec.ts (weak
suggestion asserted on the Suggested tab instead of an open review row; conflict row unchanged).
poisonGuard.store.test.ts needed NO changes (resolveUnknown accepting "suggested" keeps its direct
approval calls working; all its trust assertions pass unchanged).

## Self-review walk

| Walk | Result |
|---|---|
| Low-conf suggestion | counts (finalCounts 1), row pending tag, 0 open reviews, review parked "suggested" |
| Approve | approved idempotency-keyed alias, next scan deterministic-known, decode spy NOT called, qty 1->2 |
| Decline | floor/placeholder name (e2e: real Pellicano prefix floor), verified:false, count survives, exactly 1 OPEN review with honest reason |
| Double-tap approve | 1 alias, qty 1; decline-after-approve no-op |
| Double-tap decline | 1 open review; approve-after-decline no-op |
| Evidence-less approve | Phase-2 poison guard inherited: no approved alias, product unverified |
| High-trust >= 0.8 auto-apply | unchanged (original suggested-decode e2e + auto-apply store tests pass) |
| Conflict decode | still creates open review (store + e2e) |
| Empty decode | still creates open review |
| autoAddDecodedProducts=false | every decode still manual review (test unflipped, passing) |
| Tire background verify | escalation untouched; non-verified completion converts to pending inline (Decision 1 addition) |
| Scanner focus | retained after ✓ and ✕ in jsdom AND real browser; controls tabIndex -1 + mousedown preventDefault |
| Alias write path | approveSuggestion -> batchApprove -> resolveUnknown; zero new alias-writing code in the diff |
| Persist | additive status value, no version bump (old values remain valid); customer persist keeps review status+suggested fields so the Suggested tab stays actionable after reload; ScanEvent.suggestion is NOT added to the customer-safe allowlist (no new persisted surface; feed controls are in-session, batch surface covers reload) |

## Files changed

- src/types.ts (ScanEvent.suggestion; UnknownCodeReview.status + "suggested")
- src/stores/scanStore.ts (seam routing; deep-completion conversion; approveSuggestion;
  declineSuggestion; resolveUnknown guard widening; batchApprove extension)
- src/components/LiveScanFeed.tsx (tag + pointer-only controls)
- src/components/SuggestedApprovalPanel.tsx (include "suggested"; decline-aware Reject)
- src/stores/scanStore.suggestionInline.test.ts (new, 7 tests)
- src/components/LiveScanFeedSuggestion.test.tsx (+2 focus/behavior tests)
- e2e/suggested-decode.spec.ts (+2 tests, 3 screenshots)
- Migrated (status-only): 8 store test files + auto-decode.spec.ts + batch-approve.spec.ts

## Review fix (Important finding): NeedsReviewTable tolerates the "suggested" status

Reviewer finding: a review PARKED at status "suggested" with syncStatus "pending" (its value at
creation, scanStore.ts review mint) passed NeedsReviewTable's visible-rows filter via the second
clause (`r.syncStatus !== "synced"`) and rendered on the default All tab with a broken StatusBadge
(the `as "resolved" | "ignored"` cast fed "suggested" into undefined map/label lookups -> className
"... undefined", empty label) and resolved-row styling. Latent on the ASYNC Firebase cloud sync
path only (local mock sync is synchronous, which is why the e2e passed).

Fix (TDD, failing-first):
1. Tests written FIRST - `NeedsReviewTable.test.tsx` (+2): a parked "suggested" review with
   syncStatus "pending" does NOT render (and an open review beside it still does);
   `badges.test.tsx` (+1): `<StatusBadge status="suggested" />` renders a real "Suggested" label
   with no "undefined" in its className. Ran: 3/3 failed, reproducing the finding exactly.
2. `NeedsReviewTable.tsx` filter: `r.status !== "suggested" && (r.status === "open" ||
   r.syncStatus !== "synced")` - suggested reviews belong to the feed controls + the
   SuggestedApprovalPanel, never the queue, regardless of sync state.
3. Defense in depth: `StatusBadge` prop widened to `ScanStatus | "suggested"` with a real amber
   "Suggested" map/label entry; the unsafe cast at the badge call site removed (raw status passes
   through); `resolved` styling guard now `status !== "open" && status !== "suggested"`.

Commands + output:
- `npx vitest run src/components/NeedsReviewTable.test.tsx src/components/badges.test.tsx` ->
  before fix: 3 failed | 9 passed; after fix: 12 passed (12).
- `npx vitest run src/components/ src/stores/ src/eval/eval.test.ts` -> 373 passed (373), 61 files.
- `npx tsc --noEmit` -> exit 0. `npx eslint` on the 4 touched files -> exit 0.

## Flag for the coordinator (NOT mine, proven)

e2e/firewall.spec.ts and e2e/auto-count-tire.spec.ts fail on branch HEAD (93cca79) WITHOUT any of
my changes (verified by stashing my entire diff and rerunning: identical 2 failures; store-level
repro shows the poisoned VERIFIED decode with exactCodeEvidenceVerifiedByApp:true now auto-resolves
in tire context). Cause: Task 9's owner-ratified "app-verified exact code clears the tire category
hard-block" change did not update those two poison specs, which still assert the poison stays in
Needs Review. Those specs assert `decision.status "verified"` poison behavior - outside Task 9b's
suggestion scope and outside my authorized edit limits, so left untouched.
