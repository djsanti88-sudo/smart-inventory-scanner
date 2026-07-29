<!-- subject=analyst case=bug-05-settings-signout-bypasses-wipe round=1 elapsed=82s rc=0 -->
**VERDICT:** FLAWED – the Settings page’s “Sign out” button fails to wipe local scan data before logging the user out, allowing unsynced scans to persist across sessions and potentially leak tenant‑specific information.  

---

### FINDINGS

1. **[critical] Correctness & data integrity** – *Settings sign‑out does not reset the scan store.*  
   - **Scenario:** User A creates two unsynced scans, then logs out via the Settings button (`onClick={() => void signOut()}`). The `useScanStore` state still contains those scans. User B logs in next; the same scans appear again because the store was never cleared.  
   - **Evidence:** Nav’s handler calls `useScanStore.getState().resetForSignOut();`, but Settings’ handler omits this call (line `onClick={() => void signOut()}`).

2. **[critical] Security & tenancy** – *Residual tenant data can be exposed to another tenant.*  
   - **Scenario:** After the above, User B’s view shows User A’s unsynced scans because the shared browser session still holds them in memory. This violates isolation guarantees for a multi‑tenant app.  
   - **Evidence:** Same as #1: Settings button never invokes `resetForSignOut()`.

3. **[important] Failure modes & honesty** – *Settings sign‑out ignores errors and does not await the async operation.*  
   - **Scenario:** If `signOut()` throws (e.g., network failure), the UI remains on the settings page, still showing User A’s data, while the user is technically logged out. The lack of error handling means the app silently fails to inform the user or retry.  
   - **Evidence:** Handler uses `() => void signOut()` – no `await`, no `.catch` block.

---

### QUESTIONS

- What does `useScanStore.getState().resetForSignOut()` actually clear? Does it remove all unsynced scans and reset counters?  
- Is there any other code path that clears the store on logout (e.g., a global effect listening to auth changes)?  
- How is `signOut()` implemented – does it guarantee the user’s session cookie is removed before navigation?  

These details would confirm whether the Settings button truly leaves stale data or if additional cleanup occurs elsewhere.
