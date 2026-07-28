# Review: bug-03-refresh-wipes-tenant-state

## Defect 1 (Critical): `rehydrateForUid`'s persist rehydrate is unawaited and races the synchronous clear + async load in `setBusinessContext`

```ts
// BusinessContextGate effect:
useScanStore.getState().rehydrateForUid(user.uid);
setBusinessContext(membership.businessId, user.uid);
```

```ts
// rehydrateForUid:
persistApi.setOptions({ name: persistKeyForUid(uid) });
void persistApi.rehydrate();   // NOT awaited
```

`rehydrate()` is fire-and-forget (`void`). It reads the persisted blob for `persistKeyForUid(uid)` from localStorage and applies it to the Zustand store asynchronously, on its own timeline. Immediately after calling it, the gate calls `setBusinessContext`, which synchronously clears `scanFeed`/`finalCounts`/`needsReviewQueue`/`settings`/etc., then kicks off its own async `loader(businessId, userId)` and eventually calls `set(next)` with freshly loaded cloud data.

Because `rehydrate()` was never awaited, its completion time relative to `setBusinessContext`'s async loader is a race with no ordering guarantee:
- If `rehydrate()` resolves **after** `loader`'s `set(next)`, the persisted (possibly stale, possibly from a different uid's earlier session, or simply older) localStorage snapshot overwrites the freshly loaded cloud data — a refresh can silently revert correct freshly-loaded tenant data back to whatever was last persisted locally.
- If `rehydrate()` resolves **before** `loader` finishes but after the synchronous `cleared` state was set, its own stale payload briefly (or not so briefly, if `loader` fails) becomes the active state, potentially exposing rows keyed to a different session/tenant than the one just selected.

This is exactly the "refresh wipes/corrupts tenant state" scenario: on every mount/refresh (per the prompt, this runs on every mount, not just account switch), two independent state-mutating async operations touch the same store with no sequencing, so the final visible state after a refresh depends on network timing rather than being deterministic.

## Defect 2 (High): A refresh where no session qualifies as "restored" permanently drops `finalCounts` with no repair path in this code

```ts
const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
const next: Partial<ScanState> = { products: data.products, aliases: data.aliases };
if (restored) {
  next.currentSession = restored;
  next.sessionId = restored.id;
  next.finalCounts = data.counts.filter((c) => c.sessionId === restored.id);
}
next.businessDataLoaded = true;
set(next);
```

`setBusinessContext` unconditionally clears `finalCounts` to `cleared.finalCounts` (empty) before the loader runs. If `data.sessions` is empty (e.g., a business with no sessions recorded yet, or a data-shape edge case) `restored` is `null`, and `next` never sets `finalCounts` at all — the `set(next)` call leaves the earlier `cleared.finalCounts` (empty) in place. Any session/count data for this business that exists in `data.counts` but isn't tied to a session found in `sessions` (e.g., a stale filter, a session whose status field wasn't set as expected) is invisibly dropped after every refresh, with no error surfaced (`lastSyncError` stays `null` because no exception was thrown — this is a silent success path, not the caught failure path).

## Defect 3 (Medium): The clear-then-load window is not gated behind `businessDataLoaded`, so a fast re-render can briefly show empty tenant state as if it were real

`businessDataLoaded: !needsLoad` is set synchronously to `false` when `needsLoad` is true, which is correct in isolation — but combined with Defect 1's race, `businessDataLoaded` can flip to `true` (in the `catch` block on error, or in the `loader` success path) while the store's actual scanFeed/finalCounts have been re-clobbered by the still-in-flight `rehydrate()` call. Consumers gating on `businessDataLoaded === true` to decide "safe to render" have no guarantee the values they read at that moment reflect the intended tenant's data, defeating the purpose of the readiness flag.

## Not a defect
- Clearing `scanFeed`/`finalCounts`/`needsReviewQueue`/`settings`/`firstScanAt`/`recentLocations` on every `setBusinessContext` call is intentional and correctly commented ("a context switch must REPLACE all four or the previous tenant's rows bleed through") — the *intent* to prevent cross-tenant bleed is right; the bug is the unguarded race with `rehydrateForUid`, not the clearing itself.
- The `catch` block correctly surfaces `lastSyncError` and still sets `businessDataLoaded: true` so the UI doesn't hang forever — that part is handled properly for the network-failure case.
- Not adopting the legacy blob automatically (gated by `hasLegacyBlob`/`adopt-choice` in the Gate component) is correct per the documented "no automatic side effect of signing in" rule.

## Recommendation
`rehydrateForUid` should return the pending rehydrate promise, and `BusinessContextGate` should `await` it before calling `setBusinessContext`, so the local persisted snapshot is fully applied (or explicitly superseded) before the tenant-clear-and-cloud-load sequence begins. Additionally, `setBusinessContext`'s loader should distinguish "no session found" from "load succeeded with an empty session list" so it doesn't silently leave `finalCounts` empty when there was actually recoverable data in `data.counts`.
