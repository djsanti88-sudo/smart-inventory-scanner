# Phase A — Decode recall + transparency (decouple "show" from "auto-count")

> Status: PLAN ONLY (build nothing until owner approves). Author: Claude Code, 2026-06-28.
> Branch base: `tire-barcode-db`. Direction locked in the prior session (#1: keep the strict gate for
> counting; always show the best lead + why it was not counted).
> Memory: [[decode-recall-transparency]], code map [[where-decode-lives]].

## 1. The actual problem (grounded in the code, not the vibe)

The owner scanned a Home Depot bucket (`051596320812`) and Needs Review came back blank, while
ChatGPT-the-chat could show a candidate + sources at "medium confidence." The thread blamed "the
auto-count gate deciding visibility." Reading the code, the truth is more specific:

**What already works (do NOT rebuild):**
- `decideDecode` ([src/services/ai/decode.ts:220-248](src/services/ai/decode.ts)) already returns
  `"suggested"` with the best result for ANY usable identity; `"needs_review"` is reserved for "no
  provider produced a product." Its own comment: *"We never bury a real provider result in a blank
  Needs Review."*
- `liveDecode` success branch ([src/stores/scanStore.ts:1632-1675](src/stores/scanStore.ts)) ALWAYS
  sets `hasSuggestion: true` and maps `best = results[0]` into `suggestedProductName` / `sourceUrls` /
  `decodeProviderSummaries` / evidence fields — regardless of `decision.status`. So suggested,
  conflict, and verified-but-not-auto-counted already populate the suggestion block.
- `NeedsReviewTable` ([src/components/NeedsReviewTable.tsx:163-205](src/components/NeedsReviewTable.tsx))
  already renders the badge, evidence strength, candidate name+brand, provider summaries, verified
  facts, guesses, source links, an "Approve suggestion" button, and a `"No product identified - check
  the sources below"` fallback.
- The route already computes an honest `reasonText` (rate_limited / timeout / not_found_after_search /
  fallback) and the store prefers it over generic gate text ([scanStore.ts:1791](src/stores/scanStore.ts)).
- The route recomputes `decideDecode` on `run.results` and IGNORES `run.decision`
  ([route.ts:365](src/app/api/ai-lookup/route.ts)) — so for the fast path a partial that arrived
  before the budget already survives a timeout.

