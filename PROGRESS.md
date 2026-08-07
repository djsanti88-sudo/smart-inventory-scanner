# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> The full 2026-06 phase log is archived verbatim in `docs/archive/PROGRESS_HISTORY_2026-06.md`.
> Last updated: 2026-08-07.

## Standing hazards

- `benchmark-tire-db-automation` - PARKED, do NOT delete or merge (merging deletes 152k lines incl.
  the poison guard); keep the idle pipeline for later. (Carried verbatim from the retired
  `docs/CURRENT_CONTEXT.md`; see `docs/archive/CURRENT_CONTEXT-2026-07-12.md`.)

Current status = the checkpoints below (newest first) + `REPO_HEALTH.md` for repo/branch sync truth.

## Checkpoint 2026-08-07: Firestore restore drill PASSED — F-08 CLOSED + weekly backup live

Executed the `2026-08-07-restore-drill-unblock.md` plan (owner-pre-approved), all four tasks, against
the live `smart-inventory-scanner-app` GCP project. Production `(default)` was READ-ONLY throughout.

- **Root cause found + fixed:** the 2026-07-29/30 import `PERMISSION_DENIED` was the Firestore service
  agent (`service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com`) missing project-level
  `roles/datastore.importExportAdmin` (had only `roles/firestore.serviceAgent`). No org policy / VPC-SC
  in play. Granted the role (retained for future drills).
- **Drill passed end to end:** PITR-window export at snapshot `2026-08-07T14:09:00Z` (scoped to
  `businesses,businessMembers,businessProvisioningRequests,userProfiles,catalogEntries`, excluding the
  ~4M-doc `retailCatalogEntries` mirror) -> 78,979 docs -> imported into scratch DB `drill-20260807` on
  the FIRST attempt (78,979 docs). Spot-check: `businesses` identical 55-doc set in restore vs live
  source; 3 restored docs confirmed (TEACH-BOT Tire Shop business + two verified tire `catalogEntries`).
- **Weekly backup live:** scheduled backup on `(default)`, Sunday, 28-day retention — makes the
  `--source-backup` restore path available going forward.
- **Cleanup:** scratch bucket + `drill-20260807` DB deleted; only `(default)` remains (delete protection
  still enabled). Docs updated: `docs/RECOVERY.md` (Sections 1/2.1/3/5, F-08 CLOSED), `REPO_HEALTH.md`.
- Cost: backup-storage only (single-digit GiB, small monthly) — true spend = billing console after the
  first Sunday backup lands. No paid-API or app-runtime spend.

## Checkpoint 2026-07-29: $150/mo product-readiness master plan + docs-consolidation executed (~19 agents, 4 waves); virtual-shops harness proven live

Two plans landed tonight, both on `chore/docs-consolidation`:
`docs/superpowers/plans/2026-07-29-product-readiness-master-plan.md` (Fable-scored 94/100,
targets a $150/mo-worthy product) and `docs/superpowers/plans/2026-07-29-docs-consolidation-and-repo-health.md`
(the doc-hygiene half of it), run as 4 parallel waves with roughly 19 agents. Commits
`8266b440..HEAD` on this branch (see `df323ecd`..`1999ff14` in `git log`).

- **Docs (M0 lane):** `docs/README.md` added as the doc index; `GUARDRAILS.md` added and now
  auto-loads; `REPO_HEALTH.md` added as the single repo/branch sync-truth doc (44 local branches
  inventoried, categorized, nothing deleted without owner approval). 60 historical
  plans/specs/reports archived under `docs/archive/` with an INDEX + citation updates. Living docs
  (PROGRESS/DECISIONS/TESTING/ARCHITECTURE-adjacent) merged and contradiction-fixed; 5 orphaned
  facts found and promoted into the right living doc instead of staying stranded. `CLAUDE.md` went
  through the attack-panel protocol and slimmed 265 -> 232 lines. Superseded tracked docs deleted;
  some generated reports untracked.
- **Legal + pricing (lane1):** AI-drafted legal docs added under `docs/legal/` with
  review-pending banners (not owner-approved, not published) + pricing-tier research, both explicitly
  drafts pending owner sign-off, not shipped product changes.
- **Virtual shops (lane3):** a new virtual-shops E2E harness (`e2e/virtual-shops/`) with fixtures,
  configs, and 4 shop driver scripts, wired to real driver-fixture contracts. Proven live against
  the actual app: the Rincon shop run scanned 30 codes and counted 30, holding the TOP-LEVEL "every
  scan counts" law with zero app defects found. Other shop runs are still in flight (see Open below).
- **Proof gates:** all green this session - `tsc` 0 errors, `npm run test:ledger` 45/45,
  full Vitest suite 3645 passed.

**Open / parked (owner-gated or unfinished, none silently dropped):**
- Push/PR for `chore/docs-consolidation` and `audit-fixes` - owner-gated, not pushed.
- `.tmp/`-style backup cleanup noted but not executed this session.
- Firestore restore drill (backup/PITR recovery proof) still never run - unverified per `REPO_HEALTH.md`.
- F-01/F-07 Firestore rules/indexes redeploy still pending, owner-gated.
- Uptime monitor still not wired up.
- `npm audit` findings noted, not yet triaged/fixed.
- Remaining virtual-shops driver runs (beyond Rincon) still in flight as of this checkpoint.

## 2026-07-26 Stabilization Phase 2: BLOCKED by Preview environment safety

Local Phase 1 stabilization is committed as `91bd1dc4be065aa2a2e8aea382c556e7161a7985` on
`fix/release-stabilization`; its full local proof and Firebase emulator gates passed. No push or
production deployment was made.

Fresh Vercel inventory found that the newest Preview bundle is configured for
`smart-inventory-scanner-app`, the production Firebase project. The repository's Preview env-parity
gate correctly stopped another deployment. A dedicated Firebase project, `smart-inventory-preview`,
now exists with a protected `nam5` Firestore database and the repository's rules/indexes deployed.
Its browser configuration, Preview-scoped Admin credential, and enabled authentication providers must
be configured in Vercel before authenticated Preview tests.

The Vercel customer-facing Production alias also resolves to an older deployment than Vercel's newest
Production deployment. Release proof must refresh Vercel inventory and test both until the alias is
reconciled. Production remains blocked pending the exact owner phrase `DEPLOY THIS SHA`.

## Checkpoint 2026-07-22: Master plan Phases 1-6 COMPLETE; Teach Bot harness in progress; 2 real bugs found and being fixed

Master plan (`docs/superpowers/plans/2026-07-19-master-plan.md`) Phases 1-6 are COMPLETE per its own
D1-D11 defect register (all items resolved across the dated checkpoints below this one). Work since
the 2026-07-20 P5/P5b/P6 checkpoint:

