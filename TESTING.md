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
- `npm run proof:local` / `proof:full` - `tsc --noEmit` + `vitest run` / + `next build`.
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
| E2E - mock (port 3100) | 57 files under `e2e/**/*.spec.ts` (scan, resolver, decode, cleanup, auto-verify, auto-decode, trust-gate-law, ledger-markwrong, csv/reconcile phase3-4, camera-scan, a11y, history, variance-report, batch-approve, goupc-ladder, gpt-ladder-burst, etc.) | `npm run test:e2e` | Broad; `IS_E2E=1` forces the AI route to mock-only per `src/eval/playwrightConfigSafety.test.ts`. |
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

## Historical sections below (dated, not re-verified as current)

## Current state (2026-07-12)
- Unit suite green at each reviewed commit on the branch; tsc + eslint clean. Known flake:
  `cloudDrainRace.store.test.ts` is timing-flaky under FULL parallel vitest load only (passes isolated).
- Decode ladder coverage lives in `src/server/upc/` (`ladder.test.ts`, `GoUpcProvider.test.ts`,
  `goUpcUsage.test.ts`, `storage.test.ts`, `importBoundary.test.ts`): rung order, first-settled-stops,
  GTIN gating, paid-rung-only cap charging, reason recording.
- Size-merge + brand families: `src/services/catalog/identityMerge`/`brandFamilies` tests prove
  size-distinct products mint (never collapse into review) and evidenced corporate families
  (Michelin/BFGoodrich/Uniroyal, Continental/General, Goodyear/Cooper) clear the prefix firewall while
  unrelated brands still conflict.
- UI proof baseline (owner-loved, 2026-07-10): 100 owner codes through the real preview UI on
  `inventory-5tk3c3vxf` = 100/100 verified / 0 review / 98s. Never regress this run.
- Test safety unchanged: automated tests NEVER call live providers (mock fetch / `page.route`;
  Playwright webServer runs `IS_E2E=1`). Live decode only via MANUAL_LIVE_TEST.md with owner approval.

## Unit test coverage (pure services + store)
- cleanScanCode / buildNormalizedCandidates (incl. `T432119%RU1%`, `2881-6861`, `28816861`)
- detectCodeType (UPC-A 12, EAN/GTIN-13, numeric/alpha SKU, messy)
- sanitizeForAiLookup (phone, email, names, COST/price/margin patterns)
- buildIdempotencyKey (stable, includes operation)
- matchAlias / matchProductByIdentifiers / resolveScanToProduct (priority + accurate matchType + conflict)
- incrementInventoryCount / applyScanEventOnce (dedupe by scanEventId)
- routeUnknownCode (creates Needs Review item)
- aiCircuitBreaker (closed -> open at cap -> half_open -> closed)
- csvExport (escaping, BOM, injection guard, grouped-by-product)
- scanStore optimistic update + persist shape
- decode firewall: isUsableProductName / cleanProductName reject site/aggregator/nav titles + AI hedges,
  strip "— UPC/EAN <code> — Go-UPC" and "| EAN-Search" style cruft, keep real names (decode.test.ts)
- decodeBudget: clampDecodeBudgetMs clamps client budget to [5000, 20000], falls back to default
- liveDecode sends the configured budgetMs in the decode request (autoDecode.test.ts)
- junkCleanup.findJunkCounts: flags junk-named/orphan counts, never a product with a surviving good count
- cleanupJunkCounts/undoCleanup: removes only junk, additive Undo preserves post-cleanup scans, no-op when
  clean, idempotent; applyCleanupSelections removes only selected ids (cleanupJunk.test.ts)
- catalog: sanitizeCatalogEntry drops private fields + restricts URLs; isCatalogWritable rejects junk
  (sanitizeCatalog.test.ts); decideLookup precedence override>verified-catalog>weak>none; upsertVerified
  strengthens; applyAiCandidate NEVER overwrites a verified entry; observeScan bumps usage (localCatalogProvider.test.ts)
