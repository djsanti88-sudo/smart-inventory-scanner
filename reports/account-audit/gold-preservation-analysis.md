# Gold-Behavior Preservation Analysis (read-only)

Analysis only. Nothing was modified, deployed, pushed, merged, committed, or cleaned.
Target is NOT plain baseline-v1. Target = baseline-v1 + today's safe auto-resolve behavior + safe-fail (no old Needs Review bottleneck, no poison).

## 1. Executive summary
- The held commits contain **real product gold**, and the current repair candidate (baseline + safe tooling only) is **incomplete** - it reverts to a more-Needs-Review-heavy product.
- The core gold is **827e398**: `scanStore.lookupGlobalCatalog` queries `retailCatalogEntries` and *"a hit IS the product identity, so resolve it as Known"* (returns a verified entry). That is the no-Needs-Review-for-recoverable-retail-scans behavior. The candidate does not have it.
- The architecture ALREADY implements the right philosophy: **strong evidence -> auto-verify + count (no review); weak/unsafe -> safe-fail (review)** (proven by `e2e/auto-verify.spec.ts`, `e2e/verified-decode-not-unknown.spec.ts`). So "needs_review" for WEAK/unsafe scans is the **correct safe-fail**, not a bug. The bug was recoverable scans bottlenecking - fixed by retail (827e398) + the firewall safety (03e0791) + the flywheel (3e02c8f).
- The `078742051451` -> dress was **data**: the retail catalog did not contain the water, so it fell through to an AI "dress" guess that a human approved (`source: human_review`). The retail **code** supports resolving it as water; the retail **data** must contain it.
- To reach the corrected target, the candidate REQUIRES 827e398 (retail) + 03e0791 (firewall) with their tests, plus one NEW test (retail-resolves-as-Known is currently untested), plus the retail data for `078742051451`.

## 2. Ref inventory
| Ref | SHA | Note |
|---|---|---|
| `baseline-v1` (tag) | tag obj `1510707` -> commit **`bc464e6`** | Master Baseline v1 |
| `feat/weekly-report-system` | **`b9dea2a`** | all today's work (deployed lineage) |
| `repair/baseline-v1-plus-reviewed-good-work` | **`b884479`** | candidate = baseline + 4 safe commits |
| `backup/pre-repair-20260628-2054` | `b9dea2a` | snapshot of feat HEAD |
| `refs/backup/wip-pre-repair-20260628-2054` | `4876812` | dirty-tree snapshot (tracked+untracked) |

## 3. Diff map summary
| Map | Scope | Size | Behavior |
|---|---|---|---|
| 1 | baseline -> feat | 68 files, +6322/-1106 | all of today |
| 2 | baseline -> candidate | 24 files, +3404/-31 | 4 safe commits only (no resolution behavior) |
| 3 | candidate -> feat (src non-test) | 15 files | **the missing gold** (below) |
| 4 | baseline -> WIP ref | 266 files, +505685 | derived map + data + dirty work |
| 5 | feat -> dirty tree | 56 files, +24051/-63 | uncommitted Phase-1 reverse-UPC guard |

MAP3 missing src, attributed:
- **827e398 (retail):** `src/stores/scanStore.ts`, `src/services/db/firebase/repositories.ts`
- **6937cf3 (spend cap):** `src/app/api/ai-lookup/route.ts`, `src/services/security/aiSpendGuard.ts`
- **03e0791 (firewall):** `prefixFirewall.ts`, `prefixIndex.ts`, `candidateUpcSet.ts`, `derivedPrefixMap.json`, `decodeBudget.ts`, `decodeCache.ts`, `geminiProvider.ts`, `groundedSpecFinder.ts`
- **3e02c8f (flywheel):** `NeedsReviewTable.tsx`, `prefixLearning.ts`, `types.ts`

## 4. Where the no-old-Needs-Review behavior came from (not one commit)
- **BASELINE already has** the auto-verify engine: `src/services/catalog/evidenceScoring.ts` (`AutoVerifyStatus = "auto_verify" | "auto_count" | "needs_review"`), `catalogAutoVerify.ts`, settings `autoAddDecodedProducts` / `trustedSourceAutoVerifyEnabled` / `autoCatalogLearningEnabled`, and the rule "verified decode shows product + counts, never Unknown" (`e2e/verified-decode-not-unknown.spec.ts`: *"verified single-provider Tier-3 decode shows product + counts (never Verified Unknown)"*; `e2e/auto-verify.spec.ts`: *"strong auto-saves, 2nd scan no AI, weak -> review"*).
- **827e398** adds the RETAIL resolution SOURCE: `scanStore.lookupGlobalCatalog` -> `retailRepo.getByBarcode(code)` on `retailCatalogEntries` -> `return toStoreEntry({...rraw, verificationStatus:"verified"})`. Function: `lookupGlobalCatalog` (scanStore.ts ~line 3190). **This is the missing gold.**
- **03e0791** is the SAFETY that makes aggressive auto-resolve trustworthy: `prefixFirewall.ts` (blocks wrong-brand-for-barcode), `prefixIndex.ts`, `candidateUpcSet.ts`, `derivedPrefixMap.json`. Proof: `prefixFirewall.test.ts`, `autoVerify.store.test.ts`.
- **3e02c8f** grows safe auto-resolution over time: `prefixLearning.ts` (learn verified prefixes, >=0.90), reverse-UPC guard, owner hints. Proof: `prefixLearning.test.ts`.

