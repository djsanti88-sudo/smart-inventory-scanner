# Firebase Phase 2 - Handoff

Branch: `firebase-cloud-phase2` (off `master`). Emulator-side build; cloud Loop 8 blocked on owner's
6 `NEXT_PUBLIC_FIREBASE_*` Web App config values.

## Done & proven (committed)
| Loop | What | Commit | Proof |
|------|------|--------|-------|
| 1 | Transaction-safe `FirebaseSyncTarget` (no double count on concurrent retry; guarded `reset()`) | `eb2bcdf` | emulator |
| 2 | scanStore backend toggle (`NEXT_PUBLIC_FIREBASE_BACKEND`) + async drain + business-context guard + `setBusinessContext` | `6192e4b` | store + gates |
| 4a | `SAVE_PRODUCT` op (products persist to Firestore, idempotent) | `9db142b` | emulator |
| 4b | `businessDataLoader` + `setBusinessContext` loads products/aliases (alias resolves after refresh) | `4131702` | emulator + store |
| 3 | Session/count persistence + survive-refresh (`SAVE_SESSION` op + explicit MockDb handling, `finishSession`, reverse mappers, `loadBusinessData` reads sessions+counts, `setBusinessContext` reconstructs active session + finalCounts) | `c5e61bd` | emulator + store |
| 6 | Audit writes (fire-and-forget injectable `audit()` -> append-only `auditLog`; wired to session start/finish, unknown-review create, alias approve/reject, product create; never blocks/breaks the scanner) | `8f86f80` | emulator + store |
| 5 | CSV import/export MVP (`csvImport.ts`: parse + products/approved-aliases with dup/conflict detection; `exportQuantityAdjustments`; `importProductsCsv` writes via SAVE_PRODUCT/RESOLVE_ALIAS + audit; export audited; import/export UI) | `3485b92` | emulator + store + unit |
| 7 | Real business-context UI wiring (`BusinessContextGate` + Select/Finish buttons + `selectedBusiness`) + Firebase-backed Playwright proof (real Auth-emulator sign-in, separate config, survive-refresh, Admin-SDK assertions). Fixed a real cloud-sync data-loss race (drain clobbered concurrently-enqueued items) + serialized drains. | _this pass_ | Firebase Playwright + emulator + store |

Gates at `4131702`: `test:firebase` 20/20 · `vitest` 323 passed/20 skipped · `tsc` clean · `eslint` clean ·
`next build` OK · `playwright` 11/11 (mock e2e intact).
Gates after Loop 3: `test:firebase` 24/24 · `vitest` 328 passed/24 skipped · `tsc` clean · `eslint` 0 errors.

## Key seam (reuse it)
- Durable writes funnel through `appDeps.db.apply(item)` (`SyncTarget`). MockDb (sync) + `FirebaseSyncTarget`
  (async, transactional) both satisfy it. Mock path is byte-for-byte unchanged.
- `ScanStoreDeps`: `cloudBackend` + injectable `loadBusinessData` (cloud only). `createTestScanStore`
  threads both for tests.
- Business-scoped Firestore subcollections `/businesses/{businessId}/...`; idempotency ledger
  `/_appliedKeys/{key}` written inside the apply() transaction.
- Firestore↔store mappers live in `businessDataLoader.ts` (`toStoreProduct`, `toStoreAlias`).

## Remaining (emulator-side)
- **Loop 3 - DONE (this pass).** `SAVE_SESSION` sync op added to the durable queue (transaction +
  `_appliedKeys` ledger, distinct active/completed keys); explicit deterministic `MockDb` handling
  (not a silent no-op); `finishSession()` action; reverse mappers `toStoreSession`/`toStoreCount`;
  `loadBusinessData` now reads `countSessions` + `inventoryCounts`; `setBusinessContext` reconstructs
  the active session (else most recent) + its `finalCounts`. Proven: emulator
  (`sessionPersistence.rules.test.ts`) + store (`sessionPersistence.store.test.ts`).
- **Loop 6 - DONE (this pass).** Injectable fire-and-forget `audit(event)` (`src/services/audit/audit.ts`
  + `auditRepository.append`) wired on session start/finish, unknown-review create, alias approve/reject,
  product create. Guarded: emits ONLY with a real business context (no fake businessId/actor); swallows
  errors so a failed audit never blocks/breaks the scanner. `toAuditEvent` omits undefined fields
  (Firestore rejects `undefined`). Per-known-scan audit intentionally DEFERRED (the scan is already the
  durable record via `SAVE_SCAN_EVENT`; a per-scan audit row would be redundant + high-volume). CSV
  import/export audit lands with Loop 5. Proven: emulator (`audit.rules.test.ts`: append-only,
  business-scoped, cross-business write denied, non-member read denied) + store (`auditWrites.store.test.ts`).
- **Loop 5 - DONE (this pass).** Import: `csvImport.ts` (pure RFC4180-ish `parseCsv` + `buildProductImport`)
  creates products + approved aliases from sku/barcode/gtin/upc/ean/vendor codes, with duplicate (skipped)
  and conflict (a code already mapped to a different product -> NOT applied) detection. `importProductsCsv`
  store action writes via the durable queue (`SAVE_PRODUCT` + `RESOLVE_ALIAS`) and audits (`csv_import`).
  Export: `exportQuantityAdjustments` (full-count export already existed); export UI audits (`csv_export`
  via `auditCsvExport`). Import/export UI in `ExportButtons.tsx`. Treats CSV as UNTRUSTED (semantic
  firewall). DEFERRED (documented): ImportJob/ExportJob tracking entities; quantity-adjustment has no
  prior "system quantity" baseline (counted qty == adjustment). Proven: `csvImport.test.ts`,
  `csvImport.store.test.ts`, `csvExport.test.ts` (qty-adjustment), emulator `csvImport.rules.test.ts`.
