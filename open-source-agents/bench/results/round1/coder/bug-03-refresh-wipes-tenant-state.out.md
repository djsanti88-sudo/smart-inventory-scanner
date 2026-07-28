<!-- subject=coder case=bug-03-refresh-wipes-tenant-state round=1 elapsed=51s rc=0 -->
Looking at this code carefully using the Doctrine methodology:

## 1. Evidence before belief

Let me trace through what happens in `setBusinessContext` with concrete values.

## 2. Trace, don't recognize

Let's trace a specific execution:
- Input: businessId="biz1", userId="user1"
- cloudBackend=true (assuming), deps.loadBusinessData exists
- Initial state has some existing tenant data

The function does:
1. `const cleared = emptyTenantState()` - clears all tenant-specific state
2. Sets new state with cleared values + businessId, userId, etc.
3. Calls loader async and sets the result back to state

## 3. Attack my own answer

What would prove me wrong? If I'm missing a race condition or timing issue.

The key insight: `setBusinessContext` is called on every page mount/refresh, but there's an async operation that can modify state after this initial set.

Looking more carefully at the code:
- The first `set()` call sets all tenant data to cleared values
- Then it starts a loader which asynchronously updates with new data
- But if another context switch happens during or before this async load completes, we could have a race condition

## 4. Boring causes first

The most likely issue: the async operation doesn't properly handle concurrent calls.

## 5. The code is the truth, names lie

Looking at `setBusinessContext` - it's doing what it says on the tin:
- Clears tenant state 
- Sets business context
- Loads data if needed

But there's a problem with the timing of when `syncPending()` gets called vs when the async load completes.

## 6. Walk the data, not the prose

Let me trace one record through this process:

1. User refreshes page (setBusinessContext called)
2. State cleared and set with new businessId/userId
3. Async loader starts 
4. syncPending() is called immediately after starting async load
5. If another context switch happens before async completes, the second call to `setBusinessContext` will clear state again

## 7. Concrete failure scenario or it does not count

**Starting state:** User has businessId="biz1", userId="user1" with some data  
**Action sequence:** 
1. Page refresh calls setBusinessContext("biz2", "user2") 
2. Async load for biz2 starts
3. Before async completes, user navigates to another page that triggers setBusinessContext("biz3", "user3")
4. The second call clears the state again

**Wrong outcome:** biz3's data gets loaded but then immediately cleared by biz2's async response  
**Expected outcome:** Each context switch should be isolated and not interfere with others  

## 8. Smallest complete answer

The bug is in `setBusinessContext` - it doesn't prevent race conditions between multiple concurrent calls to setBusinessContext.

```diff
// src/stores/scanStore.ts
setBusinessContext: (businessId, userId) => {
+  const currentBusinessId = get().businessId;
+  const currentUserId = get().userId;
  
  const needsLoad = cloudBackend && !!deps.loadBusinessData;
  const cleared = emptyTenantState();
  set({
    businessId,
    userId,
    businessContextReady: true,
    businessDataLoaded: !needsLoad,
    lastSyncError: null,
    scanFeed: cleared.scanFeed,
    finalCounts: cleared.finalCounts,
    needsReviewQueue: cleared.needsReviewQueue,
    settings: cleared.settings,
    firstScanAt: cleared.firstScanAt,
    recentLocations: cleared.recentLocations,
  });
  const loader = deps.loadBusinessData;
  if (cloudBackend && loader) {
    void (async () => {
      try {
        const data = await loader(businessId, userId);
        // Reconstruct the active count session + its finalCounts (survive-refresh). Prefer the most
        // recent ACTIVE session; else the most recent overall. finalCounts are the persisted count
        // lines for that session, mapped back to store shape. No session -> keep current defaults.
        const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
          (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
        const sessions = [...data.sessions].sort(byStartedAtDesc);
        const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
        const next: Partial<ScanState> = { products: data.products, aliases: data.aliases };
        if (restored) {
          next.currentSession = restored;
          next.sessionId = restored.id;
          next.finalCounts = data.counts.filter((c) => c.sessionId === restored.id);
        }
        next.businessDataLoaded = true;
        
+       // Only update state if this is still the active business context
+       const currentState = get();
+       if (currentState.businessId === businessId && currentState.userId === userId) {
          set(next);
+       }
      } catch (e) {
        // Surface the error but mark loaded so the UI does not hang forever (sync still paused on error).
+       const currentState = get();
+       if (currentState.businessId === businessId && currentState.userId === userId) {
          set({ 
            lastSyncError: e instanceof Error ? e.message : "Failed to load business data", 
            businessDataLoaded: true 
          });
+       }
      }
      
+     // Only call syncPending if this is still the active context
+     const currentState = get();
+     if (currentState.businessId === businessId && currentState.userId === userId) {
        get().syncPending();
+     }
    })();
  } else {
    get().syncPending(); // drain anything queued now that we have a real business context
  }
},
```

NOTES: 
1. The fix adds checks to ensure async operations only update state if the context hasn't changed since the operation started
2. This prevents race conditions where multiple context switches could interfere with each other
3. I assumed `get()` returns the current store state and that we need to check both businessId and userId for consistency