## 5. Today's gold changes
| Change | Source | Files | Behavior gained | Risk | Proof available | Missing proof | Preserve | Order | Local test before reintroduce |
|---|---|---|---|---|---|---|---|---|---|
| Retail catalog resolves as Known | 827e398 | scanStore.ts, repositories.ts | recoverable retail scans auto-resolve (no Needs Review); water can resolve as water | med (resolution path) | partial (cloudCatalogResolution.test) | **no test for retail getByBarcode->Known** | YES | 1 | add retail-resolve unit/e2e |
| Evidence-weighted prefix firewall | 03e0791 | prefixFirewall/Index, candidateUpcSet, derivedPrefixMap, decode speed | blocks wrong-brand auto-count; safe aggressive resolve; faster/cheaper decode | med | yes (prefixFirewall.test, autoVerify.store.test, decodeBudget/Cache tests) | - | YES | 2 | run those unit suites |
| Self-learning flywheel + reverse-UPC + owner hints | 3e02c8f | prefixLearning, NeedsReviewTable, types | learns verified prefixes; reverse-UPC mis-scan guard; owner hints | med-high (writes learned data) | yes (prefixLearning.test, candidateUpcSet.test) | persistence proof | YES | 4 | unit + confirm no auto-write of aliases |
| AI spend cap + rate limit + kill switch | 6937cf3 | ai-lookup/route, aiSpendGuard | wallet protection; cannot runaway-spend | low (only restricts) | yes (aiSpendGuard.test) | verify legit decode not blocked | YES | 3 | aiSpendGuard.test + 1 decode smoke |
| Banner dev-only | 955954e | ProdFirebaseBanner | no scary banner in prod | none | yes | - | YES (already in candidate) | done | - |
| Accuracy test-set | b9dea2a | data/accuracy | bigger eval coverage | none | n/a | - | YES (already in candidate) | done | - |
| Shop reverse-UPC guard | uncommitted (WIP `4876812`) | candidateUpcSet, NeedsReviewTable, scanStore, types | owner heads-up when candidate exists under a different code | low (additive note) | yes (candidateUpcSet.test) | - | YES | 5 | candidateUpcSet.test |

## 6. Tests that are outdated or still expect Needs Review
Important: most `needs_review` assertions are **SAFE-FAIL tests** (weak / vendor / conflict / AI-only-no-evidence) and are **VALID/gold - keep them**. "needs_review" is the correct safe-fail for unrecoverable scans.

| Test | Expectation | Classification |
|---|---|---|
| `src/services/resolver.test.ts:71` `078742051451 -> needs_review` | deterministic layer only | **STILL VALID** (aliases/verified only; retail is a higher layer) |
| `e2e/resolver.spec.ts:52-64` `078742051451 -> review-row` | no-catalog mock path | **valid for the no-retail context; needs a SIBLING test for the retail-resolve path** (else it enshrines the bottleneck) |
| `src/services/ai/prompt.test.ts:94` | prompt contains code | valid, unrelated |
| `e2e/auto-verify.spec.ts`, `verified-decode-not-unknown.spec.ts` | strong->auto, weak->review | **GOLD - keep** (these prove the corrected behavior) |
| `e2e/firewall.spec.ts`, `decode*.test.ts`, `catalogAutoVerify/evidenceScoring.test.ts` | safe-fail on weak/unsafe | **valid** |
| (none found) retail getByBarcode -> Known | - | **MISSING - must be written** |

## 7. Repair candidate gaps (vs corrected target)
- Missing & REQUIRED: **827e398** (retail resolution), **03e0791** (firewall safety).
- Missing & strongly recommended: **6937cf3** (wallet protection), retail **DATA** containing `078742051451` (so the water resolves).
- Missing & valuable (can follow after proof): **3e02c8f** (flywheel/learning/owner hints), the uncommitted **reverse-UPC guard**.
- Required before local proof is meaningful: 827e398 + 03e0791 (auto-resolve + its safety must both exist, or proof is misleading).
- Can wait until after first proof: flywheel persistence, owner-hint UI polish.

## 8. Required held commits (must reintroduce to hit the target)
1. **827e398** - retail catalog resolves as Known (the no-Needs-Review gold). + write the missing retail-resolve test.
2. **03e0791** - prefix firewall (safety that prevents wrong auto-count and makes auto-resolve trustworthy). Ships 8 tests.