**The three real gaps (this is Phase A's whole scope):**

- **G1 — The orchestrator discards the best-partial on timeout.** `runDecode` budget-hit returns a
  blank `timedOutDecision` ([decodeOrchestrator.ts:86-95, 208-211](src/services/ai/decodeOrchestrator.ts)).
  The fast path masks this by recomputing, but (a) the deep-fallback finder `ai-deep` calls `runDecode`
  directly and gets the blank, and (b) the orchestrator's tested CONTRACT says "never partial," so the
  guarantee is accidental, not designed. A usable result that arrived at 9s but wasn't verified by 13s
  is correctly kept by the route today — but nothing proves it stays that way.

- **G2 — The provider attempt trail is computed then dropped.** The route returns rich
  `providerStatuses` (per provider: `timeout` / `rate_limited` / `error` / `no_match`, latency, source
  count) but `liveDecode` NEVER stores it. On a true empty-results timeout, `results` is `[]`, so `best`
  is null, `decodeProviderSummaries` is `[]`, and the human sees a reason string but NOTHING about what
  was tried. This is the literal "ChatGPT shows what it tried; ours is blank" gap.

- **G3 — On an empty-results outcome, no leads are surfaced.** When `results` is `[]` (all providers
  timed out / errored), there is no candidate AND no source links — even if a provider had cited URLs
  before dying. ChatGPT's value in that moment is "here are the sources I found, you decide." We throw
  them away.

Phase A fixes exactly G1–G3 by reusing the EXISTING single-suggestion fields + adding ONE new field
(the attempt trail). Multi-candidate `suggestions[]`, evidence-tier UI, and one-click per-candidate
"Use this" are explicitly **Phase B**, not this.

## 2. Acceptance criteria

1. **Auto-count behavior is UNCHANGED.** The `>=0.8` evidence gate, brand-prefix conflict block, tire
   spec gate, and firewall all behave identically. No code that currently auto-counts stops, and
   nothing that is currently blocked starts auto-counting. (Locked by re-running the existing
   autocount/decode test suites unchanged.)
2. **Best-partial on timeout.** When the budget fires but a usable product arrived before it, the
   decode resolves to `"suggested"` (shown, not counted) with that product + its sources + a reason
   that says it ran out of time verifying. Only a genuinely empty result → blank `needs_review`.
3. **Attempt trail always present.** Every decode that reaches the store (success OR empty-result)
   records the per-provider attempt trail (provider, status, source count) on the review. The
   platformOwner sees it in Needs Review; the customer view stays clean (no "AI"/provider mechanics).
4. **Leads on a miss.** When no usable product is identified but a provider cited source URLs, those
   links are shown in the review.
5. **Every non-auto-count row carries a human-readable "why not counted" reason** (weak evidence /
   below threshold / vendor code / timeout / rate-limited / conflict / not found). No blank-reason row.
6. **No new auto-count path, no trust downgrade-to-count.** "Show" never implies "count."
7. Gates green: `npm run test` (unit), `npx tsc --noEmit`, `npx eslint src e2e`, `npx next build`,
   `npx playwright test` — no live AI tokens (mocks + `IS_E2E=1`).

## 3. Design / changes by file (smallest safe change)

### 3a. `src/services/ai/decodeOrchestrator.ts` — best-partial on timeout (G1)
- On budget-hit, instead of unconditionally returning `timedOutDecision`, run
  `decideDecode({ codeType, results, evidences, confidenceThreshold })` on whatever arrived.
  - If that decision is `"suggested"`/`"conflict"`/`"verified"` (i.e. a usable identity exists), return
    it with `timedOut: true` (keep the honest timeout note appended to `reason`).
  - If results have no usable identity, return the existing `timedOutDecision` (true blank).
- Update the file's top comment + the `requireVerifiedEarlyExit` note to reflect "best-partial on
  timeout is intentional; counting still requires the full gate downstream." This makes the route's
  current behavior the *designed, tested* behavior and fixes the `ai-deep` direct caller.
- IMPORTANT: this does NOT change auto-count. `timedOut` results never satisfy the store's
  `evidenceGatePassed` unless they independently pass the >=0.8 + corroboration gate (which a timed-out
  partial won't, because it isn't verified). It only changes what is SHOWN.

### 3b. `src/types.ts` — one new optional field (additive, no persist bump)
- Add to `UnknownCodeReview`:
  `decodeAttempts?: { provider: string; status: string; sources: number }[];`
  (Optional → no `persist` version bump, read defensively. Mirrors the existing
  `decodeProviderSummaries?` pattern.)

### 3c. `src/stores/scanStore.ts` — populate the trail + handle empty results (G2, G3)
- In the `liveDecode` success `set(...)` (≈1632): add
  `decodeAttempts: (data.providerStatuses ?? []).map(p => ({ provider: p.provider, status: p.status, sources: p.sourceUrlsReturned }))`.
- When `results` is empty but the response came back (timeout/all-miss): still set `decodeAttempts`,
  set `hasSuggestion` to `(best is usable) || sourceUrls.length > 0 || decodeAttempts.length > 0` so the
  block renders the trail/leads instead of the bare "No suggestion", and keep the honest `reason`.
- Carry leads on a miss: `sourceUrls` already comes from `best?.sourceUrls`; ensure that when `best`
  has no usable name we still keep its `sourceUrls` (already true) — add a test to lock it.
- The network-error `catch` branch (≈1845): no change required (no data exists), but set
  `decodeAttempts: []` explicitly for consistency and keep the retry affordance.
- No change to `processScan` (auto-decode on scan) — it already routes through `liveDecode`, so both the
  live-scan and the manual "Live decode" button get the fix from one place.

### 3d. `src/components/NeedsReviewTable.tsx` — render the trail (platformOwner only)
- In the suggestion cell, when `isPlatform && review.decodeAttempts?.length`, render a compact line:
  `Tried: gemini (timeout), openai (rate_limited 0 src)` using existing muted styling
  (`text-zinc-500`), `data-testid="decode-attempts"`.
- Widen the render condition so the block shows when there's a trail even with no product:
  `review.hasSuggestion || (review.sourceUrls?.length ?? 0) > 0 || (review.decodeAttempts?.length ?? 0) > 0`.
- Customer view: attempt trail stays hidden (it's `isPlatform`-gated); customers keep the clean
  "Suggested product" / "check these" language. No "AI"/provider words leak (honors the de-brand rule).

## 4. Tests (TDD: write/extend first, watch them fail, then implement)

- **`src/services/ai/decodeOrchestrator.test.ts`** (extend): (a) budget fires AFTER a usable result
  arrived → decision `"suggested"`, `timedOut: true`, product present; (b) budget fires with NO result
  → `"needs_review"`, blank. Locks G1 as a contract, not an accident.
- **`src/services/ai/decode.test.ts`** (extend): assert `reason` is non-empty for every non-verified
  branch (weak evidence, below threshold, vendor code, no-product). Locks AC#5.
- **`src/stores/scanStore.*.test.ts`** (extend or new `decodeRecall.store.test.ts`, mock `fetch`):
  - success path stores `decodeAttempts` from `providerStatuses`;
  - empty-results-with-statuses path sets `hasSuggestion` true, stores the trail, keeps the honest
    reason, surfaces any `sourceUrls`;
  - a suggested (weak-evidence) decode is shown but NOT counted (no product/count mutation) — proves
    "show ≠ count";
  - regression: a verified, gate-passing decode STILL auto-counts (AC#1).
- **Component test** `src/components/needsReviewTable.recall.test.tsx` (new, jsdom): platformOwner sees
  `decode-attempts`; customer does not; "check the sources below" renders with links when name is empty.
- **E2E** `e2e/decode-recall.spec.ts` (new; `page.route` mock + `IS_E2E=1`): scan a code whose mocked
  decode returns weak evidence + sources (no auto-count) → Needs Review shows candidate + sources +
  reason + attempt trail; screenshot `e2e/proof/decode-recall-transparency.png`. Reuse the existing
  auto-decode E2E harness pattern.

## 5. Proof plan
- Run all gates in `C:\Users\djsan\inventory` with explicit `cd` (doctrine clean-env rule — a bare
  `vitest` in the parent dir scooped up 500+ unrelated tests once; always scope it).
- Mocked only; zero live tokens. Optional ONE manual live re-scan of `051596320812` afterward (owner
  authorization) to confirm it now shows the Homer Bucket lead + sources instead of blank — documented
  in `MANUAL_LIVE_TEST.md`, not in the automated suite.
- Update `PROGRESS.md` + `docs/CURRENT_CONTEXT.md` (both stale at 2026-06-14/15) with the new state, and
  the [[decode-recall-transparency]] memory.

## 6. Risks
| Risk | Severity | Mitigation |
|---|---|---|
| A timed-out partial accidentally auto-counts | High | It can't pass the >=0.8 + corroboration gate; locked by an AC#1 regression test (verified still counts, suggested/timeout never counts). |
| Showing a weak lead makes users trust a wrong product | Med | Reason + "Suggested, not trusted" badge + human approval required; identical trust posture to today, just visible. |
| Provider/AI mechanics leak into the customer view | Med | Attempt trail is `isPlatform`-gated; component test asserts customer view is clean. |
| `persist` migration wipes learned data | High | New field is OPTIONAL, read defensively, NO version bump (same approach as `decodeProviderSummaries`). |
| Scope creep into Phase B (multi-candidate) | Med | Phase A reuses the single-suggestion fields + one trail field only; `suggestions[]` is explicitly out. |

## 7. Out of scope (Phase B, separate approval)
Multi-candidate `suggestions[]` array; per-candidate evidence tiers + snippets; one-click "Use this"
per candidate; reordering candidates by evidence strength.

## 8. Commands
`npm run test` · `npx tsc --noEmit` · `npx eslint src e2e` · `npx next build` ·
`npx playwright test e2e/decode-recall.spec.ts` (+ full `npx playwright test`).
