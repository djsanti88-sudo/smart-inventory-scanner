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

Gates at `4131702`: `test:firebase` 20/20 · `vitest` 323 passed/20 skipped · `tsc` clean · `eslint` clean ·
`next build` OK · `playwright` 11/11 (mock e2e intact).

## Key seam (reuse it)
- Durable writes funnel through `appDeps.db.apply(item)` (`SyncTarget`). MockDb (sync) + `FirebaseSyncTarget`
  (async, transactional) both satisfy it. Mock path is byte-for-byte unchanged.
- `ScanStoreDeps`: `cloudBackend` + injectable `loadBusinessData` (cloud only). `createTestScanStore`
  threads both for tests.
- Business-scoped Firestore subcollections `/businesses/{businessId}/...`; idempotency ledger
  `/_appliedKeys/{key}` written inside the apply() transaction.
- Firestore↔store mappers live in `businessDataLoader.ts` (`toStoreProduct`, `toStoreAlias`).

## Remaining (emulator-side)
- **Loop 3 - count session persistence + survive-refresh.** Foundation ready: extend `loadBusinessData`
  to also read `countSessions` + `inventoryCounts` and reconstruct `finalCounts`; add session-write
  (a `persistSession` injectable -> `countSessionsRepository`, or a `SAVE_SESSION` sync op) in
  `startSession`; add a `finishSession()` action (set `completedAt`/`status=completed`); `setBusinessContext`
  restores `currentSession` + `finalCounts`. Map Firestore `inventoryCounts` {countSessionId, productId,
  countedQuantity, scanEventIds} -> store `InventoryCount` {sessionId, productId, quantity, scanEventIds}.
- **Loop 6 - audit.** Injectable `audit(event)` (cloud -> `auditRepository.append`, fire-and-forget, never
  blocks the scanner) wired on session start/finish, alias approve/reject, scan/unknown create, CSV
  import/export. Emulator test for append-only + business scope.
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

## Guardrails held
Scanner UX/optimistic feedback/focus/keyboard-wedge preserved; decode/cache/Firecrawl untouched; no
double count; no writes without real businessId+userId; reset guarded; no secrets; `.env.local`
git-ignored; Supabase out of runtime; tire scrape / 100-code benchmark / public deploy not started.
