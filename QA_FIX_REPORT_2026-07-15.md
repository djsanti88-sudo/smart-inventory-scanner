# QA Fix Round - Final Report (2026-07-15)

Worktree: `C:/tmp/wt-qafix`, branch `fix/qa-report-2026-07-15`, based on `74fabc8`.
HEAD at report time: `2a1c9dc89f20e73fc08baed2f0c48055cb84cf66`.
Plan: `QA_FIX_PLAN_2026-07-15.md` (owner-approved, root causes from an 18-agent investigation:
9 investigators + 9 adversarial verifiers, all findings verified against code).

## The 8 fixes (TDD, one commit each)

| # | Commit | Fix |
|---|---|---|
| 1 | `01ed46e` | fix(review-queue): one-tap Link action for `suggest_link` candidates - the "Approve suggestion" button was a silent no-op because no UI ever rendered `suggestedLinkProductId`; now a `Link to <product>` button routes through the existing `link_existing` approval path. |
| 2 | `70a6d7c` | fix(decode): stop leaking raw rung/provider names (upcitemdb/openfoodfacts/goupc/fetchv2/gpt-5.5/ladder) in customer-facing scan reason text; routed through the existing `REASON_TEXT` safe lookup, raw names stay in the platform-gated debug surface only. |
| 3 | `3e97748` | fix(csv-import): Products-page CSV panel now carries brand/category/specs/location (previously only name/sku/barcode/qty were mapped) and warns on unmapped columns; the ExportMenu path was already correct and untouched. |
| 4 | `86c9c3d` | fix(resolver): GTIN-14 canonicalization for leading-zero equivalence (e.g. `00049000028911` now matches product UPC `049000028911`) using the existing `canonicalGtin`/`gtinVariants` helpers, additive only, case-pack indicator digits are never stripped, non-GTIN codes are untouched. |
| 5 | `f959d3e` | fix(corpus): sanitize retail corpus poisoning (multi-brand/run-on brand strings, over-length garbage, placeholder-barcode families) at ingest, plus a garbage-detector gate before candidate-pool admission, plus a read-time guard in `retailKnowledgeIndex.ts`; also closes an `EvidenceVerifier` bypass where the structured-DB consensus path hand-set `evidence.verified=true` without ever calling `verifyEvidence`. Turso was NOT synced - local rebuild only, per the gated-data-change rule. |
| 6 | `3849402` | fix(persist): explicit local-mode flag so the open-access (no-login) runtime keeps aliases + barcodes across reload, instead of the "business" persist-stripping branch silently discarding them. **This commit introduced a regression, caught and fixed at `2a1c9dc` (see below).** |
| 7 | `339ed09` | fix(csv-import): re-import on an existing barcode now refreshes descriptive fields (name/brand/category/specsShort/location) with honest summary copy ("matched existing products, fields refreshed"); previously one path silently discarded the row as a "conflict" and the other path claimed a quantity "merge" that never actually changed anything. |
| 8 | `61e9cd6` | feat(resolver): review-only near-match part-number suggestion (Levenshtein distance <= 1, single candidate only) surfaces "Did you mean X?" on Needs Review; never auto-counts, never auto-aliases, resolverStatus stays `needs_review`. |

## Regression caught and fixed

`2a1c9dc` - **fix(role): scope QA Task 6 local-runtime override to persist only, restore
customer UI gating.**

Bisect proved Task 6 (`3849402`) broke `FinalCountTable.test.tsx` (2 tests: role-gating of the
"Other codes scanned" column, and Model-cell UPC/customer sanitization). Root cause: Task 6 folded
the local-runtime override into `effectiveClientAccessLevel`, which is the **shared UI role hint**
(`useAccessLevel`) — not just the persistence seam. In any runtime with no cloud backend and no
auth-bypass (every unit test, and the real open-access local device), the UI then rendered as
"platform" instead of "business," leaking the raw alias DB and un-cleaned Model/name identity
strings that customer role-gating and customer-sanitization exist to hide, and made those
guarantees unprovable by test.

Fix: the local-runtime override now applies **only** to the persist seam
(`persistAccessLevel`), so Task 6's actual goal (the owner's aliases + barcodes survive reload on
their own no-login device) is fully preserved, while `effectiveClientAccessLevel` goes back to
being a pure UI role hint (`business` for a non-platformOwner). Data survival and UI customer
gating are now decoupled. Three regression tests were added in `scanPersist.test.ts` pinning this
seam so it cannot re-couple silently.

This is the kind of fix a whole-branch reviewer is expected to catch; it was instead caught by
running the full gate suite before declaring the round done, which is exactly why the gate step
exists.

## Gate table

