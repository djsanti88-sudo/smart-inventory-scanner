# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> The full 2026-06 phase log is archived verbatim in `docs/archive/PROGRESS_HISTORY_2026-06.md`.
> Last updated: 2026-07-20.

## 2026-07-20 Phase 4 Stage A: Universal Import (ship gate COMPLETE, merge owner-gated)

Branch `feat/decode-ladder-goupc`. Plan: `docs/superpowers/plans/2026-07-20-phase4-universal-import.md`
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
`docs/superpowers/specs/2026-07-15-barcode-trust-gate-design.md` (v3, AM-1..AM-12). Plan:
`docs/superpowers/plans/2026-07-15-barcode-trust-gate-phase1.md`. Subagent-driven TDD, per-task
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
whole-branch review: READY). Full detail: `docs/superpowers/reports/2026-07-12-free-work-execution.md`.

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
Plan: docs/superpowers/plans/2026-07-15-recall-hardening-round.md (owner-ratified, 3-angle reviewed).
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
