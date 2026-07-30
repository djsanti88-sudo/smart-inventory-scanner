# Phase 5 - Decode Trust Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute via superpowers:subagent-driven-development, task-by-task. Steps use checkbox (`- [ ]`) syntax. Orchestrator (Opus) diff-verifies every task and serializes all commits; implementers do NOT commit.

**Goal:** Make decode identity honest at scale - a bare model/API self-report can never mint a "Verified" identity or a permanent alias; cross-tier disagreements become conflicts, not silent first-match guesses; UPCitemdb is queried at most once per request; and precision is mechanically gated - without regressing the corpus/retail/verified-evidence auto-verify paths or the owner-loved 84-code golden baseline.

**Architecture:** The bug lives OUTSIDE the well-firewalled `decideDecode()` - GPT (`gptLadderRung.ts`) and Go-UPC (`GoUpcProvider.ts`) hand-build their own `DecodeDecision` with a hardcoded `status: "verified"`, bypassing evidence verification entirely. The fixes are surgical: demote those two hand-built decisions to honest `suggested` status with honest evidence labels; delete the `gptTrusted` auto-count escape hatch in `scanGates.ts`; make the resolver collect ALL trusted matches across tiers before deciding known-vs-conflict; reuse the tracked rung-0 UPCitemdb result instead of a second untracked fetch; and point the eval harness's gate at the real `canAutoCount` so precision cannot silently drift.

**Tech stack:** Next.js 16 / React 19 / TypeScript / Zustand / Vitest / Playwright. All changes are pure-service or store/gate logic; no new dependencies.

## Global Constraints (every task's requirements implicitly include these)

- **TOP-LEVEL LAW (unbreakable):** every scanned code still appears on the feed AND counts, regardless of identity outcome. Demotion changes the IDENTITY BADGE and the alias-write decision, NEVER whether a row appears or counts. A demoted GPT/Go-UPC answer is still shown on its row (as a suggestion) and still counts.
- **Resolver-trust law:** "Verified" requires app-verified exact-code evidence (the app itself fetched+matched the code) OR human/account approval. A raw model self-report or a raw paid-DB API self-report is a SUGGESTION, never "Verified", never an auto-written alias. Wrong identity is failure; unknown/suggested/review is acceptable.
- **AC5 blast-radius fence:** ONLY the model-self-report (`gpt_self_report`) and raw paid-DB-self-report (Go-UPC) identities are demoted. The corpus, retail-corpus, learned-tier, Fetch-V2 (real page fetch), tire-corroboration, and internet-two-source paths in `decideDecode()` MUST auto-verify exactly as before. Do NOT touch `decideDecode()`'s existing verify paths (`canVerify`, `singleSourceVerified`, `tireCorroborated`, `pageFetchModelAgreement`, `internetTwoSourceSize`, `nonPublicTrustedVerified`).
- **Do NOT weaken already-correct guards:** `shouldAutoApplySuggestion()` (scanGates.ts:134-142) already excludes `status === "verified"` from the confidence>=0.8 shortcut - leave it intact. The corpus/retail/learned payload builders already report honestly - do not touch them. Go-UPC's prefix-conflict/inferred branches already downgrade to needs_review - only the clean exact-hit `verifiedDecision()` path changes.
- **High-confidence suggestions still auto-apply to the counted row** (CLAUDE.md: ">= 0.8 or app-verified exact code auto-apply as suggested"). So a demoted Go-UPC hit (confidence 0.9) still lands its identity on the counted row, badged "Suggested (DB)", NOT forced to manual review. This preserves owner intent to utilize the Go-UPC subscription while being honest about provenance.
- **Cost ladder preserved:** a demoted Go-UPC/GPT result is still a SETTLED suggestion that STOPS the ladder (never pay a later rung when an earlier rung answered). Demotion changes the badge/alias decision, not the pay-once ladder ordering.
- **Tests never call live providers:** unit tests mock engines/fetch; the pipeline test uses the fetch spy; E2E mocks `/api/ai-lookup`. $0.
- **Single threshold home:** any new numeric trust threshold is a named export in the module that owns that concern, never a bare literal.
- **Persist/ledger untouched:** no scanStore persist-version bump, no ledger-math change. `test:ledger` (crown suite) and `test:golden` (84-code corpus baseline) stay green by construction and are RUN as proof, not just asserted.
- **Staged scope:** the net-new `catalogEntries` master-truth WRITE path (Admin-SDK append of strong app-verified results) + the master-read-into-resolver (the tenant-vs-master conflict cell) are deferred to **P5b** (a separate follow-on plan) so the high-value refactor fixes ship without a net-new-infra rabbit hole. P5 implements the cross-tier conflict LOGIC fully (proven with synthetic master candidates) and wires the tiered resolver into production with an empty master slot; P5b supplies the real master feed.

