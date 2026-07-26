<!-- subject=analyst case=bug-05-settings-signout-bypasses-wipe round=2 elapsed=142s rc=0 -->
**TRACE:**  
1. **Nav button – left = 3 unsynced scans**  
   - `prepareSignOut()` → `left = 3`  
   - Message: `"3 scans could not sync to the cloud yet. Signing out now will discard them permanently."`  
   - User confirms (`window.confirm` returns true) → proceed  
   - `resetForSignOut()` clears all scan‑store state  
   - `await signOut()` clears session cookie  
   - `router.replace("/login")` navigates to the login page  

2. **Settings button – left = 3 unsynced scans**  
   - Click triggers `onClick={() => void signOut()}`  
   - No call to `prepareSignOut()` or `resetForSignOut()`  
   - Session cookie cleared, but scan‑store still holds the 3 unsynced scans  
   - UI remains on the settings page; no redirect occurs  

**SYNTAX-FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.  

**VERDICT:** FLAWED – The Settings page sign‑out button omits critical state reset and unsynced‑scan warning, risking stale data and tenant data leakage.  

**FINDINGS:**  

1. **[CRITICAL] [Correctness & data integrity]**  
   *Defect:* The Settings page `signOut` handler does not call `useScanStore.getState().resetForSignOut()` nor warn about unsynced scans, leaving stale scan state after logout.  
   *Failure scenario:* User has 5 unsynced scans → clicks “Sign out” on Settings → session cleared but store still contains the 5 scans → next login (same or different tenant) shows those scans → **Wrong outcome:** data loss across tenants.  
   *Expected outcome:* Store reset, no unsynced scans remain.  
   *Evidence line:* `onClick={() => void signOut()}` – no call to `resetForSignOut()`.

2. **[HIGH] [Security & tenancy]**  
   *Defect:* The Settings page does not redirect the user after clearing the session, potentially leaving the UI in a logged‑in state while the auth cookie is gone, exposing tenant data or causing confusion.  
   *Failure scenario:* User clicks “Sign out” → session cleared but stays on settings page → **Wrong outcome:** UI still shows tenant content.  
   *Expected outcome:* Navigation to `/login`.  
   *Evidence line:* No `router.replace` after `signOut()`.

3. **[MEDIUM] [Failure modes & honesty]**  
   *Defect:* Both logout handlers lack error handling for `signOut()` or the subsequent redirect, so a network failure silently leaves the user on the same page with an inconsistent state.  
   *Failure scenario:* Network error during `await signOut()` → `router.replace` not executed → **Wrong outcome:** remains on current page with cleared session but no navigation.  
   *Expected outcome:* Either navigate to `/login` or show an error.  
   *Evidence line:* No `try/catch` around `await signOut()`.

4. **[LOW] [Simplicity & scope]**  
   *Defect:* The Settings button uses `onClick={() => void signOut()}` which returns a promise but is not awaited, potentially causing an unhandled rejection if `signOut()` fails.  
   *Failure scenario:* `signOut()` throws → error unhandled → **Wrong outcome:** silent failure.  
   *Expected outcome:* Handle or await the promise.  
   *Evidence line:* `onClick={() => void signOut()}`.

**QUESTIONS:**  
- What does `useScanStore.getState().resetForSignOut()` actually reset? (to confirm that its omission truly leaves stale data.)
