# Code Review: bug-03-refresh-wipes-tenant-state

## Overview
Review of `setBusinessContext` in `src/stores/scanStore.ts` and its interaction with `BusinessContextGate.tsx`. `setBusinessContext` is invoked on every page mount and refresh when resolving the active user and business context.

---

## Defect 1: Unconditional Wiping of Non-Cloud Tenant State (`scanFeed`, `settings`, `needsReviewQueue`) on Page Refresh

### Concrete Failure Scenario
1. A user scans items in their session. `scanFeed`, `needsReviewQueue`, and `settings` are saved in local storage under the user's key (rehydrated via `rehydrateForUid`).
2. The user refreshes the page.
3. `BusinessContextGate` runs `rehydrateForUid(user.uid)`, restoring local storage state into `useScanStore`.
4. Immediately following rehydration, `BusinessContextGate` calls `setBusinessContext(membership.businessId, user.uid)`.
5. `setBusinessContext` unconditionally executes:
```ts
const cleared = emptyTenantState();
set({
  ...
  scanFeed: cleared.scanFeed,
  finalCounts: cleared.finalCounts,
  needsReviewQueue: cleared.needsReviewQueue,
  settings: cleared.settings,
  firstScanAt: cleared.firstScanAt,
  recentLocations: cleared.recentLocations,
});
```
6. `loadBusinessData` fetches `products`, `aliases`, `sessions`, and `counts` from the cloud backend, but as documented on lines 12–14, `scanFeed`, `needsReviewQueue`, and `settings` are NOT returned by `loadBusinessData`.

Result: Every browser refresh or page mount permanently wipes the user's rehydrated `scanFeed`, `needsReviewQueue`, `settings`, `firstScanAt`, and `recentLocations` back to empty defaults.

### Root Cause
`setBusinessContext` assumes every invocation is a tenant context switch and synchronously clears local-only state fields (`scanFeed`, `settings`, `needsReviewQueue`) without checking if `businessId` is already active or preserving local rehydrated data.

---

## Defect 2: Transient Empty State & UI Flicker During Unawaited Cloud Load

### Concrete Failure Scenario
When `setBusinessContext` is called, it synchronously sets store fields to empty values (`products`, `finalCounts`, etc.) and marks `businessDataLoaded: false`. It then launches an un-awaited asynchronous IIFE (`void (async () => { await loader(...) })()`).

While `loader` is fetching data over the network:
1. Any React component mounted during this window reads `useScanStore` and receives empty arrays (`products: []`, `finalCounts: []`).
2. The UI renders blank/empty screens or resets UI state transiently until the network request completes.

### Root Cause
Store state is cleared synchronously prior to initiating an un-awaited asynchronous cloud fetch operation, creating an exposed period of blank state in the UI.

---

## Defect 3: Session State Destruction when No Cloud Session Exists (`restored === null`)

### Concrete Failure Scenario
If `loadBusinessData` returns an empty array for `data.sessions`, `restored` evaluates to `null`. 

Lines 44–48 execute:
```ts
const next: Partial<ScanState> = { products: data.products, aliases: data.aliases };
if (restored) {
  next.currentSession = restored;
  next.sessionId = restored.id;
  next.finalCounts = data.counts.filter((c) => c.sessionId === restored.id);
}
next.businessDataLoaded = true;
set(next);
```
Because `restored` is `null`, `next.finalCounts` is not assigned. However, `finalCounts` was already set to `cleared.finalCounts` (`[]`) synchronously in step 1. Any pre-existing local session counts are permanently erased, leaving the store with no active session or counts.

### Root Cause
Line 23 wipes `finalCounts` synchronously, and lines 44–48 only restore `finalCounts` if a cloud session is present, failing to handle or preserve local session counts when `restored` is null.