---

## Task map / execution waves

| Task | Defect | Files (disjoint sets) | Wave |
|---|---|---|---|
| 1 | D6 GPT demotion (core) | gptLadderRung.ts, scanGates.ts + their tests | 1 |
| 2 | Provider honesty: Go-UPC relabel + D8 UPCitemdb single-fetch | pipeline.ts, GoUpcProvider.ts, barcodeDbProvider.ts + tests | 1 |
| 3 | D5 cross-tier conflict (tenant tiers + padded-GTIN/case) | aliasMatcher.ts, resolver.ts, scanCleaner.ts, scanStore.ts:1790 + tests | 1 |
| 4 | Golden precision gates | src/eval/runEval.ts, dataset.ts, fixtures.ts, eval.test.ts, goldenClasses.store.test.ts | 2 (after T1) |
| 5 | Badges: Verified (app-confirmed) vs Suggested (AI/DB) | badges.tsx + badges.test.tsx, feed status plumbing | 2 (after T1) |

Wave 1 = Tasks 1, 2, 3 run in parallel (disjoint files). Wave 2 = Tasks 4, 5 run in parallel after Task 1's demotion semantics land (they assert the demoted behavior). Task 3 touches the scanStore monolith and is resolver-trust-critical -> dedicated orchestrator review. All others: orchestrator diff-verify + shell gates.

---

## Task 1: Demote the GPT self-report to a suggestion (D6 core)

**Files:**
- Modify: `src/services/ai/gptLadderRung.ts` (the `gptResultToDecodePayload` verified branch, ~:126-137, and `GPT_LADDER_REASON` ~:72)
- Modify: `src/stores/scanGates.ts` (delete the `gptTrusted` auto-count branch, ~:95-99)
- Test: `src/services/ai/gptLadderRung.test.ts`, `src/stores/scanGates.test.ts`, `src/stores/autoCountBattery.test.ts`, `src/stores/scanStore.gptLadder.test.ts`, `src/app/api/ai-lookup/route.test.ts` (asserts `json.decision.status === "verified"` + `gpt_self_report` at ~:287-288 and ~:437-438 - must flip to `"suggested"`)

**Interfaces:**
- Consumes: `DecodeDecision` (types.ts), `AutoCountInput`/`canAutoCount` (scanGates.ts), `decodeCorroborated` (scanGates.ts).
- Produces: `gptResultToDecodePayload` returns `status: "suggested"` (never `"verified"`) for a bare GPT self-report; `canAutoCount` has exactly ONE verified-grant path (the evidence-corroborated branch); a GPT self-report can still auto-APPLY as a suggestion via the untouched `shouldAutoApplySuggestion`.

- [ ] **Step 1: Write/adjust the failing unit tests first**

In `src/services/ai/gptLadderRung.test.ts`, change the `tier: "verified"` expectation: a GPT `verified`-tier result must now map to `payload.decision.status === "suggested"` (was `"verified"`), while `corroborationPath` stays `"gpt_self_report"` and `exactCodeEvidenceVerifiedByApp` stays `false`. Add an explicit assertion that `status` is NOT `"verified"`.

In `src/stores/scanGates.test.ts`, replace any assertion that a `{ codeType: public, corroborationPath: "gpt_self_report", status: "verified" }` input yields `canAutoCount(...).allowed === true` with an assertion that it now yields `allowed === false` (the escape hatch is gone). Keep every assertion for the evidence-corroborated branch (status verified && `exactCodeEvidenceVerifiedByApp`) unchanged.

In `src/stores/autoCountBattery.test.ts`, the `control:` case (~:21-24) that asserts `gpt_self_report` `.allowed === true` becomes `.allowed === false`. The 10 `rejects` cases stay green (they reject on tire/context/confidence/shape, not the gpt branch).

- [ ] **Step 2: Run the tests and confirm they FAIL (red) against current code**

Run (Bash/Git Bash): `npx vitest run src/services/ai/gptLadderRung.test.ts src/stores/scanGates.test.ts src/stores/autoCountBattery.test.ts`
Expected: FAIL on the changed assertions (current code still emits verified / still grants gptTrusted).