## 9. Risky but valuable commits (reintroduce with proof, after the required two)
- **6937cf3** spend cap / rate limit / kill switch - low risk (only restricts AI calls), high value (wallet). Verify a legit decode still runs. Ships `aiSpendGuard.test`.
- **3e02c8f** flywheel + reverse-UPC + owner hints - valuable but it *writes learned prefixes*; reintroduce after the required two and confirm it never auto-creates aliases/products. Ships `prefixLearning.test`.
- **uncommitted reverse-UPC guard** (`candidateUpcSet.ts` changes in WIP `4876812`) - additive owner heads-up; low risk.

## 10. Corrected acceptance matrix
| # | Acceptance | How it is satisfied | Status now (candidate) |
|---|---|---|---|
| 1 | `078742051451` must NOT resolve as Velvet Torch dress | retail data resolves it as water BEFORE AI; review flow must not verify an empty-identifier AI guess | not yet (no retail in candidate) |
| 2 | `078742051451` SHOULD resolve as Member's Mark water (if retail supports) | 827e398 retail-resolve + retail data containing the code | code missing + data unverified |
| 3 | must NOT create a verified wrong product | review flow must not mark empty-brand AI guess `verified:true` | gap (today it did - via human_review) |
| 4 | must NOT create an approved wrong alias | same | gap |
| 5 | recoverable scans must NOT fall into old Needs Review | 827e398 retail + baseline auto-verify + 03e0791 safety | partial - retail missing |
| 6 | known tire code resolves | baseline tire catalog (present) | OK |
| 7 | known retail code resolves if catalog-backed | 827e398 retail-resolve | missing in candidate |
| 8 | unknown real code fails safely | baseline resolver -> needs_review (safe-fail) | OK |
| 9 | unknown does not auto-count wrong | auto-count gate + 03e0791 firewall; `src/eval/runEval.ts` poison check (`correct = did NOT auto-count`) | firewall missing in candidate |
| 10 | AI-only guess cannot become verified without safe evidence | EvidenceVerifier + decideDecode (baseline) + firewall | partial |
| 11 | trusted-source exact match resolves without manual review | baseline trustedSourceAutoVerify + 827e398 retail | partial |
| 12 | no production Firebase writes | local/emulator only | enforced (`.firebaserc` demo) |
| 13 | no live AI unless approved | mock/IS_E2E in tests; no keys locally | enforced |
| 14 | no Vercel/production deploy | frozen | enforced |
| 15 | no dirty-tree deploy | candidate is clean; main dirty tree never deploys | enforced |

## 11. Revised local proof plan (NOT "goes to Needs Review")
Read-only now; the rest to run LATER in the worktree after the required commits are reintroduced (all mock, no live AI, no prod).
Read-only / already available:
- `git -C C:/tmp/inventory-release-repair log --oneline baseline-v1..HEAD`
- inspect `src/eval/runEval.ts` poison check (already encodes "078742051451 correct = did NOT auto-count").
Later (after reintroducing 827e398 + 03e0791 + tests), in the worktree, mock mode:
- `npm ci`  (materialize deps; no new deps)
- `npx vitest run src/services/catalog src/services/ai src/stores/autoVerify.store.test.ts src/services/security/aiSpendGuard.test.ts` (firewall, auto-verify, spend cap)
- `npx vitest run src/services/resolver.test.ts` (safe-fail layer still green)
- NEW unit test: retail `getByBarcode("078742051451")` hit -> resolves as Known water (currently missing).
- `IS_E2E=1 npx playwright test e2e/auto-verify.spec.ts e2e/verified-decode-not-unknown.spec.ts e2e/firewall.spec.ts` (mock routes).
- NEW e2e (or extend `resolver.spec.ts`): with a seeded retail entry for `078742051451`, scan it -> it RESOLVES as water (NOT a review-row, NOT a dress, NOT auto-counted wrong).
Pass criteria (corrected): no wrong auto-count, no poisoned alias, no fake verified product, recoverable scans auto-resolve, unsafe scans safe-fail, no live AI, no prod writes.

## 12. Exact next owner decision needed
Approve reintroducing the **two required held commits onto the candidate, locally, with their tests** - in this order, stopping for inspection after each:
1. `03e0791` (firewall + safety + faster decode) - it ships 8 tests; lowest behavioral risk, highest safety.
2. `827e398` (retail resolves as Known) - plus write the missing retail-resolve test.
Then decide separately on `6937cf3` (wallet) and `3e02c8f` (flywheel). The retail **data** for `078742051451` and the review-flow "no verified empty-identifier product" guard are tracked as separate items (data + a small safe-fail hardening), not part of this reintroduction.
No GitHub, Vercel, Firebase, push, deploy, merge, or production action is requested.