- catalog-first store: verified hit resolves with NO fetch/AI; override wins over catalog; miss -> AI; AI auto-add
  writes a pending catalog entry; human approval writes a verified entry + feedback (catalogFirst.test.ts)
- feedback: appendFeedback ring-buffer caps + ordering (feedback.test.ts)
- cleanup recommendations: per-reason classification, grouping, high=checked / weak=unchecked defaults,
  orphan + conflict detection, removesProduct/aliasIds safety (recommendations.test.ts)

NOTE: always run vitest/tsc/eslint with an explicit `cd` into the inventory dir. A bare `vitest run` from the
parent directory matches hundreds of unrelated test files (false green).

## E2E coverage additions
- cleanup.spec.ts (rewritten): decode budget persists across reload; cleanup review is a safe no-op when clean;
  recommendation-first flow (review grouped recs -> backup downloads -> remove selected -> Undo restores).
- auto-verify.spec.ts: strong evidence-backed scan auto-verifies + counts (no review); exactly ONE decode call;
  second scan of the same barcode makes ZERO AI calls; weak/no-evidence scan -> Needs Review.

## Auto-verify unit coverage
- sourceTrust: tier classification (registry/retailer/barcode-db/unknown) + junk-page (search/cart/login/category)
  blocking + bestTier (sourceTrust.test.ts)
- evidenceScoring: additive/subtractive table, caps (AI-only<=60, Tier3<=79, Tier4<=50), thresholds, conflict/unsafe
  gates before threshold, trusted-source-off teeth, learning-off auto_count (evidenceScoring.test.ts)
- catalogAutoVerify.planAutoVerify: strong->auto_verify, AI-only->review, verified-conflict->review, junk source,
  vendor code (catalogAutoVerify.test.ts)
- store auto-verify: strong auto-verifies+counts no approval; NO extra network (exactly one decode call); 2nd scan
  no AI; weak->review; lowered threshold can't bypass; verified entry resolves without AI (autoVerify.store.test.ts)

NOTE: the blanket auto-add policy changed to confidence-gated auto-verify; suggested-without-exact-evidence now goes
to Needs Review (updated autoDecode.test.ts, scanStore.test.ts, catalogFirst.test.ts, auto-decode.spec.ts).

## Hotfix coverage (verified-decode fast path)
- evidenceScoring: app-verified strong evidence bypasses the Tier-3 single-provider cap (>=80) and auto-verifies;
  fast path still respects conflict; exact-evidence-without-usable-name returns the explicit reason (evidenceScoring.test.ts)
- store REGRESSION: a single-provider Tier-3 app-verified decode auto-saves + counts (not "Verified + Unknown"),
  feed decodeStatus ends "verified" (autoVerify.store.test.ts)
- E2E verified-decode-not-unknown.spec.ts: codes 7705471100046 / 816218028015 (single-provider Tier-3, app-confirmed)
  show the product + count, catalog learns them, 2nd scan makes no AI call; a no-usable-name case -> Needs Review with
  the explicit reason. Screenshot e2e/proof/verified-decode-not-unknown.png.

## E2E coverage (Playwright, mocked via IS_E2E=1)
- scan flow, scanner focus, resolver trust, image hover, pending sync/retry (existing specs)
- cleanup.spec.ts: decode-budget setting persists across reload; junk cleanup no-op when clean; seeded
  junk row is backed up (JSON download) + removed (good row kept) + restored via Undo. The junk-present
  case seeds a v3 localStorage blob so the persist migrate (which clears finalCounts) is skipped.
- pendingSyncQueue + retrySync + retrySyncDoesNotDoubleCount (run retry repeatedly = safe)
- humanResolutionSavesAlias + resolveAliasSyncIsIdempotent