- [ ] **Step 3: Demote in `gptLadderRung.ts`**

In `gptResultToDecodePayload`, the `r.tier === "verified"` branch (~:126-137): change `status: "verified"` to `status: "suggested"`. Leave `evidenceStrength: "none"`, `exactCodeEvidenceVerifiedByApp: false`, `corroborationPath: "gpt_self_report"` exactly as they are (already honest). Update `GPT_LADDER_REASON` (~:72) from the auto-count-candidate wording to honest suggestion wording, e.g. `"Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion."` (no em/en dashes in user-facing copy - use hyphens/periods).

- [ ] **Step 4: Delete the `gptTrusted` escape hatch in `scanGates.ts`**

In `canAutoCount` (~:83-107), delete the `gptTrusted` grant path (~:95-99) and its comment block. The evidence-corroborated branch (`status === "verified" && decodeCorroborated(decision)`, ~:102-104) becomes the ONLY verified-auto-count path. Do NOT touch `decodeCorroborated`, `isPublicBarcodeShape`, or `shouldAutoApplySuggestion`.

- [ ] **Step 5: Update the store-level GPT ladder tests**

In `src/stores/scanStore.gptLadder.test.ts`, the `describe("GPT ladder trust tiers - verified auto-count")` block must be reframed: a bare GPT self-report no longer produces a `verified`/auto-counted row; it produces a `suggested` row that is auto-APPLIED to the count (identity shown, still counted, `verified === false`, no approved alias written). The `describe("...suggested tier flows through unchanged")` block stays green. Assert the TOP-LEVEL LAW holds: the row still appears and the count still increments for the GPT-identified code, only the badge/verified flag/alias differ.

- [ ] **Step 6: Run all Task 1 suites green + tsc**

Run: `npx vitest run src/services/ai/gptLadderRung.test.ts src/stores/scanGates.test.ts src/stores/autoCountBattery.test.ts src/stores/scanStore.gptLadder.test.ts` -> PASS.
Run: `npx tsc --noEmit` -> 0 errors.
Report DONE with real outputs. (E2E mock path via `mockGptLadder` -> `gptResultToDecodePayload` is auto-covered by the same code change; flag any e2e spec asserting a GPT-mocked verified auto-count for the orchestrator to re-run at the phase gate.)

---

## Task 2: Provider honesty - Go-UPC relabel + UPCitemdb single-fetch (D6 sub-goal + D8)

**Files:**
- Modify: `src/server/upc/GoUpcProvider.ts` (`verifiedDecision`, ~:149-166)
- Modify: `src/server/decode/pipeline.ts` (Go-UPC evidence object ~:989; Plan D `lookupBarcodeDb` wiring ~:1147-1150; capture rung-0 UPCitemdb result in a closure)
- Modify (or stop importing): `src/server/retail-knowledge/barcodeDbProvider.ts` usage from the pipeline
- Test: `src/server/upc/GoUpcProvider.test.ts` (or the nearest), `src/server/decode/pipeline.test.ts`

**Interfaces:**
- Consumes: `runUpcItemDb`/rung-0 result shape, `resolveUnknownFast` deps (`lookupBarcodeDb`, `retailDb`), `EvidenceResult`.
- Produces: Go-UPC clean-hit decision `status: "suggested"`, honest evidence (`evidenceStrength` NOT `fetched_source`; `exactCodeEvidenceVerifiedByApp: false`); pipeline reuses the tracked rung-0 UPCitemdb outcome for Plan D instead of a second fetch; `UPCITEMDB_HOST` fetched at most once per request.

- [ ] **Step 1: Write failing tests first**

Go-UPC honesty (in `GoUpcProvider.test.ts`): a clean exact hit's decision now has `status === "suggested"` (was `"verified"`), `exactCodeEvidenceVerifiedByApp === false`, and `evidenceStrength !== "fetched_source"` (use `"none"`). `confidence` stays `0.9`. **NOTE: three tests call the same `verifiedDecision()` (~:123-136 clean-hit, ~:157-160 carlstar-family, ~:162-169 unknown-prefix) - all three must be updated.** The prefix-conflict/inferred paths (needs_review, 0.4) stay unchanged.