| # | Command | Result | Exit code |
|---|---|---|---|
| 1 | `npx vitest run` | **2294 passed / 0 failed / 32 skipped**, 231 test files passed + 8 skipped (239 total) | 0 |
| 2 | `npx tsc --noEmit` | Clean, no errors | 0 |
| 3 | `npm run lint` | 40 errors / 38 warnings reported, but ESLint itself exits 0 (project's lint gate is non-blocking on these pre-existing findings). See "Lint detail" below. | 0 |
| 4 | Targeted Playwright (review queue + CSV import + scan) | **11 / 11 passed**, 0 flaky, 0 rerun needed | 0 |

### Gate 1 detail - unit suite
```
Test Files  231 passed | 8 skipped (239)
     Tests  2294 passed | 32 skipped (2326)
```
Matches the expected ~2294 passed / 0 failed / ~32 skipped / ~237 files baseline. The prior
`FinalCountTable` regression (introduced by Task 6, `3849402`) is confirmed fixed at `2a1c9dc` -
no failures anywhere in the suite.

### Gate 3 detail - lint
All 40 errors and 38 warnings were checked against the files this round actually touched (`git
diff --stat 74fabc8 2a1c9dc`, 34 files). **None of the erroring files were touched by this
round.** Every lint finding lives in pre-existing files this round never edited:
`scripts/import-retail-to-catalog.ts`, `scripts/measure-relaxed-verify.ts`,
`scripts/seed-tires-from-catalog.ts`, `scripts/test-20-scans.ts`, `scripts/weekly-accuracy.ts`,
`src/server/upc/ladder.test.ts`, `src/services/ai/gptFromScratch.test.ts`,
`src/stores/autoCountBattery.test.ts`, and assorted `scripts/*` unused-var/unused-expression
warnings. The `csvImport.ts` no-control-regex disable warning named in the task is confirmed
pre-existing (that file was touched by this round for Task 3/7 logic, but the disable comment
itself predates this round and was not added or changed by it).

### Gate 4 detail - targeted Playwright
Ran with `IS_E2E=1` / the project's mock-only `playwright.config.ts` (webServer forces
`NEXT_PUBLIC_FIREBASE_BACKEND=0`, no live provider calls possible). Specs run:
`csv-import.spec.ts`, `scan.spec.ts`, `scanner-focus.spec.ts`, `resolver.spec.ts`,
`suggested-decode.spec.ts` (3 tests), `suggested-label.spec.ts`, `firewall.spec.ts`,
`batch-approve.spec.ts`, plus `auto-count-tire.spec.ts` as extra decode/review coverage (the spec
the memory notes flagged as migrated to the advisory-when-app-verified rule in a prior task). All
11 passed on the first run; none needed an isolated rerun for flakiness.

## Proof type

- **Automated, mocked proof** for all four gates. No live AI/paid provider calls were made
  anywhere in this round's verification (unit tests mock `fetch`/engines; Playwright's webServer
  runs with `IS_E2E=1` which forces the AI route to mock-only, per `playwright.config.ts` comments
  and CLAUDE.md's TEST SAFETY rule).
- No manual/live proof was run in this pass. Manual live-provider testing, if ever needed, is
  documented separately in `MANUAL_LIVE_TEST.md` and was out of scope here.

## Known limitations

1. **Issue 4 (Save-count-snapshot) - unresolved by design, not re-verified here.** The QA plan
   records the owner's decision that the original tester finding was likely against a stale
   Vercel preview build, and that this passes all three test layers on HEAD already. The plan
   explicitly defers re-verification to "a fresh preview build" rather than chasing it locally.
   **This report does not re-verify it** - no fresh preview was built or checked as part of this
   gate run. That remains an open action item before the round can be called fully closed.
2. **Turso/production corpus data was not synced.** Task 5's corpus-poisoning fix rebuilt the
   local knowledge DB only, per the plan's explicit gate ("produce a before/after diff for the
   owner, do not sync"). A before/after row-count/sample diff for the owner's review was called
   for by the plan; confirm with the Task 5 commit whether that diff was produced as part of the
   commit body before treating Turso as caught up.
3. **Lint has 40 pre-existing errors and 38 pre-existing warnings** in files unrelated to this
   round (mostly one-off analysis/harvest scripts under `scripts/`, plus a few pre-existing
   `any`-typed test files). None block CI today (lint exits 0), but they represent real
   `no-explicit-any` / `no-require-imports` / `prefer-const` debt that predates this round and
   was intentionally left untouched to keep this round's diff scoped to the 8 fixes + 1
   regression fix.
4. **Only a targeted Playwright subset ran, not the full E2E suite.** Per the task instructions,
   the full suite was judged too broad to run for this gate; the 11 specs run cover review queue,
   CSV import, scan, and one extra decode/auto-count spec. Specs outside this set (camera scan,
   variance report, identifier backfill, phase1 benchmark, etc.) were not re-run in this pass.
5. **This worktree has uncommitted, intentionally-excluded files**: `QA_FIX_PLAN_2026-07-15.md`
   and `dev/` remain untracked/uncommitted in the working tree by design (per task instructions)
   and are not part of this docs commit.
6. A whole-branch reviewer was running concurrently against this same worktree in read-only mode
   during this gate run; this report only reflects the doc-commit boundary described above and
   does not duplicate or supersede that review's findings.

## Git status at commit time

Docs commit includes exactly: `QA_FIX_REPORT_2026-07-15.md`, `PROGRESS.md`, `TESTING.md`.
Excluded (left uncommitted, untouched): `QA_FIX_PLAN_2026-07-15.md`, `dev/`.
No push, no deploy performed or requested.