## E2E proof (Playwright -> e2e/proof/*.png)
1. Login / local access screen
2. Scan screen before scanning
3. Live scan feed after the test sequence
4. Final count table grouped by product
5. Needs Review with UNKNOWN123
6. Image hover preview / modal
7. CSV export works (download triggered / file artifact)
8. Pending sync warning + pending count
9. Retry sync action present and safe (no double count)

## Acceptance scan sequence
Scan, in order:
`6419440485331, T432119%RU1%, T432119, 848983012906, 2881-6861, 28816861, 049000028904, 7262, UNKNOWN123`

Expected:
- Nokian Outpost APT quantity = 3
- Falken Sincera ST80 quantity = 3
- Coca-Cola 12 pack quantity = 2
- UNKNOWN123 appears in Needs Review (not counted)
- Raw scan feed contains all 9 events
- Final count table groups by product, not by code
- CSV export contains grouped final quantities + sync_status + scan_event_ids
- AI is NOT called for any of the known codes
- Rapid scanner-style input is not truncated; focused dedicated input captures full codes
- Unrelated form fields are not hijacked by the scanner buffer
- Failed sync keeps scans visible as syncStatus "pending"; Retry sync attempts re-sync
- Re-running Retry sync multiple times never double counts

## Resolver accuracy regression (hotfix)
Unit (`src/services/resolver.test.ts`, `codeTypeDetector.test.ts`, `scanStore.test.ts`):
- 855724007602 / 078742051451 never resolve to a wrong product -> Needs Review.
- 855724007602 resolves to a product ONLY if a verified seed/manual record carries that code.
- X004DY7YUT classified as `vendor_label`; routes to Needs Review with no approved alias.
- Vendor label resolves to Known once a human-approved alias links it.
- Unapproved alias / unverified product identifier never yield Known.
- AI suggestion never creates a product/alias/count; review stays open; only human approval saves.
- Conflict (one code -> two verified products) routes to Needs Review.

E2E (`e2e/resolver.spec.ts` -> e2e/proof/resolver-*.png):
- Clear cache -> scan the 3 bad codes -> none counted, page never shows Laird/Leviton, all 3 in
  Needs Review (X004DY7YUT labeled a vendor label) -> approve one -> re-scan is deterministic Known
  -> AI never called. Screenshots resolver-01..04.

Run: `npm run test` (94 unit) and `npm run test:e2e` (2 specs: resolver + full-flow).

## Evidence verification + cross-check (live decode) - ALL MOCKED, no live tokens
Unit (`src/services/ai/evidenceVerifier.test.ts`, `crossCheckEngine.test.ts`, `decode.test.ts`,
`scanStore.test.ts`):
- Model self-claim exactCodeEvidence with no real match -> NOT verified.
- Exact code in snippet/grounding/fetched -> verified with that strength; numeric codes match across
  spaces/hyphens; url-only is weak unless trusted host.
- Cross-check: agreement / brand conflict / barcode conflict / single_provider / weak.
- decideDecode: verified only (public barcode + strong evidence + agreement/single + threshold +
  identity); vendor label never verified; below threshold/empty identity not verified.
- liveDecode (mocked fetch): verified decode auto-saves per `autoAddDecodedProducts` (default true);
  agreement w/o app-verified evidence stays Suggested; re-scan of an approved alias calls fetch zero
  times.

E2E (`e2e/decode.spec.ts` -> e2e/proof/decode-*.png), provider responses mocked via `page.route`,
webServer `IS_E2E=1`:
- verified / suggested / conflict / vendor-label statuses shown; verified stays in review (default);
  human approves -> verified product + approved alias; re-scan is deterministic Known with zero AI hits.

Test-safety guarantees: no live Gemini/OpenAI during `npm run test` or `npm run test:e2e`.
Live providers run only in manual/dev use with a key present (the route still mocks under IS_E2E=1).