Paid-answer-still-wins (in `pipeline.test.ts` ~:721-736, "Go-UPC verified exact WINS"): after demotion Go-UPC settles as `"suggested"`, so update this test to assert a cleanly-settled Go-UPC hit still WINS over the free-rung stash (it must not be silently discarded - see Step 3c).

D8 single-fetch (in `pipeline.test.ts`): add a test that, for a public-barcode GTIN request that reaches Plan D (rung-0 UPCitemdb suggests, not a terminal win), the fetch spy filtered on `UPCITEMDB_HOST` is called at most once (`toHaveBeenCalledTimes(1)` or `.length <= 1`). Model it on the existing `go-upc.com` count assertions (pipeline.test.ts ~:221,1791) and `stubFreeRungFetch` (~:443-461).

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/server/upc/GoUpcProvider.test.ts src/server/decode/pipeline.test.ts` -> FAIL (Go-UPC still verified; UPCitemdb still fetched twice).

- [ ] **Step 3a: Relabel Go-UPC honestly**

In `GoUpcProvider.ts` `verifiedDecision()` (~:149-166): change `status: "verified"` -> `status: "suggested"`; `evidenceStrength: "fetched_source"` -> `"none"`; `exactCodeEvidenceVerifiedByApp: true` -> `false`. Keep `confidence: 0.9`. In `pipeline.ts` ~:989, change the fabricated evidence object from `{ verified: true, strength: "fetched_source", ... }` to honest `{ verified: false, strength: "none", matchedCode: code, matchedSources: ["go-upc"], reason: "Go-UPC API self-report (not app page-verified)" }`. (Go-UPC remains a settled SUGGESTION that stops the ladder and auto-applies at 0.9 - the row still gets the identity.)

- [ ] **Step 3b: Reuse the rung-0 UPCitemdb result in Plan D (D8)**

In `pipeline.ts`, capture the rung-0 `runUpcItemDb` outcome (name/brand/sourceUrl) into a closure var analogous to the existing `retailHit`. Wire Plan D's `lookupBarcodeDb` dep (~:1149) to return that captured value (a resolved passthrough), mirroring the `retailDb: async () => retailHit ? {...} : null` pattern at ~:1150. Stop calling `barcodeDbProvider.ts`'s `lookupBarcodeDb` from the pipeline (rung-0 is GTIN-gated and Plan D only runs for `isPublicBarcode` = the same GTIN universe, so there is no code that reaches Plan D without rung-0 having already tried it - confirm and, if a residual non-GTIN case exists, keep barcodeDbProvider ONLY for that fallback). Fix the stale comment at `pipeline.test.ts` ~:829-832 (it wrongly calls the duplicate hit "legitimate/unrelated") and add a comment at the Plan D wiring site: "UPCitemdb result is REUSED from rung-0, never re-queried." NOTE (#9): rung-0's `upcItemDbLookup` lacks `barcodeDbProvider`'s zero-pad-variant retry and its result shape may omit `sourceUrl`; when threading it into Plan D's `lookupBarcodeDb`, preserve a `sourceUrl` if rung-0 carries one (so Plan D's `bestUrl` offer-link escalation is not lost), and document the retry-robustness delta if it cannot be preserved.

- [ ] **Step 3c: Repoint the Go-UPC `status === "verified"` ladder gates (demotion ripple - CRITICAL)**

Demoting Go-UPC from `"verified"` to `"suggested"` breaks every pipeline site that used `status === "verified"` as a PROXY for "Go-UPC settled/won". Grep `src/server/decode/pipeline.ts` for `decision.status === "verified"` / `goStatus === "verified"` and audit each (found at ~:1259, :1289, :1327, :1551, :1572):
  - **:1259 escalation win-selection (the regression):** `ladderRun = goStatus === "verified" ? {go-upc outcome} : {freeRun outcome}` - after demotion this always discards the PAID Go-UPC answer for the weaker free-rung stash. Change the condition to "Go-UPC settled" (e.g. `goStatus !== null` / the run produced a settled outcome), so a cleanly-resolved paid Go-UPC hit still wins. This is what the ~:721-736 test now asserts.
  - **:1289 / :1551** already accept `"verified" || "suggested"` - a demoted Go-UPC suggestion still passes; no change, but confirm.
  - **:1327 PAID-VERIFIED CONTRADICTION GUARD** gates on `status === "verified"` - Go-UPC no longer hits it. Acceptable (a suggestion already routes review-first) but add a one-line comment documenting the intentional side effect.
  - **:1572 L2 cache-write gate** (`payload.decision.status === "verified"`): CONFIRM demoted Go-UPC/GPT results are STILL persisted to the decode cache. If this is the only persist gate and it requires `"verified"`, a demoted suggestion would never be cached and every repeat scan of the same code would RE-PAY the paid rung - a cost regression that violates the pay-once rule and the scout's caching landmine (a GPT/Go-UPC answer is worth caching even as a suggestion). Extend the gate so a settled `"suggested"` result from a paid rung is cached exactly once. Add a test asserting a second scan of the same code does NOT re-invoke the paid provider.

- [ ] **Step 4: Green + tsc**

Run: `npx vitest run src/server/upc/GoUpcProvider.test.ts src/server/decode/pipeline.test.ts` -> PASS (Go-UPC suggested + honest evidence; UPCITEMDB_HOST called <=1). `npx tsc --noEmit` -> 0 errors. Report DONE with real outputs.

---

## Task 3: Cross-tier conflict detection (D5) + padded-GTIN equivalence

**Files:**
- Modify: `src/services/aliasMatcher.ts` (`resolveScanToProductTiered` ~:166-182 - implement real collect-all-then-conflict; add canonicalGtin equivalence to candidate comparison)
- Modify: `src/services/scanCleaner.ts` (`buildNormalizedCandidates` ~:48-88 - add GTIN zero-pad variants via `gtinVariants`)
- Modify: `src/services/resolver.ts` (~:33 - call `resolveScanToProductTiered` instead of untiered `resolveScanToProduct`, master slot empty for now). NOTE: this conversion cascades (correctly, for free) to `ReconcilePanel.tsx`, `scan/page.tsx`, `countedByUid.ts`, and the customer-facing/access-boundary `resolveScanServer.ts` - re-verify the server file's behavior is unchanged (security-relevant).
- Modify: `src/stores/scanStore.ts` - TWO production call sites (MONOLITH, law-critical, minimal surgical change only): (1) `~:1796` `resolveScan(cleaned, products, aliases, businessId)` (via resolver.ts - routes through the tiered path automatically once resolver.ts is converted); (2) **`~:4069` `resolveScanToProduct(...)` called DIRECTLY inside the create-new/dedup guard (Critical #2 - a second, previously-unnamed call site).** Convert :4069 to the tiered path too (cross-tier conflict must apply to the dedup guard - a code that conflicts across tiers must not be silently dedup-merged into one product), OR if there is a concrete reason the dedup guard must stay untiered, state that rationale explicitly in-code and in the report.
- Test: `src/services/aliasMatcher.test.ts`, `src/services/resolver.test.ts`, `src/services/resolverTier.test.ts`, `src/services/upc/gtin.test.ts` (add the invariant lock, Step 4)

**Interfaces:**
- Consumes: `matchAlias`, `matchProductByIdentifiers`, `pickTier`, `MasterCandidate`/`TierInput`, `canonicalGtin`/`gtinVariants` (`@/services/upc/gtin`), `ProvenanceTier`.
- Produces: `resolveScanToProductTiered` collects ALL trusted productIds across alias tier + identifier tier + masterCandidates; identical productId everywhere -> known (highest tier wins); distinct productIds anywhere -> `conflict` with sorted `conflictProductIds`; wired into `resolver.ts` + `scanStore.ts`.

- [ ] **Step 1: Write the failing cross-tier matrix tests**

In `src/services/resolverTier.test.ts` (currently proves pass-through only), add cases:
  (a) alias-vs-barcode: code X is an APPROVED alias for product A AND a VERIFIED `primaryBarcode` for product B -> `conflict`, `conflictProductIds` = sorted [A,B]. (Today returns known->A.)
  (b) UPC-vs-SKU: code hits `primary_sku` of A and `gtin`/`upc` of B (different products) -> conflict.
  (c) all-agree: code is an approved alias for A AND a verified identifier for the SAME A -> known -> A (no false conflict).
  (d) tenant-vs-master (LOGIC, synthetic): `masterCandidates: [{ productId: B, ... }]` while tenant resolves A -> conflict; same productId -> known.
  (e) padded-GTIN equivalence: alias stored `0012345678905`, scan `12345678905` (or vice versa) -> they MATCH the same product (not a silent miss), and if they map to DIFFERENT verified products -> conflict.
Keep the existing pass-through tests updated to the new semantics. In `aliasMatcher.test.ts`/`resolver.test.ts`, keep the existing same-tier conflict test green.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run src/services/resolverTier.test.ts src/services/aliasMatcher.test.ts src/services/resolver.test.ts` -> FAIL on the new cross-tier + padded-GTIN cases.

