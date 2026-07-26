<!-- subject=analyst case=bug-03-refresh-wipes-tenant-state round=3 elapsed=204s rc=0 -->
**TRACE:**  
1. LocalStorage contains persisted state for `uid = U1`: `scanFeed` includes a `ScanEvent S1`; `finalCounts` holds counts from the last session.  
2. `BusinessContextGate` runs: it calls `rehydrateForUid(U1)`, which sets the persistence key and invokes `persistApi.rehydrate()`. The rehydrated data is now in the store (`scanFeed=[S1]`, `finalCounts=…`).  
3. Immediately after, `setBusinessContext(B1,U1)` executes. It calls `emptyTenantState()` (which returns cleared values for all tenant‑specific fields) and then `set({ …cleared })`. This overwrites the rehydrated data, wiping out `S1` and all counts.  
4. The async loader runs next; it loads products/aliases but does **not** set `finalCounts` when no active session is found, leaving the store with an empty `finalCounts`.

---

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.

---

**VERDICT:**  
FLAWED – `setBusinessContext` wipes tenant state on every refresh, causing loss of locally persisted scans and counts that should survive a page reload.

---

**FINDINGS**

1. **[Critical] Correctness & data integrity** – `setBusinessContext` clears `scanFeed` and `finalCounts` before loading Firestore data, wiping any locally persisted unsynced scans or counts restored by `rehydrateForUid`.  
   *Failure scenario:* Starting state: localStorage holds a `ScanEvent S1` in `scanFeed`. Actions: page reload triggers `BusinessContextGate`; it calls `rehydrateForUid(U1)` then immediately `setBusinessContext(B1,U1)`.  
   *Wrong outcome:* After `setBusinessContext`, the store’s `scanFeed` is empty, losing `S1`.  
   *Expected outcome:* `S1` should remain in `scanFeed` and be counted.  
   *Evidence line:* `useScanStore.getState().rehydrateForUid(user.uid);` followed by `setBusinessContext(membership.businessId, user.uid);`.

2. **[High] Correctness & data integrity** – The loader does not restore `finalCounts` when no active session is found; if the last session was inactive, `finalCounts` remains cleared after `setBusinessContext`, causing counts to be lost on refresh.  
   *Failure scenario:* Starting state: store has `finalCounts` from a previous session. Actions: page reload triggers `BusinessContextGate`; it calls `setBusinessContext(B1,U1)`. The async loader fetches data but finds no active session (`restored === null`).  
   *Wrong outcome:* `finalCounts` stays empty.  
   *Expected outcome:* `finalCounts` should be restored from Firestore for the most recent overall session (active or not).  
   *Evidence line:* `const next: Partial<ScanState> = { products: data.products, aliases: data.aliases }; if (restored) { next.finalCounts = ... }`.

3. **[Medium] Simplicity & scope** – `rehydrateForUid` is called **before** `setBusinessContext`, but `emptyTenantState()` clears the store again, making the rehydration redundant and potentially confusing developers.  
   *Failure scenario:* None (the code still works).  
   *Expected outcome:* Call `rehydrateForUid` after `setBusinessContext` or remove it if not needed.  
   *Evidence line:* `useScanStore.getState().rehydrateForUid(user.uid);` preceding `setBusinessContext(membership.businessId, user.uid);`.

---

**QUESTIONS**

- What does `emptyTenantState()` actually return? Does it load persisted data for the current tenant or just default empty values?  
- In the loader, is there any path that sets `finalCounts` when `restored === null` (i.e., no active session)? If not, should the code be updated to restore counts from the most recent overall session?  
- Is calling `rehydrateForUid` before `setBusinessContext` intentional, or could it be moved after to avoid redundant rehydration?