## Manual verification (if Playwright browsers cannot install)
1. `npm run dev` and open the scan screen.
2. Click the scan input, type each code above + Enter.
3. Confirm the three grouped quantities and UNKNOWN123 in Needs Review.
4. Resolve UNKNOWN123 to a product; re-scan it and confirm it now matches deterministically.
5. Toggle "simulate sync failure" in settings/mock; confirm pending count + Retry; click Retry twice; confirm no double count.
6. Export CSV; confirm grouped counts and sync columns.

## Hotfix: decode diagnostics + open-web source discovery (2026-06-14)

Unit (Vitest, all mocked - no live providers, no Firecrawl credits):
- `decodeOrchestrator.test.ts` (+3): a 429 -> `rate_limited`, a timeout -> `timeout`, success -> `ok`
  (proves provider errors are captured, not swallowed).
- `urlSafety.test.ts` (NEW): SSRF guard blocks loopback/127.0.0.1/::1/private/link-local/CGNAT/
  169.254.169.254 metadata/`file://`/non-http(s)/bare-host/`.local`; allows real public product URLs.
- `firecrawlProvider.test.ts` (NEW, Firecrawl REST mocked): finds the product when Faire is NOT result
  #1 (scrapes down the list until the exact code appears); `no_match` when no page has the code; a 429
  search -> `rate_limited` (not a fake not-found); never scrapes an unsafe candidate (SSRF).
- `pageFetch.test.ts` (+): reads AI-cited `extraUrls` (Faire-type), not just the hardcoded DBs; ignores
  a "Product Not Found" page that echoes the code and uses a sibling site with the real product; returns
  NO product when every page only echoes the code in a not-found error.
- `decodeFallback.test.ts` (NEW): `shouldRunFallback` is false on success/timeout/conflict/E2E and true
  only on a real Stage-1 miss; `decodeReasonCode` maps to honest codes (rate-limited/timeout/error/
  not-found-after-search/search-unavailable/fallback-found).

E2E (`e2e/decode-diagnostics-open-web-fallback.spec.ts` -> `e2e/proof/decode-diagnostics-open-web-fallback.png`),
provider + Firecrawl fully mocked via `page.route`, webServer `IS_E2E=1`:
1. **Fast path** - strong product shows + counts in exactly ONE POST (no extra fallback round-trips).
2. **Faire-type open-web fallback** - `810118139604` resolves to "Acrylic Paint Markers Set, 24 Metallic
   Colors" and counts; no generic message.
3. **Provider rate-limit** - Needs Review shows an HONEST "rate-limited" reason, never "No provider
   returned a usable product".
4. **Truly unlisted** - Needs Review shows "no product matched" only after a search was attempted.

Test-safety: `FIRECRAWL_API_KEY` is never read in tests; Firecrawl `FcFetch` is injected/mocked; no live
Gemini/OpenAI/Firecrawl during `npm run test` or `npm run test:e2e`.

Full gate run (2026-06-14, C:\Users\djsan\inventory): vitest 274/274, tsc clean, eslint clean,
next build success, playwright 10/10.

## Hotfix pt.2: deep + parallel fallback (2026-06-14)

Unit (all mocked):
- `fallbackRunner.test.ts` (NEW): finders run CONCURRENTLY (max-in-flight == N, not 1); the first usable
  hit wins and the losers are ABORTED; null-returning finders are ignored; all-miss -> null; a hard cap
  stops an unbounded finder; a throwing finder never rejects the race.
- `decodeCache.test.ts` (NEW): compute runs once then the cache serves repeats (no repeat spend); a
  FAILURE is not cached (stays retryable); per-code keys independent; key trimming; empty code ignored.
- `firecrawlProvider.test.ts` (+): finds a listing at rank #4 (old code only scraped top 3); parallel
  resilience (an earlier scrape failing still recovers the match); `coverageMissed` true when more safe
  results existed than maxScrape and none matched, false when all were opened; `urlPreferenceScore`
  prefers product/listing URLs over search/cart/login; a product page is opened before a search page.