- [ ] **Step 3: Implement collect-all-then-conflict in `resolveScanToProductTiered`**

Replace the `void input.masterCandidates` pass-through with real logic: run BOTH `matchAlias(cleaned, input.aliases, businessId)` AND `matchProductByIdentifiers(cleaned, input.products, businessId)` (do not short-circuit at the first non-null). Collect the distinct set of resolved `productId`s from: alias-tier result, identifier-tier result, and `input.masterCandidates?.map(m => m.productId)`. Also fold in any per-tier `conflictProductIds` already surfaced by `pickTier`. Then:
  - 0 productIds -> fall through to the existing no-match/needs_review shape.
  - exactly 1 distinct productId -> `known`, `productId`, `matchType` from the highest-priority tier that produced it (tier priority applies ONLY when all agree).
  - >1 distinct productId -> `{ matchType: "conflict", productId: null, conflictProductIds: sorted-unique }`.
Return through the SAME `ScanResolution` shape so `resolver.ts`'s conflict branch (:42-51) preserves appear+count. Do NOT weaken the `alias.approved === true` / `product.verified === true` gates.

- [ ] **Step 4: Add padded-GTIN equivalence**

In `scanCleaner.ts` `buildNormalizedCandidates`, when the cleaned code is GTIN-shaped, add `gtinVariants(code)` (the 12/13/14 zero-padded variants from `@/services/upc/gtin`) to `normalizedCandidates` so alias/identifier comparison collapses padding differences. This changes some MISS->MATCH and, across different products, MATCH->CONFLICT - both are correct per D5.

