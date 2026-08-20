# Testing and Proof

Last verified: 2026-07-29 (coverage map rebuilt from the actual test tree)

_Commands section verified against `package.json` scripts 2026-07-29. Coverage map below replaces the
prior narrative (stale since 2026-07-12) with an area-by-area survey of the actual test tree: file
counts from `Glob`, gate commands from `package.json`, gaps called out plainly where a shipped area has
thin or no visible automated coverage. Historical sections further down (dated, newest-last) are kept
as a record of specific hotfix proof runs and are NOT re-verified as current; treat them as history, not
present-tense truth. Teach Bot harness commands live in `docs/COMMANDS.md` (not duplicated here)._

## Commands
- `npm run test` - run all Vitest unit + dom suites once (`vitest run`, two projects: `unit` = node,
  `dom` = jsdom; see `vitest.config.ts`).
- `npm run test:watch` - Vitest watch mode.
- `npm run test:ledger` - the 8-file crown invariant suite (ledgerInvariants, unknownEnqueue, mergeUnion,
  markWrongTransfer, provenanceTier, goldenClasses store tests + inventory.replay + ladderTimeout).
  Run for ANY counting/ledger change.
- `npm run test:golden` - `src/eval/goldenBaseline.test.ts` only (offline golden-baseline gate).
- `npm run test:corpus-drift` - `src/server/tire-knowledge/corpusDrift.test.ts` only.
- `npx playwright install chromium` - one-time, before the first E2E run.
- `npm run test:e2e` - Playwright E2E, mock backend, port 3100, `IS_E2E=1` (auto-starts dev server,
  writes proof to `e2e/proof/`).
- `npm run test:e2e:firebase` - Playwright E2E against the Firebase emulator, port 3200
  (`playwright.firebase.config.ts`).
- `npm run test:firebase` - Firestore rules + repository suite against the emulator
  (`firebase emulators:exec ... "vitest run src/services/db/firebase"`); these `.rules.test.ts` files
  self-skip (gated on `FIRESTORE_EMULATOR_HOST`) under plain `npm run test`.
- `npm run qa:bots:*` / `npm run qa:revision` - human-bot browser proof suites, port 3300 (see
  `docs/QA_BOTS.md`, `docs/REVISION_GATE.md`). REQUIRED before handoff for scanner/inventory/role/
  export/catalog/alias/resolution/customer-facing changes; `qa:bots:live` for live-account resolution
  changes (owner-gated, live cloud).
- `npm run teach` / `teach:test` / `teach:regression` / `teach:cleanup` - Teach Bot live-app learning
  harness; full command reference in `docs/COMMANDS.md`.