- `decodeFallback.test.ts` (+): `fallback_coverage_missed`; rate-limit still wins over a coverage gap.

Full gate run (2026-06-14): vitest 291/291, tsc clean, eslint clean, next build success, playwright 10/10.

LIVE (owner-authorized, 1 paid + 1 cached): 810118139604 -> verified product in 16s; repeat call 7ms
cached, zero spend. See LIVE_FALLBACK_PROOF.md.

## Phase 1: benchmark harness (2026-06-14)

Unit (`src/services/benchmark/benchmarkAnalysis.test.ts`, 22 tests, all pure/mocked): CSV parse w/
quoted commas; path classifier (cache/fast_page_fetch/gemini_flash/firecrawl_fallback/ai_deep_fallback/
needs_review/failed); honest accuracy (pass/partial/fail/needs_manual_review, never "correct" without
ground truth, cached distinct); latency p50/p95/min/max; Firecrawl credit estimate (reported vs 1+candidates
vs skipped=0); isUsableName junk rejection; summarize counts.

Runner: `npm run benchmark` (hits real `/api/ai-lookup`; 400-credit hard stop; cache double-run proof;
outputs to benchmarks/results/). Live harness-validation (4 real codes): fast 85-101ms, fallback 14.3s,
not-found 40s, cache 3/3 confirmed.

E2E `e2e/phase1-benchmark.spec.ts`: representative UI proof (mocked) - fast products show + count,
fallback product shows, a verified code re-scans from the client catalog with NO new API POST (cache),
needs-review shows honest reason, not-found shows product_not_found_after_search. Screenshot saved.

Gate run (2026-06-14): vitest 313/313, tsc clean, eslint clean, next build success, playwright 11/11.

## Launch MVP Phase 1: Supabase foundation (2026-06-14) - ARCHIVED

> ⚠ review: the Supabase foundation was replaced by Firebase and archived to
> `archive/supabase-foundation/`. The integration test files below no longer exist in `src/`;
> this section is kept as the historical record of that proof run.

Unit (run in `npm test`, no Docker needed):
- `src/services/auth/authBypass.test.ts`: the E2E auth bypass is FALSE in production even with all flags
  set; TRUE only under test+IS_E2E=1 (or dev + explicit public flag).
- `src/services/keySafety.test.ts` (extended): client dirs (incl. src/lib) never reference the
  service-role key / @/lib/supabaseServer / getSupabaseServiceClient; server-only files are exempt.

Integration (SKIP unless the local Supabase env is set; run with the SUPABASE_* env):
- `src/services/db/tenantIsolation.integration.test.ts` (6 tests) - the RLS negative proof via
  AUTHENTICATED user clients (service role only for user setup/cleanup):
  (a) User A reads/writes Business A; (b) User B cannot READ A's rows; (c) User B cannot INSERT a forged
  business_id=A (WITH CHECK rejects); (d) cannot UPDATE A's rows; (e) cannot DELETE A's rows;
  plus create_business makes the creator an admin member.
- `src/services/db/repositories.integration.test.ts` - typed repo round-trip (product upsert/list/
  find-by-barcode, alias upsert/approve) as an authenticated user.

Run the proof:
  SUPABASE_URL=http://127.0.0.1:55321 SUPABASE_ANON_KEY=<anon> SUPABASE_SERVICE_ROLE_KEY=<service> \
    npx vitest run src/services/db/tenantIsolation.integration.test.ts src/services/db/repositories.integration.test.ts

Gate run (2026-06-14): supabase start OK; db reset OK; isolation 6/6 + repo 1/1 (live local);
vitest 318 passed / 7 skipped; tsc clean; eslint clean; next build OK; playwright 11/11.

