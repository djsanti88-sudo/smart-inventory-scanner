<!-- subject=analyst case=bug-03-refresh-wipes-tenant-state round=2 elapsed=236s rc=0 -->
**TRACE:**  
*Scenario 1 – normal load of business “B1” by user “U1”*  

```
setBusinessContext('B1','U1')
needsLoad = cloudBackend && !!deps.loadBusinessData   // true
cleared = emptyTenantState()                         // {scanFeed:[], finalCounts:[], …}
set({businessId:'B1',userId:'U1',…,
     scanFeed:cleared.scanFeed,finalCounts:cleared.finalCounts,…})
loader = deps.loadBusinessData
if (cloudBackend && loader) {
  async () => {
    data = await loader('B1','U1')                 // ← fetches products/aliases
    sessions = [...data.sessions].sort(byStartedAtDesc)
    restored = sessions.find(s=>s.status==='active') ?? sessions[0] ?? null
    next = {products:data.products, aliases:data.aliases}
    if (restored) {
      next.currentSession=restored; next.sessionId=restored.id;
      next.finalCounts=data.counts.filter(c=>c.sessionId===restored.id)
    }
    next.businessDataLoaded=true
    set(next)                                       // ← store now holds B1 data
  }();
}
```

*Scenario 2 – race between two consecutive calls to `setBusinessContext`*  

```
setBusinessContext('A','U1')          // first call, clears state A
loaderA = deps.loadBusinessData
async () => { … set(nextA); }()        // async loader for A

// before loaderA resolves, second call occurs:
setBusinessContext('B','U1')          // second call, clears state B
loaderB = deps.loadBusinessData
async () => { … set(nextB); }()        // async loader for B

// now loaderA resolves:
dataA = await loaderA('A','U1')
nextA = {products:dataA.products,…}
set(nextA)                              // ← overwrites store that currently has context B
```

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration. All identified issues concern runtime behavior.

**VERDICT:**  
FLAWED – race conditions can cause stale tenant data to be loaded after a context switch.

**FINDINGS**

1. **[Correctness & data integrity] Race condition between async loaders from previous contexts overriding new context**  
   *Scenario*: Two consecutive `setBusinessContext` calls before the first loader resolves.  
   *Wrong outcome*: Store ends with products/aliases of old business “A” while `businessId` is “B”.  
   *Expected outcome*: Store should contain data for “B” only.  
   *Evidence*: Lines showing async loader creation and use of captured `businessId`:  
   ```
   const loader = deps.loadBusinessData;
   if (cloudBackend && loader) {
     void (async () => { … set(next); })();
   }
   ```

2. **[Security & tenancy] Race between `rehydrateForUid` and `setBusinessContext` causing stale tenant data**  
   *Scenario*: `rehydrateForUid(user.uid)` loads persisted data for a previous user after `setBusinessContext` clears state.  
   *Wrong outcome*: Store contains old user's products/aliases while `businessId` reflects the current user.  
   *Expected outcome*: Store should contain only current user's data.  
   *Evidence*: Lines showing rehydrate call not awaited:  
   ```
   useScanStore.getState().rehydrateForUid(user.uid);
   setBusinessContext(membership.businessId, user.uid);
   ...
   persistApi.rehydrate();          // returns Promise but not awaited
   ```

3. **[Failure modes & honesty] Loader failure misleads UI into thinking data loaded**  
   *Scenario*: `loader` throws; catch block sets `businessDataLoaded: true`.  
   *Wrong outcome*: UI indicates success while products/aliases are missing.  
   *Expected outcome*: UI should reflect that data failed to load.  
   *Evidence*: Lines in catch block:  
   ```
   set({ lastSyncError: e instanceof Error ? e.message : "Failed to load business data",
         businessDataLoaded: true });
   ```

**QUESTIONS**

- What guarantees exist that multiple `setBusinessContext` calls cannot overlap? Is there a mechanism (e.g., cancellation token) to prevent earlier async loaders from overriding newer context data?  
- How does `emptyTenantState()` implement clearing of all tenant‑specific fields, and does it guarantee no residual data remains after a call?  
- Does the persist plugin’s `rehydrate` method complete synchronously or asynchronously? If asynchronous, is there a race with the immediate subsequent `setBusinessContext` that could restore stale data?  
- Is `deps.loadBusinessData` idempotent per tenant/user pair, and does it include any membership validation to prevent unauthorized data exposure?
