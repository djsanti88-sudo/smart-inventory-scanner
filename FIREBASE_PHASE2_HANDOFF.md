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
| 6 | Audit writes (fire-and-forget injectable `audit()` -> append-only `auditLog`; wired to session start/finish, unknown-review create, alias approve/reject, product create; never blocks/breaks the scanner) | _this pass_ | emulator + store |

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
- **Loop 5 - CSV MVP.** Import: products + approved aliases into Firestore (dup/conflict validation),
  audit. Export: completed session -> full-count + quantity-adjustment CSV (reuse `csvExport.ts`), audit.
  ImportJob/ExportJob tracking: defer (document).
- **Loop 7 - Firebase Playwright.** New `e2e/firebase-phase2/` running the app with
  `NEXT_PUBLIC_FIREBASE_BACKEND=1` against the emulator (separate Playwright project/webserver +
  emulator running + a seeded user/business). Flow: create business -> session -> scan known/alias/
  unknown -> approve -> rescan resolves -> retry no double count -> refresh persists -> finish -> export
  -> audit. Screenshots -> `e2e/proof/firebase-phase2/`. Largest/most orchestration-heavy.

## Cloud Loop 8 (blocked)
Need owner's 6 `NEXT_PUBLIC_FIREBASE_*` values (+ Firestore & Email/Password enabled in
`smart-inventory-scanner`). Then: write to `.env.local` only, deploy rules/indexes, run real-user cloud
auth/rules/isolation smoke, report separately. No fake cloud proof; nothing deployed yet.

## EXACT NEXT ORDER (resume here, fresh focused pass)
1. ~~**Loop 3** - session/count persistence and survive-refresh.~~ DONE (this pass).
2. ~~**Loop 6** - audit writes.~~ DONE (this pass).
3. **Loop 5** - CSV import/export MVP. (NEXT)
4. **Loop 7** - Firebase-backed Playwright proof.
5. **Loop 8** - cloud auth/rules/isolation smoke (only AFTER the owner provides the Web App config).

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