- **Stress marathon (2026-07-22, COMPLETE):** 998-code marathon + 100-code re-ladder run at 99/100;
  ladder repaired (budgets/preflight/4xx-$0 handling), canonical tire identity + idempotent enrichment
  shipped. See memory `stress-marathon-shipped` for the full commit range (NOT pushed).
- **Teach Bot harness (in progress, two branches):**
  - `feat/teach-bot` (this repo's checked-out branch): Batch A modules shipped and committed
    (`d09fa84 test(teach): finish sheets generator + node:test suite (Batch A)`) -
    `e2e/teach/{knowledge,ladder,manifest,sheets,triage}.mjs` + matching `node --test` suites, backing
    `testing/app-knowledge`, `testing/specs`, `testing/tests/{candidates,permanent}`, and
    `playwright.teach.config.ts` (drives the real deployed app, not mock E2E - owner-gated like other
    live-app runs). The package.json `teach` / `teach:cleanup` scripts point at `e2e/teach/teach.mjs`
    and `e2e/teach/cleanup.mjs`, which do not exist yet on this branch as of 2026-07-22 - orchestrator
    entry point still to be built.
  - `feat/teach-bot-clean`: a separate, isolated-worktree build of the full harness (3 personas,
    cumulative lessons, diagnose-only, ladder trace, budget caps), 127/127 + self-check, NOT run
    against a live target and NOT pushed. Built in a separate worktree specifically to avoid
    interfering with the live session on `feat/teach-bot`. See memory `teach-bot-harness`.
- **2 confirmed bugs, fixes in progress (uncommitted on `feat/teach-bot`):**
  1. **Trust-field persist strip** - `src/services/security/sensitiveFields.ts` /
     `serializers.ts`: `CUSTOMER_SAFE_PRODUCT_FIELDS` was missing `verified` and `businessId`. On a
     customer-role persist/reload round trip those fields were stripped, so the resolver trust gate
     (`matchProductByIdentifiers`, `p.businessId === businessId && p.verified === true`) could never
     match an already-verified product again after a reload - a real resolver regression, not just a
     display issue. Fix adds both fields to the customer-safe allowlist and fixes boolean coercion
     (`p[f] === true` instead of `p[f] ?? ""`) so a missing `verified` never becomes a truthy string.
     Regression test added (`identifierPersist.test.ts`).
  2. **Reconcile header map** - `src/services/reconcile/shopwareCsvAdapter.ts`: `findHeaderKey`
     compared raw candidate strings against normalized (lowercased, whitespace-to-underscore) headers,
     so a candidate like `"pn"` or `"item no."` written in human-readable form could silently
     mismatch. Fix normalizes candidates the same way headers are normalized before comparing, and
     adds missing synonyms (`p/sn`, `us_number`, `stock_number`). This matches master-plan defect D9
     ("Reconcile header matching is a 4-name exact list; one miss rejects the whole file").
  - Both fixes are in the working tree, tests updated alongside, NOT yet committed as of this
    checkpoint (unverified whether full gates have been re-run since these edits - confirm before
    calling this Phase-additional-work done).
- **2 deploy regressions found and under local verification:** commit `41416dc fix(cloud): four
  real-backend sync bugs caught by re-enabling the firebase E2E; business list shows names; suite
  green twice` re-enabled the Firestore-emulator E2E path and caught real-backend sync defects that
  the mock-backend suite could not see. (Unverified as of 2026-07-22 which specific 2 of the 4 fixed
  bugs are meant by "2 deploy regressions" in the owner's session note - the commit message covers 4;
  cross-check `.superpowers/sdd/` or the commit diff before quoting exact bug identities elsewhere.)
- Push, PR, and production promote remain owner-gated; none of the above has been pushed.

## 2026-07-20 Phase 4 Stage A: Universal Import (ship gate COMPLETE, merge owner-gated)

Branch `feat/decode-ladder-goupc`. Plan: `docs/archive/superpowers/plans/2026-07-20-phase4-universal-import.md`
(11 tasks). Commits `0e050ab..23e3465` (Task 1-11 range; the orchestrator fills the final range once
Task 11's proof artifacts are committed). Full Task 11 report: `.superpowers/sdd/p4-task-11-report.md`.

Stage A end to end: upload a CSV/TSV/XLSX file on `/products` -> deterministic column mapping
(header synonyms, then content inference, then manual mapping with per-account memory) -> a preview
classified against the local tire + retail corpus (`part_number_exact` / identity-Jaccard / retail
barcode / review / reject) -> an explicit Apply that counts exact matches through the real ledger
(`applyUniversalImport`, aggregated by code so duplicate rows in one file never double-count) and
routes everything else to Needs Review -> the imported quantity is visible on the Boss Report.

### AC table

| AC | Status | Evidence |
|---|---|---|
| AC1 (deterministic shaping: read, infer, map, signature) | Satisfied | `importFixtureBattery.test.ts` (6 tests) over 4 real fixtures (Shop-Ware CSV, reordered/renamed TSV, nonsense-header CSV forcing manual mapping, a real OOXML xlsx decoded from base64) |
| AC2 (fuzzy fallback tuning beyond the shipped Jaccard threshold) | Deferred to P4b | Out of Stage A scope per the 2026-07-20 plan's Stage A/B split; the identity-Jaccard path itself is already live in `identityMatcher.ts` and exercised by the e2e spec's "review" row, but broader fuzzy-match tuning work is P4b |
| AC3 (mapping memory persists and re-applies) | Satisfied | `mappingMemoryRoundtrip.test.ts` (I7 proof, 3 tests): PUT/GET round trip via the real `getImportMappingMemory`/`putImportMappingMemory` exports on a mock KV seam, remembered mapping re-validates against the same file's headers, cross-business isolation proven |
| AC4 (perf: whole shaping chain under 10s at scale) | Satisfied | `importPerf.test.ts`: 5000-row matrix through infer -> map -> preview end to end, asserted `< 10_000` ms (actual: low tens of ms) |
| AC5 Stage A (real UI end to end: upload through Apply, count reaches the Boss Report) | Satisfied | `e2e/phase4-universal-import.spec.ts`, 2/2 passing (desktop 1280x800 + phone 390x844), 6 screenshots in `e2e/proof/p4-*.png` |
| AC5 fuzzy half (UI proof of a fuzzy-tier auto-suggestion, not just review) | Deferred to P4b | Same Stage A/B boundary as AC2; the e2e spec does prove a non-exact row correctly routes to review, just not a fuzzy-tier "exact-but-not-PN" UI path |

### Demo screenshots (`e2e/proof/`)

- `p4-preview-desktop.png` / `p4-preview-phone.png` - upload result: "Matched 1 of 2 automatically", 1
  exact (real corpus part-number hit) + 1 review (no tire signal), reasons shown per row.
- `p4-applied-desktop.png` / `p4-applied-phone.png` - post-Apply summary banner.
- `p4-report-desktop.png` / `p4-report-phone.png` - Boss Report after import: "Total items: 6" and
  "Top variances: wildpeak_a_t3w: +6", proving the imported quantity reached the real ledger and the
  P3 report page, not just the import panel's own state.

### Known limits (unchanged from Tasks 1-10, restated here for the ship-gate record)

- Legacy binary `.xls` is rejected with an actionable message ("Save it as .xlsx or .csv.") pending an
  owner-approved BIFF parser choice - `universalFileReader.ts` workbookMatrix's catch branch.
- Import mapping memory reuses the `ladder_kv` Turso table (`src/server/upc/storage.ts`) rather than a
  dedicated table - functionally correct and tenant-scoped by key, but sharing a KV namespace with
  decode-ladder usage data is a deferred cleanup, not a Stage A blocker.

### Contract corrections found while writing the ship gate (Task 11)

The task brief's guessed contracts differed from committed source in two places; both were followed
per SOURCE:

1. `src/server/importMappingMemory.ts` exports `getImportMappingMemory`/`putImportMappingMemory`
   (business-scoped, KV-backed), not `loadMapping`/`saveMapping` - those names exist only as local
   wrapper closures inside `UniversalImportPanelContainer.tsx` that call the `/api/import-mapping`
   route, which itself calls the real exports server-side.
2. The seed file `src/server/tire-knowledge/seed/tire_corpus_seed.csv` is pre-generation source data,
   NOT what the runtime loads. The actual runtime corpus is
   `src/server/knowledge.generated.db` (SQLite, `tires`/`retail` tables). Fixture part numbers were
   picked by querying that DB directly and confirmed live against `/api/reconcile/match` on a
   throwaway local dev server before being finalized: Cooper Discoverer A/T3 (manufacturer_part_number
   `90000002732`, size `LT265/70R17`) and Falken Wildpeak A/T3W (manufacturer_part_number `28030703`,
   size `LT275/70R18`). No production gap - the route and corpus both work correctly; the seed CSV is
   just not the deployed data source.

No production source was edited for Task 11 (proof-only: fixtures, unit tests, e2e, this checkpoint).

## 2026-07-15 barcode trust gate Phase 1 (COMPLETE, merge owner-gated)

Branch `feat/barcode-trust-gate` (12 commits off fix/westlake-prefix-recovery). Spec:
`docs/archive/superpowers/specs/2026-07-15-barcode-trust-gate-design.md` (v3, AM-1..AM-12). Plan:
`docs/archive/superpowers/plans/2026-07-15-barcode-trust-gate-phase1.md`. Subagent-driven TDD, per-task
reviews, Opus final whole-branch review: READY TO MERGE (0 Critical/Important).

- TOP-LEVEL LAW recorded (owner order): every scanned code appears on the feed AND counts
  (scan 10 = count 10); gates decide identity only - see CLAUDE.md TOP-LEVEL LAW section.
- `src/services/upc/barcodeTrust.ts`: pure gate, verdicts rejected/suggested/verified, advisory
  pnDerived (structure never grants or denies trust - Sailun's real UPCs embed the PN), placeholder
  blocklist (only structural hard block), verified only via re-checkable ground truth.
- Wired: csvImport buildProductImport (the ungated approved:true back door), resolveUnknown minting
  (single choke point), decode suggestion scrub, dt-harvest guardRow (+ .mjs mirror + drift test).
- AM-2 pins: suggested tier never self-counts (scanGates.ts byte-identical, pinned by tests).
- Multi-angle verification (owner order): adversarial fuzz (50k inputs - found+fixed a Critical
  zero-padded placeholder bypass + a pnDerived DoS), browser law proof (e2e/trust-gate-law.spec.ts
  3/3 + screenshots), test-quality audit (found+fixed a real UPC-E recall bug: 8-digit labels now
  expansion-validate), qa:bots:tire + qa:bots:data (2/2, mock backend).
- Gates: vitest 2353/0 (32 skip), tsc 0, lint = pre-existing scripts/ debt only.
- Deferred Minors: .mjs/TS isPlaceholderBarcode parity fuzz; import-layer UPC-E test (live-probed OK).
- NOT pushed, NOT merged - owner gate. Phase 2 (provenance persistence, count split, promotion) is a
  separate spec-reviewed round.

## 2026-07-12 free-work plan (COMPLETE)

All four phases executed subagent-driven and reviewed (two Opus gates + Opus final
whole-branch review: READY). Full detail: `docs/archive/superpowers/reports/2026-07-12-free-work-execution.md`.

- Phase 0 rescue: `.gitattributes` LFS landmine fixed; branch pushed to origin for the first
  time (`git ls-remote` verified) with 20 `bkp/2026-07-12/*` safety tags; 391MB LFS uploaded.
- Phase 1 cleanup (archive-only, nothing deleted): `reports/` untracked, root artifacts to
  `docs/archive/proof-images/`, 78 tmp scripts to `scripts/archive-tmp-2026-07/` + README,
  CLAUDE.md Firebase reality line fixed, 12 merged branches pruned (tips tagged), 1 worktree removed.
- Phase 2 code health: dead `autoAcceptVerifiedDecodes` removed; `decodeOrchestrator`
  deprecated; 66 characterization tests (fetchV2 scoring/siblingGuard, tirePrefixHints); decode
  pipeline extracted from the route (1097->297 lines, byte-compare verified); pure auto-count
  gate extracted to `src/stores/scanGates.ts` (+25 deny-path tests).
- Phase 3 features (4 parallel branches, each merged `--no-ff` = one-command revert):
  1. **Camera scanning** (`5d48d0b`): BarcodeDetector native + zxing-wasm fallback
     (`barcode-detector@3.2.1`), feeds the same `onScan` path, graceful denied/no-camera/
     load-failure states.
  2. **Free decode rungs** (`70d8692`): UPCitemdb (90/day self-cap) + Open Food Facts (10/min)
     run BEFORE paid rungs in a two-phase ladder; zero paid-cap interaction (free rungs work
     even with the paid cap exhausted); suggestion-only (structurally cannot auto-count).
  3. **Variance/shrinkage report** (`8a36a19`): count snapshots (persist v7, cap 12) + delta
     report + CSV export; customer firewall clean.
  4. **CSV import** (`a341f2f`): preview + confirm, semantic firewall, cleanScanCode-normalized
     matching, store-level idempotency (double-apply proven; found+fixed a real double-merge bug).
- Merge-gate bonus: qa:bots caught a pre-existing Model-column raw-string leak; fixed
  render-only with regression tests (`5f98363`).
- Final gates: vitest 1946/1946, e2e 34/34 (3 new specs), qa:bots 12/12, build + tsc clean.
- OWNER DECISIONS surfaced (not resolved): countSnapshots persisted for all access levels;
  CSV merge-by-sku-alone semantics; UPCitemdb ToS = absence-of-prohibition (confirm before volume).

## Current phase

**DECODE LADDER + SIZE-MERGE + FREE-WORK PLAN: BUILT, REVIEWED, PUSHED TO ORIGIN. NOT DEPLOYED TO PRODUCTION.**

- **Branch:** `feat/decode-ladder-goupc`, 163 commits ahead of `master`, NOT pushed (push and any
  deploy are owner-gated). Working tree also carries uncommitted scratch scripts (`scripts/tmp-*`),
  proof screenshots, `mockups/`, and this docs reorganization.
- **Decode ladder (BUILT, `src/server/upc/ladder.ts`):** the route resolves an unknown code in order:
  1. Local tire corpus / decode cache (Turso + local SQLite; free, ~143ms on preview).
  2. `goupc` rung: Go-UPC API, gated to real GTIN shapes with a valid GS1 check digit.
  3. `fetchv2` rung: Fetch V2 trusted-door discovery.
  4. `gpt` rung: GPT-5.5 (`OPENAI` ladder end). First settled rung stops the ladder; every rung's
     reason is recorded and surfaced. Gemini is permanently OUT of decode (Settings labels it
     "not used for decode"). Daily AI cap charges ONLY paid rungs, never corpus/cache hits
     (`2dcf714`); cap default raised 200 -> 500 (owner authorized 2026-07-10, `456b8a7`); the cap
     counter is an atomic storage-backed increment charged inside the paid rung (fixes the
     double-billing + "cap consumed before cache read" class).
- **Size-merge + brand-family fix (2026-07-10, 4 reviewed commits `a67c490`..`1782c11`):**
  `findIdentityMerge` is size-aware via product `specsShort`/`specsFull` (corpus names are slugs, so
  sizes never appear in names); same-model-different-size tires mint distinct products instead of
  collapsing into review suggestions. `brandFamilies.ts` gained evidenced corporate families
  (Michelin owns BFGoodrich/Uniroyal-NA; Continental owns General; Goodyear owns Cooper/Dunlop-history
  per 2025 Sumitomo purchase), ending the `086699*` false prefix conflicts. scanStore passes decoded
  specs into the merge (`1782c11`).
- **Decode UX fixes (2026-07-09, 16 reviewed commits):** honest failure reasons on the feed, suggested
  identities shown on the scan page with confidence-aware "(suggested)" tag (threshold 0.8), Brand
  column on the feed, scanned Barcode column on Your counts and Needs Review (all roles), Status
  column + suggested-identity display on Your counts, prettified corpus slug names, auto-apply
  high-trust suggestions (>=0.8 or app-verified exact) to the counted row (`c232b5d`), ladder + daily
  counter exposed in Settings.
- **UI PROOF (owner-loved baseline, 2026-07-10):** preview `inventory-5tk3c3vxf`, 100 owner codes
  through the real UI: **100/100 verified, 0 review, 98s**. This is the LOVED reference build; never
  regress it. (Prior run on `inventory-8lnprljm7` had shown 40/100 with 59 size-collapse reviews and
  1 false Michelin/BFGoodrich conflict; both classes fixed above.)
- **Tire corpus:** on Turso + local SQLite; DT harvest COMPLETE 2026-07-09 (+2029 GTINs, 0-block
  crawl); weekly harvest job built, schedule = owner decision.

### Pending owner decisions (blockers for next steps)
1. **Push / deploy gate:** 163 commits are local-only. Production still runs the pre-ladder build.
   Push, PR, and any promote need explicit owner word.
2. **T9 paid backfill:** owner-gated script (`83d3d62`) for the 16 missing tire codes hits paid rungs.
3. **Access model:** preview is open access (owner decision "no login, no shop selection for now");
   the platformOwner/customer role foundation stays DEFERRED (docs/HOTFIX_FOLLOWUPS.md).
4. **Weekly DT-harvest schedule** and merging the harvest branch.

### Latest gates
- Unit suite green on the branch at each reviewed commit (vitest node+jsdom projects); tsc/eslint
  clean; Playwright bot proof through the real preview UI (screenshots `owner-100-ui-*.png`,
  `preview-scan-proof*.png`). `cloudDrainRace.store.test.ts` remains timing-flaky only under full
  parallel load (passes isolated).
- Live-provider calls happen only in owner-authorized manual runs; automated tests stay mocked.

---

## Phase history (condensed; full detail in `docs/archive/PROGRESS_HISTORY_2026-06.md`)

| When | Phase | Outcome |
|---|---|---|
| 2026-07-08..10 | Decode ladder + Go-UPC + UX + size-merge (this branch) | See current phase above |
| 2026-07-03 | Consensus cross-check decode | MERGED to master (PR #10 + #7); production NOT deployed (`vercel.json` blocks master auto-deploy) |
| 2026-07-01..02 | Count-decouple + grounding ladder + corpus lookup (Plans A-D) | Shipped to preview; grounding hallucination class closed by consensus + refusal rejection |
| 2026-06-29 | SQLite corpus + tire hotfix | Shipped |
| 2026-06-14..15 | V1 build, resolver trust hotfix, evidence verification, auto-decode, catalog + cleanup, benchmark harness, Supabase -> Firebase foundation pivot | All complete; see archive |

## Guardrails (do not violate)
- No deploy, no push, no paid/live API calls, no real-data writes without explicit owner approval.
- No keys in client code. No secrets committed. Automated tests never call live providers.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE.

## 2026-07-15 - Recall + Hardening Round SHIPPED (17 commits, f583ddd..9226f3d)
Plan: docs/archive/superpowers/plans/2026-07-15-recall-hardening-round.md (owner-ratified, 3-angle reviewed).
Shipped: Z4+G2+G1 GPT rung upgrades; A3 misread gate; A4 outcome ledger; A6 conservative tire steering;
L2 total ladder deadline + client abort + budgetMs threading (the 36-70s freeze fix); L3 in-flight
coalescing; L6 keyless-never-charges; ASIN /dp/ door + keyless pattern-URL reachability; anti-enumeration
evidence guard; meros probe (0% identity yield - removal decision pending owner); Task 20 decode-cache
backup/restore; Task 21 trusted-source 0.95 floor + prefix-corroborated learned_products tier;
T17 budget drift fix; B2/B5/B8/B3/B6/B7 hardening gates.
Proof: proof:full green (2160 unit / 0 fail), golden 2/2, E2E 36/36, qa:bots 12/12, Opus review x3 all
APPROVE, preview live re-proof (tires 5/5 verified ~200ms, non-tire cached instant, misread honest).
Preview: https://inventory-y4ky0zj9t-sharpenly.vercel.app  Branch pushed through 9226f3d.
Review loop caught + fixed 3 intentional-behavior test fallouts (route cap tests->L6, pipeline spec->AM-7,
e2e fixtures->A3) - all value-only updates, zero weakened assertions.
NEXT: owner demo (2026-07-16); production promote NOT authorized; meros door removal = owner decision.

## Checkpoint 2026-07-20: Phase 2 (accounts/tenancy/server-trust) COMPLETE
Branch feat/decode-ladder-goupc (never pushed). 17 tasks + ultra-review fix wave, all
task-gated. Final gates: unit 2573/0, tsc clean, lint 85 = pre-existing baseline, build
green, test:ledger 41/41, test:firebase green, e2e 49/1 (the 1 = pre-existing goupc-ladder
cap-timing flake). Shipped: AUTH_MODE chokepoint, Google sign-in + reset, per-uid persist
namespace + owner-adopt migration, business-switch + sign-out tenant isolation with
drain-then-warn guard, ai-lookup live auth + D4 clamps + per-account cap on the paid
signal (L12), resolver tier slot, owner-PIN destructive gates, master-catalog deny rules,
Playwright accounts proof. Six real defects caught and fixed by the layered review chain
(details: .superpowers/sdd/progress.md). Phase 3 (sessions/sync/report) planning done,
review-patched, execution starting; DOT tire wedge CUT by owner. Push/deploy still gated.

## Checkpoint 2026-07-20: Phase 3 (sessions / cross-device sync / locations / Boss Report) COMPLETE
Branch feat/decode-ladder-goupc (never pushed). Executed via Codex (implementer) + orchestrator
review/gate split, 15 tasks in 14 commits (9785a81..0d7b9fc) plus the plan commit 42fd07e.
DOT tire wedge CUT by owner order (zero DOT scope).

Full gate sweep (Task 15): unit suite PASS (all vitest projects), test:ledger 43/43,
test:golden PASS, test:firebase 51/51 (incl. getScanEventsBySession + two-device concurrency),
tsc clean, lint 86 = pre-existing 40 errors flat +1 warning in scripts/ (not Phase 3), build
green (all new routes: /report, /report/[token], /sessions/[id], /api/share, /api/share/[token]),
e2e 51 pass / 1 pre-existing goupc-ladder cap-timing flake (untouched decode file since pre-branch).

Acceptance criteria -> proof:
- Auto-sessions idempotent per account/device/window: autoSession.store.test.ts, deviceIdentity.test.ts
- Session history + timeline (getScanEventsBySession): mockDb.test.ts, firebaseSyncTarget.rules.test.ts, sessions/[id]/page.tsx
- Cross-device inbound MERGE never clobbers unsynced rows: refreshFromCloud.store.test.ts + orchestrator source-audit of the double-robust pending guard
- Two devices converge exactly-once: sessionPersistence.rules.test.ts two-device concurrent test (emulator)
- Free-text locations + recents, stamped on scans: scanLocation.store.test.ts, scanPersist.test.ts, phase3-location-moat.spec.ts
- Boss Report (totals, brand/category, moat line, honest null value, print, shareable token): bossReport.test.ts, shareTokenStore.test.ts, report page + auth-gated share routes
- Ledger invariants hold across auto-session rollover: ledgerInvariants.store.test.ts

GATE-SWEEP REGRESSION CAUGHT+FIXED (0d7b9fc): ensureAutoSession on scan-mount rotated any
deviceId-less (hydrated/default/mock) session, wiping visible finalCounts; fixed to ADOPT the
unclaimed in-window session and preserve counts. Per-task gates missed it; the full e2e sweep caught it.

Known limitation: cloud session history is refreshed ON DEMAND (manual Refresh button), not via a
live listener (a naive onSnapshot replace would violate the TOP-LEVEL LAW). Before the first Refresh,
listSessions falls back to [currentSession]; after Refresh, listSessions/reopenSession use the full
Task-7-populated sessions state. Task 14 formal visual-polish agent pass deferred (its e2e screenshot
specs were out of Tasks 10/11 file scope); markup self-review clean. Push/deploy still owner-gated.

## Checkpoint 2026-07-20 (Fable 5 orchestrator session 2): P5 + P5b + P6 CLOSED
Decode Trust (P5), Master Truth (P5b), and Sell-Ready (P6) are complete on feat/decode-ladder-goupc
(NOT pushed). Full battery green: unit 2883/0, ledger 44/44, golden 2/2, firebase 52/52, build,
e2e 56/56, qa:bots 12/12, Argus PASS. Durable ledger: .superpowers/sdd/progress.md (authoritative).
Remaining owner decisions: push/PR, production promote, /code-review ultra, corpus CSV reconciliation.

## Checkpoint 2026-07-22 late evening: Deploy-chaos incident diagnosed + fix round
Branch `fix/rung-trust-and-resolve-stamp` (worktree `inventory-wt-diag`, NOT pushed).

Incident: owner saw the app "go backwards" tonight. Four proven causes:
1. Vercel env split mid-migration - Preview lacked `NEXT_PUBLIC_FIREBASE_*`/`AUTH_MODE` (previews run
   mock by design); Production lacked `GO_UPC_API_KEY` (weaker decode than expected).
2. Master-catalog rung self-poisoning (see DECISIONS entry) activated once
   `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` reached Preview ~5pm; the first credential-bearing builds
   went out 6:02pm+.
3. Commit `092600e`'s auto-resolve stamp hid deliberate-hold review rows.
4. "Old settings" sighting = a stale early-July master fossil served from the `inventory-git-master`
   alias (now deleted), predating the `ebe43e3` hide-AI-internals fix.

Remediation shipped tonight:
- `GO_UPC_API_KEY` added to Production + pinned `a8b0d32` build redeployed (`goUpc.configured:true`
  verified live).
- GitHub integration disconnected from Vercel (manual/CLI deploys only, owner order).
- Three stale git aliases deleted.
- Two TDD fixes on this branch: masterLookup `ladder_verified_strong` entries replay as verified, but
  a suggestion-class master hit falls through the remaining ladder rungs instead of settling it;
  scanStore's auto-resolve stamp now skips rows carrying `suggestedLinkProductId` /
  `lastAliasConflicts` so deliberate-hold reviews stay visible.

Gates: catalog+pipeline 142/142, review-lingering suite 4/4, unit 2618 pass (11 pre-existing
corpus-data failures, identical on clean `dc98c49`), tsc clean, ledger 44/44, build clean.
Failing-first evidence recorded for both TDD fixes.

Next: agy diff review adjudication -> commit -> CLI preview deploy -> owner 128-code verification ->
owner-gated production promote. Open follow-up: master-catalog revocation on mark-wrong (design in
progress, not started).

### Ultracode round close (2026-07-23 00:40)
All fixes landed (21 commits), gates green (unit 2652/0, dom 697/0, ledger 45/45, golden, build), agy + sentinel clean. Preview inventory-5ha3w7se8 proof: 338/338 scans; re-paste = 0 API calls, qty exactly 2x; post-reload re-scan = 0 API calls (persist keeps identifiers + verified + businessId). Awaiting owner: promotion, deployment cleanup, never-again project.

# 2026-07-26 - Inventory stabilization and recovery started

- Owner approved the multi-phase stabilization-first plan.
- Created isolated worktree `C:\tmp\inventory-stabilization` on
  `fix/release-stabilization`, based on current `master` (`e5f0157`).
- Original `feat/teach-bot` worktree and its untracked files remain untouched.
- Added `docs/RELEASE_TARGETS.md` with canonical GitHub, Vercel, Firebase, Turso, runtime, preview,
  production, rollback, and repository-state facts. No secrets or environment values are recorded.
- Phase 1 parallel tracks: cloud sync safety, atomic auth provisioning, and role/rules alignment.
- Production deploys, pushes, paid/live calls, and production configuration remain separately gated.

## Checkpoint 2026-07-26: Stabilization Phase 1 gate PASSED locally

Worktree `C:\tmp\inventory-stabilization`, branch `fix/release-stabilization`, based on
`master` at `e5f0157`. The owner's dirty `feat/teach-bot` worktree remains untouched. No commit,
push, deployment, paid provider call, or production data/configuration mutation was performed.

Implemented:

- Firebase signup, password login, and Google login now share one authenticated, atomic,
  idempotent workspace-provisioning route. Account creation is distinguished from workspace setup
  failure, and the UI provides repair/retry paths with safe Firebase error messages.
- Membership loading resolves real business names, excludes missing/orphan parent businesses, and
  requires explicit selection when multiple valid businesses exist.
- Pending named-business requests use opaque per-request storage keys, so two interrupted requests
  do not overwrite each other and raw UIDs/business names are not retained in browser storage.
- Sync applied-key document IDs preserve safe legacy IDs and deterministically hash unsafe,
  reserved, or oversized IDs. Full operation envelopes are validated and replay conflicts are
  terminal instead of retrying forever.
- Tenant switches clear tenant-visible state immediately, preserve separately partitioned pending
  queues, stop stale drains, and prevent late loaders from restoring the prior tenant.
- Counter count writes require an active owned session, a matching applied marker, an exact
  quantity transition, and append-only scan-event identity. Duplicate scan events are no-ops.
- Local Firebase development now configures both browser SDK and Admin SDK emulator context.

Independent Critical/High review then found and locally repaired three authorization defects:

- Admins could promote themselves to owner or remove an owner. Member identity is now immutable,
  owner memberships are server-managed, and admins can manage only non-owner roles.
- A foreign account could preclaim a predictable provisioning ID. Client business creation is now
  disabled, every existing provisioning target must belong to the verified UID, and both default
  and named requests atomically converge on a fresh fallback when a legacy ID is foreign.
- Counters could forge a paired count without a real scan. Counter count writes now require a real
  same-business, same-session, same-product `+1` scan event; duplicate-event metadata remains a
  zero-delta no-op. Owner/admin maintenance adjustments retain their separate privileged path.

Verified:

- TypeScript: `npx tsc --noEmit --incremental false` passed.
- Ledger: 45/45 passed.
- Post-review provisioning: 15/15 passed.
- Post-review focused auth/provisioning: 69/69 passed.
- Post-review focused sync/tenant suites: 27/27 passed; 13 emulator cases were skipped.
- Store regression suite: 532/532 passed.
- Sign-out/orphan UI: 12/12 passed.
- Emulator environment helper: 2/2 passed.
- Earlier combined Auth + Firestore emulator sweep: 85/85 passed before the final rule-hardening
  additions.
- Full Vitest discovery reached 3,376 passing tests; the remaining 88 failures are corpus-backed
  suites cascading from the unavailable generated SQLite corpus in this isolated worktree.
- `git diff --check` and targeted changed-file lint passed with zero errors and two existing
  unused-symbol warnings. Full-repository lint still has 46 unrelated pre-existing errors.

Final Phase 1 proof (2026-07-26):

- Firebase Auth + Firestore emulator: 13 files, 95/95 tests passed after the final rule hardening.
- Full corpus-backed proof: 365 files passed, 3,472 tests passed, 59 intentionally skipped.
- Next.js production build: passed. The temporary worktree now has a local lockfile-pinned
  `node_modules` directory; Next 16 rejects a junction that points outside the worktree.
- Release sentinel remains correctly blocked until this work is committed and an exact SHA receives
  a production approval. Phase 2 preview proof starts from that committed SHA.

Detailed report:
`docs/archive/superpowers/reports/2026-07-26-inventory-stabilization-phase1.md`.

## Checkpoint 2026-07-27: GitHub-truth repo health effort
Plan: `docs/archive/superpowers/plans/2026-07-27-github-truth-repo-health.md` (Opus-authored, Codex+Argus
reviewed). Goal: certify `master` as source of truth, rescue valuable unmerged work into PRs, clean up
stale branches, and cut deploys over from local Vercel CLI to GitHub-driven (PR previews + gated
production).

- **Master certification**: gate battery (tsc, unit+dom, ledger, build, e2e) run clean on
  `origin/master`; the 2026-07-22 tree-swap (`2ddc081`) reviewed and confirmed lossless (no commit
  content dropped versus master-before).
- **Branch rescue**: 6 PRs opened (#12-#17) carrying the VALUABLE-UNMERGED work identified by scout
  (feat/teach-bot, fix/release-stabilization, fix/phase3-followups, fix/argus-cp1252,
  feat/reverse-upc-heads-up, hotfix/decode-auth folded where duplicate).
- **Branch cleanup**: kill list prepared (archive-tag-then-delete per branch, tags pushed and
  verified via `git ls-remote --tags` before any delete) - execution is owner-gated at Gate 3, not yet
  run.
- **CI**: `.github/workflows/ci.yml` authored (tsc + lint + unit/dom + build), alongside the existing
  mock Playwright workflow (`.github/workflows/playwright.yml`, not a required check). Branch
  protection is now **applied and confirmed live** on `master`: required status checks
  `[typecheck, unit-tests, build, lint]`, `strict: true`, `enforce_admins: true` (verified via
  `gh api repos/:owner/:repo/branches/master/protection`). The Vercel Git connection to this repo
  remains a **pending owner dashboard step**, not yet confirmed/applied as of this checkpoint.
- **PR train status (as of 2026-07-28, snapshot - see `docs/DEPLOY_TRUTH.md` or `gh pr list` for
  current state)**: #12-#17 are MERGED, including #17 (the CI workflow itself). #19 (rescue/teach-bot,
  `c71e6d9`) and #20 (feat/decode-gpt-54-mini, `0e5b179`) are now MERGED too. #18 and #21 remain OPEN,
  in merge order: #18, then #21 last (#21 is the cutover flip - flipping `vercel.json`'s
  `deploymentEnabled.master` flag - and is deliberately merged after every other PR in the train per
  the Sequencing rule in `docs/DEPLOY_TRUTH.md`).
- **Cutover status (as of 2026-07-28)**: Preview-env live-AI-key lockdown and CI required-check merge
  are DONE; branch protection is now APPLIED and confirmed live (see above). Remaining steps, in
  order: Vercel Git connection verified (owner dashboard, pending), then the `vercel.json`
  `deploymentEnabled.master` flag removed last (PR #21). Docs (`CLAUDE.md`, `docs/COMMANDS.md`,
  `docs/DEPLOY_TRUTH.md`) updated ahead of the cutover to describe the target GitHub-driven state;
  `docs/GO_LIVE_CHECKLIST.md` still describes the old disconnected state and needs a follow-up pass
  once cutover actually lands.
- Next: owner reviews Gate 1-5 batches per the plan; nothing in this effort pushed master, merged a
  PR, deleted a branch, or touched Vercel/GitHub config without that approval.

## Checkpoint 2026-08-03: Retail corpus v2 evidence-preserving rebuild

- Scanned 4,532,767 raw Open Food Facts rows offline and retained 4,373,077 unique checksum-valid
  GTINs with immutable source evidence; 2 malformed and 159,638 invalid-GTIN rows were rejected.
- Classified every retained GTIN: 4,046,693 serving-safe known products, 325,846 review rows, and
  538 quarantined rows. Forty-five conflicting duplicate GTINs fail closed into review.
- Rebuilt the combined SQLite knowledge database with 4,046,693 retail and 78,838 tire rows;
  fixed-path and decompressed-gzip hashes match and both integrity checks return `ok`.
- Added deterministic, bounded-memory builders, compressed evidence/review artifacts, atomic
  promotion/rollback, poison and zero-padding gates, baseline diffs, and machine-readable receipts.
- Green proof: 39 new Node and 6 new Python corpus tests, 3,724 full local tests, ledger/golden/drift suites,
  focused lint, Next.js production build, and the mock full inventory scan Playwright test.
- No paid/live provider, production Firebase/Turso, deployment, customer import, commit, or push was
  performed. Upstream license/provenance approval remains required before publication or live use.
- Detailed receipt: `docs/analysis/retail-corpus-v2-2026-08-03/README.md`.

## Checkpoint 2026-08-05: diagnostic verdict, owner rule, fix branch executed

- Diagnostic (5-agent + Codex): localhost:3400 was the boss certification harness (branch
  codex/boss-barcode-fastpath-safe, synthetic allowlist local-corpus-certification) - every real session
  got the canned trusted-exact miss. Owner codes 3220015959/3220016695/3220017458/3220017198 (10-digit,
  gtin_valid=false) were never promoted (BOSS_UNRESOLVED_REVIEW.csv, 697 rows); 8848116004503 IS in
  corpus+Turso and missed only via the allowlist.
- Two live defects found and fixed on branch fix/decode-diagnostic-2026-08-04 (base 5038de82, worktree
  C:\tmp\scanbin-fix-diagnostic): sanitizer masked bare 10-digit codes into [redacted-phone] pre-pipeline
  (fix 4e0bfe9b + 4e43e786); non-GTIN codes dead-ended at the trusted-exact fallback (owner-rule fix
  22f2c1c3 + panel fix round pending commit). Also: honest deterministicOnly reasons (4e43e786), tire JSON
  index status on /api/health (f7c27069), trustedExact.allowlistConfigured on status GET + port-3400 docs
  (214f9b2a), boss workbook dry-run gate (d192736b + c52ab59c).
- OWNER RULE 2026-08-05 recorded (CLAUDE.md decode section, GUARDRAILS.md, LESSONS L16): codes not in the
  DB always continue through the ladder, every environment; probes never dead-end.
- Boss Turso data verified clean: all 5,561 boss-touched tires carry valid GTINs; NOTHING deleted; full
  backup + dry-run-verified PROPOSED_DELETES.sql at backups/turso-boss-export-2026-08-04. Workbook truth:
  6,990 rows (6,097 accepted / 697 needs_review). Corrected-workbook upsert path prepped (reconcile
  dry-run script); live import stays owner-gated.
- retailtursodatabase uncommitted tree ADJUDICATED: Gemini said keep-all; Codex deep review found 5
  Criticals (incl. LiveScanFeed 100-row render limit proven to hide row 101 = TOP-LAW violation,
  Firestore-rules-forbidden counter merges, Math.min shortage commit). Verdict = cherry-pick donors
  (ScannerInput+test, retail-quality+test, upc/storage+tests), rebuild trusted-exact integration clean,
  discard generated payloads + testing/app-knowledge placeholder overwrites. Tree left UNTOUCHED as donor;
  extract-vs-delete is an owner decision. SDD ledger:
  .superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/progress.md.
- 2026-08-05 close: fix branch final state = 10 commits, tip 9345522a (adds final fix wave: client-side
  bare-code passthrough end to end, health privacy, honest trustedExact.path + gate labels, RFC-4180
  workbook parser). Final review + scoped re-review CLEAN; proof:local 3786+ tests green; ledger gate
  green. Merge/push awaits owner. Follow-ups ledgered: same-class masking in legacy lookupUnknown +
  backgroundVerifyDeep; lookupUnknown label collapse; pipeline free-settled-suggestion paid escalation
  (owner ruling needed); Argus engine env defect (tools/fable5 doctor).

## Checkpoint 2026-08-05 evening: boss truth + localhost proof phase

- Phase A (diagnostic fixes, Tasks 1-9) COMPLETE. Branch `fix/decode-diagnostic-2026-08-04`, base
  `5038de82`, tip `9345522a`; 9 commits (verified via `git log 5038de82..9345522a`): `d192736b` (boss
  reconciliation dry-run gate), `f7c27069` (tire JSON index status on /api/health), `4e0bfe9b` (bare
  numeric codes survive sanitization), `c52ab59c` (vitest exclude + RFC-4180 CSV parsing), `4e43e786`
  (honest deterministic miss reasons + truthful sanitizedInput echo), `214f9b2a` (trustedExact.
  allowlistConfigured on status GET), `22f2c1c3` (owner rule: trusted-exact misses continue the ladder),
  `4695dd1d` (honest resolution when the inner AI gate blocks continuation), `9345522a` (final wave:
  end-to-end bare-code path, health privacy, honest paths/labels, RFC-4180 parser). All gates green;
  final review plus fix wave plus re-review clean. Merge/push stays owner-gated.
- Donors extracted (3 contributors) after the retailtursodatabase salvage verdict: A2 (Sonnet, 9/9 node
  tests, `9acd59b8`), A4 (Sonnet, 215/215 component tests, ScannerInput flagged for D4 priority proof,
  `ef662865`), A3 (Codex, 156/156 upc tests, `b72ba8ae`). retailtursodatabase branch deleted after
  cherry-pick; main repo HEAD = master `b72ba8ae`.
- Phase B3 (Turso promotion) COMPLETE. Live run timestamp `20260805_184504`; backup
  `backups/turso-backup-20260805_180008` (SHA `05aba94209a266f7c91da39d5c43d8f49ce12aa47448a22183118e
  2fabb5843b`); live inventory 83,374 tires (+320 inserts, -18 placeholder drops, 3,108 blank-fills
  incl 8 repoints, 1 deferral NX10557); rollback path `PROMOTE_CONFIRM=YES node
  scripts/boss-override-2026-08-05.mjs rollback --ts 20260805_184504`; all 14 gates PASSED pre-swap,
  post-swap smoke PASS; Gate A rewritten as staging-readability (26/26 tests) after PRAGMA
  integrity_check proved transport-infeasible over Turso HTTP (LESSONS L19).
- Phase B4 (exact-index and reconciliation) COMPLETE. Exact-index rebuilt on corrected boss truth:
  84,791 keys / 6,354 boss codes, corrected hash `942F43EA` (prior stale `CF61D1`). Reconciliation
  closure exact at 6,990 rows (41 preserved + 1 reclassified + 36 pair-blocks). Overlay artifacts:
  `BOSS_ROW_RECONCILIATION_v2.csv` (SHA `9ED7FE7B`), `REPAIRED_TIRE_DATABASE_v2.db` (SHA `5BBA95B3`).
  Known gap (owner follow-up): harvest-source lineage shrink 78,437 to 76,341 (about 2,096 rows), no
  checkpoint of the original harvest snapshot.
- Phase B5 (boss identity resolution proof) COMPLETE. 3,428/3,428 eligible boss rows authenticated
  (100%); 0/36 conflict-code leaks; 0/20 unauth data leaks; 1,000/1,000 public-barcode sample verified.
- Phase D1 (environment setup) COMPLETE: worktree `.env.local` composed (31 vars); emulators up
  (9099/8080), fixture seeded and proven. Phase D2 (dev stack + browser smoke) COMPLETE: all status
  assertions PASS, browser smoke 8/8 PASS (screenshots `e2e/proof/localhost-2026-08-05/smoke/`), 0
  console errors, corrected boss code verified via free tire-corpus rung, old bogus code honest miss
  with owner-rule continuation (fetchv2 only, GPT never fired).
- Phase D3 (mass decode campaign) COMPLETE: FREE cohort (boss 3,429 + corpus 5,000) 8,429/8,429
  settled, 0 dropped, 0 paid rungs fired, tripwire never tripped. EDGE cohort 7/7 ran; GPT ladder
  self-disabled after $2.73/$3.00 spent (91%, all 7 calls failed post-execution).
- Phase D4 (browser fleet proof) COMPLETE with a harness defect found and self-rescued: a shared MCP
  browser singleton stomped parallel-agent sessions (LESSONS L17). W1 PARTIAL PASS (60/60 burst,
  58/60 identity; real bug: 049000-prefix tire barcodes show brand "Coca-Cola", 2/2 repro). W1b PASS
  (isolated rerun). W2 PASS (review lifecycle, count law held). W3 PASS-with-contamination; real bug
  found and fixed: size search containing "/" returned zero results (`filterProducts.ts`, fix
  `44e46f3d`, 140 tests green). W4 BLOCKED by the shared-browser defect plus a seeding bug; the 9/9
  scans that did land were verified correctly; rerun plan pending (isolated-Chromium pattern).
- Phase D5a (data-loss and rehydration proof) PASS, no data loss across reload x3, nav, sign-out/in,
  and second-device convergence. Minor bug found: suggested rows relabel to "Looking up product..."
  after reload (follow-up listed). Baseline discrepancy investigation deferred to D5b.
- IN-FLIGHT at time of writing (not yet closed): D5b (pendingSync flush check plus emulator Firestore
  check), D6 final gate battery (`proof:full`, `test:firebase`, exact-index `--check`, receipts), and
  the owner merge/push decision on the fix branch. Ultra review plus fix wave already landed clean:
  overlay hardening `ad32f0d0`, override hardening `236e7f13` (50/50 tests), annotate-drops executed
  live (18 rows, rerun-idempotent), size-search fix `44e46f3d`, floor-brand class fix `cd9e7c51`.
- Spend: computed floor $2.73 today (GPT ladder rung only, 7 live calls, all failed post-execution,
  worst case $0.39 each; ladder self-disabled for the rest of the day). FetchV2 and Go-UPC both
  compute to $0 (Brave free tier, Firecrawl not configured; Go-UPC flat-rate plan, marginal cost 0).
  True spend = the OpenAI billing console for the configured key; owner reconciliation still required,
  not yet done.
- Evidence pointers (`.superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/`):
  `EVIDENCE-MANIFEST.md` (88 screenshots, 19.2 MB, indexed by wave, plus every report/audit file);
  `OWNER-FOLLOWUPS.md` (27 items: 25 open plus 2 closed-decisions, ranked now/soon/later). The
  GREEN-REPORT (D6's final all-green receipt) has not been produced yet; D6 has not run as of this
  checkpoint.
