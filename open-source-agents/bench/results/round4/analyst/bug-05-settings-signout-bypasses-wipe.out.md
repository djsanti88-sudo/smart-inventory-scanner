<!-- subject=analyst case=bug-05-settings-signout-bypasses-wipe round=4 elapsed=85s rc=0 -->
**TRACE:**  
1. **Unsynced scan present** – assume `pendingSyncQueue.length === 1`.  
2. **Nav button flow** – the async handler runs:  
   * `left = await useScanStore.getState().prepareSignOut();` → `left === 1`.  
   * Message shows “1 scan could not sync…”.  
   * User confirms → `useScanStore.getState().resetForSignOut();` clears the queue.  
   * `await signOut();` logs out, then `router.replace("/login");`.  
3. **Settings button flow** – handler runs:  
   * `onClick={() => void signOut()}` – no drain or reset called.  
   * The pending scan remains in local state and is lost when the session ends.

**SYNTAX‑FILTER:** No candidate finding concerns spelling, undefined identifiers, or missing declarations; all referenced names are present.

**VERDICT:** FLAWED – the Settings page’s sign‑out bypasses the drain logic that protects unsynced scans.

**FINDINGS**

1. **[Critical] Unsynced scans lost when signing out via Settings page because it skips `prepareSignOut`/`resetForSignOut`.**  
   *Starting state:* `pendingSyncQueue.length === 1`.  
   *Action sequence:* User clicks the “Sign out” button on `/settings`.  
   *Wrong outcome:* The unsynced scan remains in local storage and is discarded when the user logs out; the count shown to the user was N+1, but the server receives only N.  
   *Expected outcome:* The app should either drain the queue or at least warn that 1 scan will be lost before signing out.  
   *Evidence line:* `onClick={() => void signOut()}` in `src/app/(app)/settings/page.tsx`.

**QUESTIONS**

- Does `signOut()` clear any local state (e.g., `pendingSyncQueue`) on its own?  
- What is the implementation of `prepareSignOut` and `resetForSignOut`; do they indeed drain or reset the queue?  
- Is there any other sign‑out entry point that also bypasses the drain logic, potentially causing similar data loss?
