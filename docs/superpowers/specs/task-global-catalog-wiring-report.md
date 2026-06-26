# Task Report: Global Catalog Scan Wiring (Option 1)

Date: 2026-06-25
Status: COMPLETE

## Files Changed

- `src/stores/scanStore.ts` — 5 surgical additions:
  1. Added `CatalogHit` to existing `CatalogEntry, ShopOverride` import from `catalogTypes`.
  2. Added `sanitizeCatalogEntry` to existing `isCatalogWritable` import from `sanitizeCatalog`.
  3. Added `catalogRepository` to existing `auditRepository` import from `repositories`.
  4. Added `lookupGlobalCatalog?: (codes: string[]) => Promise<CatalogEntry | null>` to `ScanStoreDeps` interface.
  5. Added `cloudCatalogResolve: (reviewId: string, codes: string[]) => Promise<void>` to `ScanState` interface.
  6. Implemented `cloudCatalogResolve` action (inserted before `liveDecode`): awaits `deps.lookupGlobalCatalog`, guards on resolved review after async round-trip, builds `CatalogHit` and runs `detectIdentityContextConflict` firewall, merges verified entry into in-memory `catalog`, records `found_from_catalog` feedback, calls `resolveUnknown` with `origin:"catalog"`, falls through to AI on miss/firewall-conflict.
  7. Modified `processScan` catalog miss branch: replaced `if (autoGate.allowed) void get().liveDecode(review.id)` with cloud-first check when `deps.lookupGlobalCatalog && get().online`.
  8. Added `lookupGlobalCatalog` to `appDeps` (Firebase branch only): iterates candidate codes via `catalogRepository(getDb()).getByBarcode`, returns first verified hit via `sanitizeCatalogEntry` mapping, else first any, else null.
  9. Added `lookupGlobalCatalog: overrides?.lookupGlobalCatalog` passthrough to `createTestScanStore`.

- `src/stores/catalogFirst.test.ts` — added 6 new tests in a new `describe` block.

## Test Counts

| | Count |
|---|---|
| Before | 715 passed, 0 failed |
| After | 721 passed, 0 failed |
| New tests added | 6 |
| Regressions | 0 |

## New Tests

1. cloud verified hit (in-memory empty) resolves + counts "found_from_catalog" with NO AI fetch
2. cloud miss (returns null) -> AI path runs
3. cloud hit whose identity conflicts with tire scanContext -> firewall routes to Needs Review, NOT auto-counted
4. shop-owned approved alias still counts into the shop's product (cloud lookup NOT consulted)
5. offline -> cloud lookup skipped -> AI / Needs-Review path
6. in-memory verified hit still resolves WITHOUT calling lookupGlobalCatalog (no regression)

## Gate Results

- `npm run test -- --run`: 721 passed, 0 failed (98 files passed, 7 skipped)
- `npx tsc --noEmit`: exit 0, no errors
- `npm run lint`: 31 problems (20 errors, 11 warnings) — identical to baseline; zero new issues introduced

## How `lookupGlobalCatalog` Obtains the Firestore Handle

Uses `getDb()` at call time (imported from `@/lib/firebaseClient`) — the same lazy pattern used by `audit` and `loadBusinessData` in `appDeps`. Calls `catalogRepository(getDb()).getByBarcode(code)` for each candidate code. The `catalogRepository` function in `repositories.ts` accepts a `Firestore` instance directly. The raw Firestore document (db/types `CatalogEntry` minimal shape) is mapped to the full `catalogTypes.CatalogEntry` shape via `sanitizeCatalogEntry` before being returned to the store.

## Concerns

None blocking.

- The in-memory catalog hit path is completely untouched (the existing `decideLookup` check runs first and returns early, so `cloudCatalogResolve` is never reached when an in-memory hit exists - confirmed by regression test 6).
- The cloud lookup only fires for the miss branch, so shop-owned products (deterministic resolver, step 1) are unaffected.
- `lookupGlobalCatalog` is `undefined` by default in test/mock path, so the existing AI fallback is unchanged for all existing tests.
- The Firestore `CatalogEntry` (db/types shape, minimal optional fields) is mapped through `sanitizeCatalogEntry` before use in the store, ensuring all required fields are present with safe defaults.