- `npm run proof:all` - THE gate (typecheck + all vitest projects + vitest-excluded node:test suites + teach-bot + test-file discovery, with an explicit NOT RUN list). `proof:local` / `proof:full` remain as the lighter typecheck + vitest (+ build) runs.
- Best-guess identity + shared decode cache (2026-08-19): `src/server/decode/pipeline.test.ts` "L2 negative-cache cooldown, knowledge version, and the pay-once escalation marker" (17 cases: receipt fresh/expired/version-stale, free-only re-evaluation with a fetch stub that throws on any non-free host, pay-once marker, cooldown clock preserved, paid row kept over free title, cap-block replays the shown guess, coalescing); `src/services/ai/identityConfidenceBand.test.ts`; `src/stores/scanStore.rowControls.test.ts` (weak guess banded + Approve/Edit, typed confirm -> tenant alias without double count, floor names get no Approve, decline settles by code, repeat scan never re-decodes); `src/components/LiveScanFeedSuggestion.test.tsx` (controls by state, two-tap Reassign stating the blast radius, focus retention); e2e `e2e/best-guess-identity.spec.ts` (6 clerk-style scenarios, screenshots `e2e/proof/best-guess-*.png`).
- `npm run dev` - manual run (http://localhost:3000, mock backend default).

## Coverage map (by area, verified 2026-07-29)

File counts are `.test.ts`/`.test.tsx`/`.test.mjs`/`.spec.ts` files found via `Glob`, not test-case
counts (`describe`/`it` counts run far higher per file).

| Area | Representative files | Gate command | Notes / honest gaps |
|---|---|---|---|
| Ledger / counting core | `src/services/inventory.test.ts`, `inventory.replay.test.ts`, `src/stores/ledgerInvariants.store.test.ts`, `unknownEnqueue.store.test.ts`, `mergeUnion.store.test.ts`, `markWrongTransfer.store.test.ts`, `provenanceTier.store.test.ts`, `goldenClasses.store.test.ts`, `countAlways.store.test.ts`, `dedupCreate.store.test.ts` | `npm run test:ledger` | Well covered; this is the most heavily tested area in the repo (103 files under `src/stores/`, most touching counting/scan-event paths). |
| Resolver / trust / identity | `src/services/resolver.test.ts`, `resolverTier.test.ts`, `codeTypeDetector.test.ts`, `aliasMatcher.test.ts`, `multiCodeResolution.test.ts`, `productMismatchGuard.test.ts`, `src/services/catalog/identityMerge` tests, `brandFamilies.test.ts`, `src/stores/crossIdentifier.store.test.ts`, `identityMerge.store.test.ts` | `npx vitest run src/services/resolver.test.ts src/services/aliasMatcher.test.ts` | Solid; deterministic-only `known` and conflict routing are directly asserted. |
| Decode pipeline + evidence | `src/server/decode/pipeline.test.ts`, `src/services/ai/evidenceVerifier.test.ts`, `crossCheckEngine.test.ts`, `decode.countable.test.ts`, `decodeBudget.test.ts`, `decodeCache.test.ts`, `fallbackRunner.test.ts`, `src/services/catalog/prefixFirewall.test.ts`, `evidenceScoring.test.ts`, `catalogAutoVerify.test.ts`, plus `src/server/upc/` (ladder, GoUpcProvider, ladderTimeout, freeRungSteering, paidWorkPossible, storage, importBoundary) | `npx vitest run src/server/decode/pipeline.test.ts` (or the full `unit` project) | Broad (157 files under `src/services/`, 41 under `src/server/`). GAP: no test file directly exercises `app/api/ai-lookup/route.ts`'s live-provider call construction beyond the route-level mocked tests (`route.test.ts`, `route.a2.test.ts`, `route.d4.test.ts`, `route.masterAppend.test.ts`, `route.chargeSymmetry.test.ts`, `route.legacyChargePair.test.ts`, `route.rateLimitFailOpen.test.ts` - these DO exist and are solid, correcting an earlier assumption of a gap here). |
| Sync / idempotency / Firestore rules | `src/services/db/firebase/*.rules.test.ts` (15 files: repositories, audit, businessDataLoader, csvImport, tenantIsolation, rolePermissions, sessionPersistence, markWrongTransfer, firebaseSyncTarget, plus `firebaseSyncSafety.test.ts`, `firestoreIndexes.test.ts`, `provisioning.emulator.test.ts`, `storeMappers.test.ts`, `apiRouteImportGraph.test.ts`, `cloudCatalogResolution.test.ts`) | `npm run test:firebase` | Good coverage of the Phase 2 Firebase foundation (tenancy, rules, idempotent sync target) that the old TESTING.md never mentioned - this fills the "Phases 2-6 not appended" gap for backend/sync. |
| Universal import / reconcile | `src/services/csvImport.test.ts`, `csvImport.trustGate.test.ts`, `importSchema.test.ts`, `src/services/import/importFixtureBattery.test.ts`, `importPerf.test.ts`, `universalImport.stageB.test.ts`, `universalImportPreview.test.ts`, `src/services/reconcile/` (reconcileReport, countedByUid, importFuzzyMatcher, normalizedEditDistance, shopwareCsvAdapter, identityMatcher), `src/stores/universalImport.store.test.ts`, `universalImportGtin.store.test.ts`, E2E `e2e/reconcile.spec.ts`, `e2e/phase4-universal-import.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts` | `npx vitest run src/services/reconcile src/services/csvImport.test.ts` | Well covered for a Phase 3/4 area the old doc predates entirely. |
| UI components / stores | 31 files under `src/components/**/*.test.tsx` (ScannerInput, LiveScanFeed, FinalCountTable, NeedsReviewTable, UniversalImportPanel, ReconcilePanel, CatalogReviewTable, AuthGuard, BusinessContextGate, etc.), 103 files under `src/stores/**/*.test.ts` (scanStore split across many focused `scanStore.*.test.ts` files rather than one monolith test file) | `npx vitest run` (dom project) | Deep; the store test files mirror the "grep for symbols" guidance in CLAUDE.md - each store test targets one behavior/bug class rather than the whole file. |
| Persistence backing (#27 IndexedDB) | `src/stores/scanPersistStorage.async.test.ts` (async coalesce/fail-soft/copy-then-clear migration, 6 tests), `src/stores/scanPersistNamespace.async.test.ts` (IDB-aware getPersistedBlob / hasMeaningfulLegacyBlobAsync N2-guard / migrateLegacyBlobOnceAsync / removePersistedKeyEverywhere, 13 tests), existing `scanPersistStorage.test.ts` + `BusinessContextGate.*.test.tsx` (fallback path), E2E `e2e/persist-indexeddb.spec.ts` (real Chromium: scans survive reload via IDB, legacy localStorage blob migrates then clears) | `npx vitest run src/stores/scanPersistStorage.async.test.ts src/stores/scanPersistNamespace.async.test.ts` / `npx playwright test e2e/persist-indexeddb.spec.ts` | jsdom has NO IndexedDB, so every dom-project store test exercises the localStorage FALLBACK path (that is itself the fallback regression proof); the IDB primary path + async-rehydrate seam is proven only by the Playwright spec. The sign-in ADOPT flow against real IDB is not covered by mock E2E (no sign-in there) - manual `dev:emulator` spot-check before merge. |
| E2E - mock (port 3100) | the `e2e/*.spec.ts` files `playwright.config.ts` does not `testIgnore` (`npx playwright test --list` is the count) (scan, resolver, decode, cleanup, auto-verify, auto-decode, trust-gate-law, ledger-markwrong, csv/reconcile phase3-4, camera-scan, a11y, history, variance-report, batch-approve, goupc-ladder, gpt-ladder-burst, etc.) | `npm run test:e2e` | Broad; `IS_E2E=1` forces the AI route to mock-only per `src/eval/playwrightConfigSafety.test.ts`. |
| E2E - Firebase (port 3200) | `e2e/firebase-phase2/firebase-flow.spec.ts` | `npm run test:e2e:firebase` | Thin - only one spec file exercises the real Firebase E2E config; most Firebase proof lives in the emulator rules suite (`test:firebase`) rather than Playwright. |
| E2E - human bots (port 3300) | `e2e/human-bots/scenarios/` (13 files: role-security-leak, export-leak, data-integrity, manager-workflow, platformOwner-tire-resolution, ux-no-training, customer-settings-plain, customer-review-persistence, customer-readable-controls, customer-clean-names, partnumber-display, performance-smoke), `e2e/human-bots/cloud/poisoned-live-account.spec.ts`, fixtures in `e2e/human-bots/fixtures/known-codes.ts` | `npm run qa:bots:*` / `npm run qa:bots:live` (cloud, owner-gated) | This is the human-bot proof gate CLAUDE.md requires before handoff for customer-facing changes; confirmed present and mapped to `docs/QA_BOTS.md`/`docs/AGENT_BOT_ROLES.md` roles. |
| E2E - Teach Bot | `e2e/teach/` harness (`teach.mjs`, `cleanup.mjs`, `bugReport.mjs`, `pdfReport.mjs`) + `node --test "e2e/teach/**/*.test.mjs"` | `npm run teach`, `teach:test`, `teach:regression`, `teach:cleanup` | Self-learning live-app tester per PROJECT_MEMORY (`teach-bot-harness.md`); this is the coverage the old TESTING.md flagged as "never appended" - it exists but as a harness, not a fixed assertion suite, so treat its output (bug reports) as the proof artifact rather than pass/fail counts. |
| Key-safety / import-boundary guards | `src/services/keySafety.test.ts`, `src/server/upc/importBoundary.test.ts`, `src/server/tire-knowledge/importBoundary.test.ts`, `src/services/firebaseAdmin/serviceAccount.test.ts`, `src/services/db/firebase/apiRouteImportGraph.test.ts` | `npx vitest run` (unit project) | Present and enforced at test-collection time (these are static/import-shape assertions, not runtime behavior tests). |
| Auth / accounts (Phase 2) | `src/lib/auth.google.test.ts`, `auth.memberships.test.ts`, `auth.password.test.ts`, `auth.provisioning.test.ts`, `decodeAuth.test.ts`, `src/services/auth/authMode.test.ts`, `authBypass.test.ts`, `src/components/AuthGuard.authmode.test.tsx`, `BusinessContextGate.*.test.tsx`, `src/app/login/login.reset.test.tsx`, `e2e/p2-accounts.spec.ts` | `npx vitest run src/lib src/services/auth` | Present; this is Phase 2 coverage the old doc predates. |
| Scripts / tooling | 32 files under `scripts/**/*.test.mjs` (dt-harvest lib, kkm-catalog, tire-db-repair, release-sentinel, dev-environment, deploy-preview, validate-agents, corpusRules) | `node --test scripts/**/*.test.mjs` (per-script; some run via vitest `unit` project, some via `node --test` - see `vitest.config.ts` exclude list for which is which) | Mixed harness; `vitest.config.ts` explicitly excludes several `scripts/kkm-catalog` and `scripts/tire-db-repair` files from the vitest glob because they're `node:test` suites, not vitest - do not assume `npm run test` covers them. |
| Golden baseline / corpus drift | `src/eval/goldenBaseline.test.ts`, `envGate.test.ts`, `eval.test.ts`, `playwrightConfigSafety.test.ts`, `src/server/tire-knowledge/corpusDrift.test.ts`, `corpusIntegrity.test.ts` | `npm run test:golden`, `npm run test:corpus-drift` | Present; protects the owner-loved 100/100 baseline and corpus integrity against silent drift. |

Known gaps (stated plainly, not invented coverage):
- Teach Bot harness produces bug reports, not a fixed pass/fail regression suite - treat its coverage
  as exploratory, not a gate.
- E2E Firebase config (port 3200) has only one spec file; Firebase behavioral proof is concentrated in
  the emulator rules suite (`test:firebase`), not Playwright.
- `scripts/` test execution is split between vitest and bare `node --test`; running only `npm run test`
  silently skips the `node --test` subset (see `vitest.config.ts` exclude list) - this is intentional
  but easy to misread as full coverage.

## Critical-behavior map (verified 2026-08-18, `refactor/pre-aws-cleanup`)

The coverage map above is organized by AREA. This one is organized by BEHAVIOR: for each thing that
must not break, the specific assertion that would catch the break. It exists because a
provider/infrastructure migration is coming, and "which tests protect me while I move the storage
layer?" is a different question from "what does this directory test?".

Every row was verified by opening the named file, not inferred from a filename.

| Critical behavior | The assertion that pins it | Gate |
|---|---|---|
| Scanner input works and keeps focus | `src/components/scanFocus.test.tsx` - "auto-focuses the scan input on page load"; `LiveScanFeedSuggestion.test.tsx` - approve/decline both assert focus RETURNS to the scan input | `npx vitest run src/components` |
| One physical scan = one inventory count | `src/stores/countAlways.store.test.ts` - "counts an unresolved code exactly once even if invoked twice", plus the 174-code burst acceptance block | `npm run test:ledger` |
| A scan counts even when everything else fails | `countAlways.store.test.ts` - AI OFF / OFFLINE / breaker OPEN each counted; `ledgerInvariants.store.test.ts` walks 12 paths incl. MISREAD, EXAMPLE, CAP-BLOCKED, BREAKER-OPEN, DECODE-IN-FLIGHT | `npm run test:ledger` |
| Duplicate scans increment quantity, never duplicate the product | `countAlways.store.test.ts` - "re-scanning the same unknown code increments the SAME row (count 2, one product)"; `ledgerInvariants` - "path: UNKNOWN-repeat (same code twice, one product)" | `npm run test:ledger` |
| Retries never double-count | `idempotencyKeyRetryStability.store.test.ts` - byte-identical id + idempotencyKey replayed across BOTH the automatic retry and the explicit `retrySync()` path | `npm run test:ledger` |
| Barcode aliases resolve correctly | `src/services/aliasMatcher.test.ts`, `resolver.test.ts` - `known` only from an approved alias or verified identifier | `npx vitest run src/services/resolver.test.ts src/services/aliasMatcher.test.ts` |
| UPC/EAN resolution is correct and lossless | `src/services/upc/gtin.test.ts` - UPC-A and its zero-padded EAN-13 canonicalize to the SAME key, and a case-pack GTIN-14 is NEVER collapsed into the unit GTIN | `npx vitest run src/services/upc` |
| Unresolved items stay reviewable | `unknownEnqueue.store.test.ts` - an unknown scan enqueues SAVE_PRODUCT/SAVE_SCAN_EVENT/INCREMENT_COUNT; `reviewNeverLingersAfterResolve.store.test.ts` - a no-op or conflicting resolve leaves the row OPEN with no fabricated auto-resolved stamp | `npm run test:ledger` |
| Fixing a wrong scan MOVES the count | `markWrongTransfer.store.test.ts`; `ledgerInvariants` - "path: POST-DELETE (quantity transferred to an Unidentified provisional, never lost)" | `npm run test:ledger` |
| Scan sessions are preserved across refresh | `sessionPersistence.store.test.ts` - "setBusinessContext reconstructs the ACTIVE session + its finalCounts (survive-refresh)" | `npm run test:firebase` (emulator) |
| Shops/locations preserve their inventories | `scanLocation.store.test.ts` - location rides on both ScanEvent and InventoryCount, updates mid-session, defaults to the session's | `npm run test:ledger` |
| Users/tenants stay isolated | `src/services/db/firebase/tenantIsolation.rules.test.ts`; `app/api/account/delete/route.test.ts` - "never queries or deletes another tenant's paths"; `account/export/route.test.ts` - "returns only the member's own business docs" | `npm run test:firebase` + `npx vitest run src/app/api` |
| Role permissions hold | `rolePermissions.rules.test.ts`; `account/delete/route.test.ts` - "rejects a viewer role with 403 and deletes nothing"; `FinalCountTable.test.tsx` - alias DB stays platformOwner-only | `npm run test:firebase` |
| Offline loses no scans | `countAlways.store.test.ts` OFFLINE case; `useOnlineStatusSync.test.tsx` - store flips offline on a REAL browser offline event; `SyncStatusIndicator.test.tsx` - honest offline signal | `npm run test:ledger` + `npx vitest run src/components` |
| API behavior stays compatible | 20 route suites under `src/app/api/**/*.test.ts` (ai-lookup x12, account delete/export, businesses, catalog-review, catalog-dispute, share, health, telemetry, reconcile, prefix-floor, import-mapping) | `npx vitest run src/app/api` |
| Product/barcode data stays intact | `src/eval/goldenBaseline.test.ts` (owner-loved 100/100 slice); `src/server/tire-knowledge/corpusDrift.test.ts`, `corpusIntegrity.test.ts`; `scripts/refresh-tire-meta.test.mjs` asserts corpus counts against an INDEPENDENT hardcoded oracle | `npm run test:golden`, `npm run test:corpus-drift` |
| Provider seams have not drifted | `src/lib/auth.contract.test.ts`, `src/services/db/repositories.contract.test.ts` - type-level conformance, enforced by `tsc --noEmit`, both verified to genuinely fail when an implementation drifts | `npm run proof:all` (typecheck leg) |

**The honest gate is `npm run proof:all`, not `proof:local`.** `proof:local` cannot see the 28
vitest-excluded `node --test` suites, and 11 `*.rules.test.ts` files self-skip without a Firestore
emulator (they are most of the "105 skipped" in a green run). Green in `proof:local` is not green.

## History

Dated proof-run records (2026-06 to 2026-08, hotfix-by-hotfix) are archived verbatim in
`docs/archive/TESTING_HISTORY_2026-06_2026-08.md`. They are history, not present-tense truth.

