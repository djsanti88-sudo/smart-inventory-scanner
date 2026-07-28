<!-- subject=analyst case=bug-03-refresh-wipes-tenant-state round=4 elapsed=202s rc=0 -->
**TRACE**

1. *Stale `currentSession` after a tenant switch*  
   - Start: store has `currentSession = {id:"S1",status:"active"}` from tenant A.  
   - Call `setBusinessContext("B2","U2")`.  
     - Inside the first `set`, only `businessId`, `userId`, and other fields are written; **`currentSession` is not mentioned** → after this line, `currentSession` still equals `{id:"S1",…}`.  
   - Async loader runs: `data.sessions` contains no active session → `restored = null`.  
     - `next.currentSession` is never set because the `if (restored)` block is skipped.  
   - Final merge (`set(next)`) leaves `currentSession` unchanged.  
   Result: tenant B’s context still shows tenant A’s session.

2. *Race between `rehydrateForUid` and `setBusinessContext`*  
   - Effect starts: `user = await getSession()` → `U2`.  
   - Calls `useScanStore.getState().rehydrateForUid(user.uid);` – this function sets persist options **and** calls `persistApi.rehydrate();`, which returns `Promise<void> | void`.  
   - Immediately after, the effect invokes `setBusinessContext("B2","U2")`.  
   - If the rehydration promise resolves later, it will apply persisted data for `U2` on top of the freshly set state, potentially overriding fields that were just written.  
   Result: tenant B may end up with incomplete or stale data.

---

**SYNTAX‑FILTER**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.

---

**VERDICT**  
FLAWED – the code can leave `currentSession` stale after a context switch and race with rehydration can produce incomplete tenant state.

---

### FINDINGS

1. **[Critical] Stale `currentSession` after tenant switch when new tenant has no active session**  
   *Failure scenario* – Starting state: store holds an active session from tenant A (`currentSession = {id:"S1",…}`). Action: call `setBusinessContext("B2","U2")` for tenant B, which in the initial `set` does **not** write `currentSession`. The async loader finds no active session, so it never sets `next.currentSession`. After merging, `currentSession` remains `{id:"S1",…}`.  
   *Wrong outcome* – UI shows tenant A’s session data for tenant B, causing incorrect counts and confusing the user.  
   *Expected outcome* – `currentSession` should be cleared (or set to `undefined`) when no active session exists for the new tenant.  
   *Evidence line* – `set({ businessId, userId, … });` (no `currentSession`) and `if (restored) { next.currentSession = restored; … }`.

2. **[High] `rehydrateForUid` is not awaited, causing a race with `setBusinessContext`**  
   *Failure scenario* – In the effect body of `BusinessContextGate`, after obtaining the user (`U2`) we call `useScanStore.getState().rehydrateForUid(user.uid);`. The function definition shows it may return `Promise<void> | void`; however, the caller does **not** await this promise. Immediately afterwards, `setBusinessContext("B2","U2")` runs and overwrites most tenant fields. If the rehydration resolves later, it will apply persisted data on top of the freshly set state, potentially restoring stale or incomplete values for the new tenant.  
   *Wrong outcome* – The store may end up with a mix of old and new data, leading to missing counts, wrong session info, etc.  
   *Expected outcome* – `rehydrateForUid` should be awaited (or its promise handled) before setting the new context so that the freshly loaded state is fully applied.  
   *Evidence line* – `useScanStore.getState().rehydrateForUid(user.uid);` and the function signature `rehydrateForUid: (uid: string) => { … if (persistApi) { persistApi.setOptions(...); void persistApi.rehydrate(); } }`.

---

### QUESTIONS

1. What does `emptyTenantState()` actually return? Does it clear `currentSession`/`sessionId`?  
2. Is `rehydrateForUid` guaranteed to be synchronous, or can it return a promise that resolves after the caller continues?  
3. Are there any other parts of the store (e.g., `pendingSyncQueue`) that might retain stale data across tenant switches?