**GTIN-14 case-pack safety (#6):** `gtinVariants` is safe against collapsing a GTIN-14 case-pack (indicator digit >= 1) into a 12/13-digit unit code ONLY incidentally - `padStart` can pad but never truncate. That is fragile: a future edit adding a truncation branch would silently reintroduce the collapse. LOCK it: add a regression test in `src/services/upc/gtin.test.ts` asserting `gtinVariants` on a 14-digit indicator-digit->=1 code NEVER emits a 12/13-digit form (so a case pack can never be treated as the same code as its inner unit). If that invariant cannot be cleanly guaranteed, switch the resolver comparison to `canonicalGtin`-based equivalence (which has explicit indicator-digit logic) instead.

- [ ] **Step 5: Wire the tiered path into production**

`resolver.ts` ~:33: call `resolveScanToProductTiered(cleaned, { products, aliases, masterCandidates: [] }, businessId)` (empty master slot until P5b). `scanStore.ts` ~:1796 (via `resolveScan`, converted automatically by the resolver.ts change) AND the direct `~:4069` dedup-guard call: both route through the tiered path (minimal change - same inputs, empty master slot). Verify no other behavior in scanStore changes; run `test:ledger` because scanStore changed.

- [ ] **Step 6: Green + full resolver/ledger regression + tsc**

Run: `npx vitest run src/services/resolverTier.test.ts src/services/aliasMatcher.test.ts src/services/resolver.test.ts src/services/scanCleaner.test.ts` -> PASS.
Run: `npm run test:ledger` (crown suite - because scanStore.ts changed) -> all green.
Run: `npx tsc --noEmit` -> 0. Report DONE. Orchestrator does a DEDICATED review of the scanStore + resolver diff (law-critical).

---

## Task 4: Golden precision gates (after Task 1)

**Files:**
- Modify: `src/eval/runEval.ts` (point the gate at the real `canAutoCount`/`shouldAutoApplySuggestion`, ~:44-63; add `suggestedPrecisionPct` to `EvalSummary` ~:29-36)
- Modify: `src/eval/dataset.ts`, `src/eval/fixtures.ts` (per-class labeled fixtures + `expectedStatus`)
- Modify: `src/eval/eval.test.ts` (0%-false-auto-verified across classes + suggested-precision floor)
- Modify: `src/stores/goldenClasses.store.test.ts` (ADD AI-on classes; keep the 4 AI-off classes unchanged)

**Interfaces:**
- Consumes: `canAutoCount`/`shouldAutoApplySuggestion` (scanGates.ts), the demoted `gptResultToDecodePayload` semantics from Task 1.
- Produces: an eval harness whose gate IS the production gate (no hand-mirror drift); `falseAutoVerifiedRatePct === 0` across all classes; a `suggestedPrecisionPct` floor; new AI-on golden classes.

- [ ] **Step 1: Failing tests first** - in `eval.test.ts`, add a class-battery expectation: for every labeled fixture (gpt-self-report-verified-should-demote-to-suggested, gpt-self-report-on-vendor-shape, app-verified-exact-should-stay-verified, learned-tier-should-stay-suggested, corpus/retail-hit-should-stay-verified per AC5), the scored outcome matches `expectedStatus` and `falseAutoVerifiedRatePct === 0`. Add a `suggestedPrecisionPct >= FLOOR` assertion (choose a defensible floor, e.g. 100% on the labeled set since fixtures are ground-truth; a named const). In `goldenClasses.store.test.ts`, add an AI-on `describe` block: a mocked GPT self-report scan -> row counts, `verified === false`, badge suggested, no approved alias (mirrors Task 1's store test but in the golden-class harness).
- [ ] **Step 2: Confirm red** - `npx vitest run src/eval/eval.test.ts src/stores/goldenClasses.store.test.ts` -> FAIL.
- [ ] **Step 3: Point runEval at the real gate** - replace the hand-mirrored inline gate logic in `runEval.ts:44-63` with a direct call to `canAutoCount`/`shouldAutoApplySuggestion` from `@/stores/scanGates`. Add `expectedStatus` to the fixture type and `suggestedPrecisionPct` to `EvalSummary`.
- [ ] **Step 4: Expand fixtures** - add the per-class labeled fixtures to `dataset.ts`/`fixtures.ts` with `expectedStatus` + `shouldAutoCount`.
- [ ] **Step 5: Green + must-not-regress** - `npx vitest run src/eval/eval.test.ts src/stores/goldenClasses.store.test.ts` -> PASS. Then prove the fences: `npm run test:golden` (84-code corpus baseline) -> unchanged green; `npm run test:ledger` -> green; `npx tsc --noEmit` -> 0. Report DONE.

---

## Task 5: Honest provenance badges (after Task 1)

**Scope reality (#5):** `ScanEvent` has NO provenance field today and `corroborationPath` is discarded at ~15+ `decodeStatus:` write sites across the ~5,300-line `scanStore.ts` monolith (several - relabel / mark-wrong / suggest-link - have no `DecodeDecision` in scope). Full provenance-awareness on every row is a monolith-threading job. **P5 scope is bounded:** (a) the `DecodeStatusBadge` component + labels (self-contained), and (b) thread a `provenance` field onto the feed row at the SINGLE primary live-decode write site (the `liveDecode`/`backgroundVerifyDeep` path where a `DecodeDecision` IS in scope) so the live feed row shows the distinction. Full threading to `FinalCountTable`, mark-wrong, and suggest-link sites is DEFERRED to P6 product polish. Because it touches the monolith, this task gets a DEDICATED orchestrator review (like Task 3), not light diff-verify.

**Files:**
- Modify: `src/components/badges.tsx` (`DecodeStatusBadge` ~:9-25)
- Test: `src/components/badges.test.tsx`
- Modify: `src/stores/scanStore.ts` (add a `provenance` field to the feed row at the ONE primary live-decode `decodeStatus` write site where the `DecodeDecision` is in scope) + the feed-row type in `src/types.ts` + `src/components/LiveScanFeed.tsx` to pass it to the badge. Additive, minimal.

**Interfaces:**
- Consumes: the feed row's decode status + a provenance signal (`corroborationPath` or a mapped `provenance` field).
- Produces: `DecodeStatusBadge` renders "Verified (app-confirmed)" for app-verified exact-code, "Suggested (AI)" for `gpt_self_report`, "Suggested (DB)" for Go-UPC self-report; generic "Suggested" otherwise. No em/en dashes.

- [ ] **Step 1: Failing badge tests** - in `badges.test.tsx`, assert the new labels: app-verified -> "Verified (app-confirmed)"; ai self-report -> "Suggested (AI)"; keep an assertion that a plain verified (no provenance) still renders a "Verified" label so existing rows don't break.
- [ ] **Step 2: Confirm red** - `npx vitest run src/components/badges.test.tsx` -> FAIL.
- [ ] **Step 3: Implement** - add the provenance-aware labels to `DecodeStatusBadge` (second prop or richer status). Thread the provenance signal from the feed row down; if the plumbing is large, keep P5 to the badge-component change + a minimal prop and defer deeper wiring - but the app-confirmed vs AI distinction must be visible for at least the live feed row.
- [ ] **Step 4: Green + tsc + a quick Playwright smoke** - `npx vitest run src/components/badges.test.tsx` -> PASS; `npx tsc --noEmit` -> 0. Orchestrator runs the relevant e2e badge/flow at the phase gate. Report DONE.

---

## Acceptance criteria (phase gate)

1. No path mints a `verified` identity or a permanent alias from a bare GPT/Go-UPC self-report (unit + gate tests across gptLadderRung, scanGates, GoUpcProvider, pipeline).
2. A code that is an approved alias for A and a verified identifier for B resolves CONFLICT (cross-tier tests incl. synthetic tenant-vs-master and padded-GTIN).
3. UPCitemdb fetched at most once per request (pipeline fetch-spy test).
4. Golden precision gates green: `falseAutoVerifiedRatePct === 0` across classes, suggested-precision floor met; the 84-code `test:golden` baseline unchanged; `test:ledger` unchanged.
5. AC5 guardrail: corpus/retail/verified-evidence auto-verify EXACTLY as before - demotion affects only `gpt_self_report` + Go-UPC self-report identities. Every scan still appears + counts.
6. Badges distinguish "Verified (app-confirmed)" from "Suggested (AI/DB)".

**Proof:** unit suites, `test:golden`, `test:ledger`, pipeline fetch-spy, Playwright badge/conflict flow, full `npm test` + `tsc` + build at the phase gate, Argus `review-build`. Slim ultra review (2 finders: trust/law + regression/test-integrity) over the whole-phase diff before close.

**MANDATORY phase-gate step - e2e demotion sync (from the test-integrity pre-sweep, `.superpowers/sdd/p5-test-integrity-presweep.md`):** three e2e specs hand-mirror the PRE-demotion contract and are in no task file list - they must be updated to the demoted behavior BEFORE the full e2e gate run, else the gate red-herrings on them: (1) `e2e/goupc-ladder.spec.ts` (asserts "Verified match" badge + auto-count for a raw Go-UPC exact hit -> now "Suggested" + still counts); (2) `e2e/gpt-ladder-burst.spec.ts` (GPT `status:"verified"` mock -> "suggested"); (3) `e2e/polish-filter.spec.ts` (same GPT-verified mock). Orchestrator does this consolidated update after T1+T2 are committed (both demotion contracts known), then runs the full e2e. Do NOT weaken an assertion to pass - update it to assert the row still appears + counts with the honest suggested badge.

**Deferred to P5b (out of scope here):** `catalogEntries` master-truth Admin-SDK write path (strong app-verified append) + master-read-into-`resolveScanToProductTiered` (the real tenant-vs-master feed). P5 ships the conflict LOGIC + empty master slot; P5b supplies the feed. Also out of scope: any `decideDecode()` verify-path change, any persist-version bump, any ledger-math change.

## Risks, rollback & cost

**Risks / failure modes:**
- *Demotion over-reaches (breaks AC5):* the highest risk - a change that also demotes corpus/retail/Fetch-V2/learned. Mitigation: the fix is confined to `gptLadderRung.ts` + `GoUpcProvider.ts` + the `gptTrusted` branch delete; `decideDecode()` is untouched; Task 4's golden gates + `test:golden` mechanically prove corpus/verified paths are unchanged.
- *Review-volume spike from Go-UPC demotion:* mitigated because high-confidence (0.9) suggestions auto-apply to the counted row (identity still lands), so the user experience is a badge change, not a flood of manual review.
- *D5 false conflicts from padded-GTIN:* mitigated by using `gtinVariants` (which preserves the GTIN-14 case-pack indicator digit); Task 3's matrix includes an all-agree case to prove no false conflict.
- *scanStore.ts monolith regression (D5 wiring):* mitigated by the minimal-surgical wiring + a mandatory `test:ledger` run + a dedicated orchestrator review of the scanStore/resolver diff.

**Rollback:** every task is behavior-only - no schema, no persist-version bump, no data migration - so rollback is a clean `git revert` of the task's commit(s) with zero data cleanup. The phase can also ship partially (e.g. T1+T4 without T3) since the tasks are independent commits.

**Cost:** $0 - all tests mock providers; no live/paid calls; no new dependencies. Model/token spend is orchestration only, reported at phase close per standing policy.