- **Loop 7 - DONE (this pass).** Real business-context UI wiring: `BusinessContextGate` (resolves the
  signed-in user + selected business, verifies a real membership, then calls `setBusinessContext`; shows
  a clear message + waits for `businessDataLoaded` before scanning) on `/scan` and `/review` (NOT
  `/business`, which would deadlock the selector); a Select button per membership (`selectedBusiness.ts`
  persists the choice); a Finish-session button. Firebase-backed Playwright at `e2e/firebase-phase2/`
  (`playwright.firebase.config.ts`, run via `npm run test:e2e:firebase` wrapping `firebase emulators:exec`
  on auth+firestore; `global-setup.ts` seeds a real Auth user + business + membership + known product/
  aliases via the Admin SDK). Flow: real login UI -> select business -> start session -> scan known +
  alias -> scan unknown -> approve (create product+alias) -> rescan resolves Known -> refresh reloads
  session/counts/products/aliases from Firestore -> finish -> export CSV; asserts persisted state directly
  against the emulator (counts, sessions, aliases, audit). Screenshots -> `e2e/proof/firebase-phase2/`.
  **Found + fixed a real cloud-sync data-loss bug:** `syncPendingCloud` overwrote the queue with its
  start-of-pass snapshot, clobbering items enqueued during the async apply loop (rapid scans were lost
  even though "pending" reached 0). Now: a promise-chain mutex serializes drains, and the write-back is
  id-based (drop applied, replace errored, keep newly-enqueued). Regression: `cloudDrainRace.store.test.ts`.

## Cloud Loop 8 - DONE (real cloud, proven)
Project `smart-inventory-scanner-app` (Blaze). Public Web App config written to `.env.local` ONLY
(git-ignored, untracked; existing AI/Supabase secrets preserved). Deployed Firestore rules + indexes
via `firebase deploy --only firestore:rules,firestore:indexes --project smart-inventory-scanner-app`.
Real Email/Password cloud smoke (`scripts/cloud-smoke.mjs`, `npm run test:firebase:cloud-smoke`,
per-actor isolated apps, self-cleaning): PASSED - A bootstraps business+owner, owner read/write,
tenant isolation (B denied read/list/write), **forge-membership DENIED**, counter can scan/count but
not manage products, viewer read-only, audit append-only. **Security fix shipped this loop:** the
membership bootstrap rule now ties self-owner creation to `businesses/{bid}.createdBy == uid`
(previously ANY signed-in user could self-grant owner of ANY business - a tenant-isolation breach).
Regression: `tenantIsolation.rules.test.ts` (b2). No service-account JSON; no public app deploy.
Residual clearly-named test data: append-only `auditLog` rows under `loop8-biz*` cannot be client-
deleted (by design) and a couple of orphaned `loop8-biz*` business docs from harness iteration remain -
harmless, optionally removable from the console.

## EXACT NEXT ORDER (resume here, fresh focused pass)
1. ~~**Loop 3** - session/count persistence and survive-refresh.~~ DONE (this pass).
2. ~~**Loop 6** - audit writes.~~ DONE (this pass).
3. ~~**Loop 5** - CSV import/export MVP.~~ DONE (this pass).
4. ~~**Loop 7** - Firebase-backed Playwright proof.~~ DONE (this pass).
5. **Loop 8** - cloud auth/rules/isolation smoke (only AFTER the owner provides the Web App config). STILL BLOCKED.

## Final gates (after Loop 7)
`test:firebase` 29/29 · `vitest` 346 passed/29 skipped · `tsc` clean · `eslint` 0 errors ·
`next build` OK · `playwright` (mock) 11/11 · `test:e2e:firebase` 1/1 (stable). Emulator only - no cloud.

## KNOWN BLOCKER
Waiting on the owner's 6 `NEXT_PUBLIC_FIREBASE_*` values (Firebase Web App config for
`smart-inventory-scanner`, with Cloud Firestore + Email/Password enabled). Loop 8 cannot start until then.

## NON-NEGOTIABLES (carry into every remaining loop)
- No double count (transaction + idempotency ledger; prove with concurrent retry).
- No fake/default businessId/userId - no Firebase write without a real business context.
- No destructive cloud reset (`reset()` throws against real cloud).
- No fake cloud proof (cloud only after real config; real Email/Password users).
- Scanner UX stays fast (optimistic local first; sync via the queue; never block the input).
- Decode / cache / Firecrawl behavior untouched.
- No 100-code benchmark.
- No tire database.
- No public app deploy.
- No secrets committed (`.env.local` git-ignored).

## Guardrails held (this pass)
Scanner UX/optimistic feedback/focus/keyboard-wedge preserved; decode/cache/Firecrawl untouched; no
double count; no writes without real businessId+userId; reset guarded; no secrets; `.env.local`
git-ignored; Supabase out of runtime; tire scrape / 100-code benchmark / public deploy not started.
