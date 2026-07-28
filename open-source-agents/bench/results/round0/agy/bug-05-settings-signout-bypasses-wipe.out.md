# Code Review: bug-05-settings-signout-bypasses-wipe

## Overview
Review of sign-out implementations in `src/components/Nav.tsx` and `src/app/(app)/settings/page.tsx`.

---

## Defect 1: Bypass of In-Memory and LocalStorage Tenant Data Wipe (`resetForSignOut`)

### Concrete Failure Scenario
User A signs out using the "Sign out" button on the Settings page (`settings/page.tsx`). 

Line 63 executes:
```tsx
onClick={() => void signOut()}
```
`signOut()` terminates the auth session, but `useScanStore.getState().resetForSignOut()` is NEVER called. 

Consequently:
1. `useScanStore` retains User A's active tenant state in memory (`products`, `aliases`, `finalCounts`, `scanFeed`, `needsReviewQueue`).
2. Local storage retains User A's persisted tenant data.
3. If User B signs in on the same browser device (or if another user opens the app), User B inherits User A's sensitive inventory data, scan feed, products, and counts.

### Root Cause
`settings/page.tsx` invokes `signOut()` directly without calling `useScanStore.getState().resetForSignOut()`, bypassing tenant data purging.

---

## Defect 2: Silent Unsynced Data Loss (Bypass of `prepareSignOut` and Loss Warnings)

### Concrete Failure Scenario
A user performs offline inventory scans that are queued in `pendingSyncQueue`. The user opens the Settings page and clicks "Sign out".

Unlike `Nav.tsx`, `settings/page.tsx` does NOT call `prepareSignOut()` to attempt draining the sync queue or prompt the user if unsynced items remain (`left > 0`). The auth session is terminated immediately, silently abandoning the queued scan events and causing permanent data loss without warning.

### Root Cause
`settings/page.tsx` omits the pre-sign-out drain and warning workflow (`prepareSignOut()`) that is implemented in `Nav.tsx`.

---

## Defect 3: Missing Post-Signout Navigation

### Concrete Failure Scenario
When a user clicks "Sign out" in `settings/page.tsx`, `signOut()` revokes the user's authentication credentials. However, no navigation action (e.g., `router.replace("/login")`) is executed. The browser application remains stuck on the protected `/settings` page view in an inconsistent state until the user manually refreshes or navigates away.

### Root Cause
`settings/page.tsx` fails to call `router.replace("/login")` following `signOut()`.