## Backend pivot: Firebase foundation (2026-06-14)
- `npm run test:firebase` -> `firebase emulators:exec --only firestore "vitest run src/services/db/firebase"`.
  Emulator tests SKIP under plain `npx vitest run` (gated on FIRESTORE_EMULATOR_HOST), so the normal gate
  stays green without Java/emulator.
- `src/services/db/firebase/tenantIsolation.rules.test.ts` (9) - RLS via AUTHENTICATED users under the
  real firestore.rules (service role only seeds): A reads(get+list)/writes A; B cannot read/insert/update/
  delete A; audit append-only; catalog client-read-only; userProfiles self-only.
- `src/services/db/firebase/repositories.rules.test.ts` (1) - typed repo CRUD as an authenticated member.
- `keySafety.test.ts` extended for Firebase Admin (no service-account/Admin in client). authBypass test
  unchanged (production-off proof).
- Gate run (2026-06-14): emulator 10/10; vitest 318 passed/10 skipped; tsc clean; eslint clean; next build
  OK; playwright 11/11.

## Pay-once durability: decode-cache backup/restore (Task 20, 2026-07-15)

A Turso (or local file store) `decode_cache` wipe would force re-paying every un-approved paid decode
all over again - the archive keeps raw provider data but is not a lookup rung, and corpus write-back of
AI guesses is out of scope by design (trust firewall: the corpus is ground truth, machine guesses must
never become indistinguishable from it). The fix is a faithful dump/restore of the cache itself.

- `src/server/decodeCacheBackup.ts` (pure, no I/O): `exportDecodeCache(rows)` serializes
  `PersistedDecode[]` to JSON Lines (one JSON object per line); `parseBackup(jsonl)` parses it back with
  per-line JSON.parse + shape validation - a corrupt or wrong-shape line is SKIPPED, never thrown, so
  valid neighbor lines still survive. Unit tests (`decodeCacheBackup.test.ts`, 7 cases): round-trip
  deep-equal, one-JSON-object-per-line, empty input, corrupt-JSON-line resilience, wrong-shape-line
  resilience (empty code / bad kind / non-string payload or tier / non-number createdAt / missing field /
  non-object JSON), embedded-newline-in-payload round-trip (JSON string escaping, not a literal line
  break), and trailing blank lines at EOF.
- `scripts/decode-cache-backup.mjs` (thin CLI, pure Node, `@libsql/client` imported only when
  `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are set):
  - `node scripts/decode-cache-backup.mjs --dump` reads every row from Turso `decode_cache` (when
    configured) or the local file store (`DECODE_CACHE_FILE` / `.decode-cache.json`), and writes
    `backups/decode-cache-<YYYY-MM-DD>.jsonl`. `backups/` is gitignored (local ops artifact, contains
    paid-decode payloads - never source).
  - `node scripts/decode-cache-backup.mjs --restore <file>` reads the JSONL and upserts rows back:
    Turso via `INSERT OR IGNORE` (checked per-row so an existing code is never overwritten), file store
    via only-add-missing-keys. **Existing rows always win** - a restore can never overwrite a newer
    decode. Prints parsed/inserted/skipped counts.
  - Sunday cron note: `scripts/decode-cache-backup.mjs --dump` may run right after the DT-harvest job
    (see Task 18's Windows Task Scheduler entry) so a fresh backup always exists before the next wipe
    risk window.
- Smoke test (local file store only, no Turso needed - see the Task 20 report for the exact transcript):
  seed a temp `DECODE_CACHE_FILE` with 2 fake rows -> `--dump` -> delete one row from the temp file ->
  `--restore` the dump -> both rows present again, and the surviving (never-deleted) row's payload and
  `createdAt` are byte-identical to before the restore (proves existing rows are never touched, only
  gaps are filled).
- Gate run (2026-07-15, Task 20 only): `npx vitest run src/server/decodeCacheBackup.test.ts` 7/7 passed;
  `npx tsc --noEmit` clean; CLI smoke exit 0.
