<!-- subject=analyst case=bug-05-settings-signout-bypasses-wipe round=3 elapsed=98s rc=0 -->
**TRACE:**  
1. *Nav button – user has 2 pending scans.*  
   - `prepareSignOut()` is awaited; it drains the queue, returns `left = 0`.  
   - The confirm message becomes “Log out now? Your counts are saved …”.  
   - User clicks OK → `resetForSignOut()` wipes any remaining local state.  
   - `signOut()` logs out and `router.replace("/login")` navigates to the login page.  

2. *Settings page – user has 1 pending scan.*  
   - The button’s handler is `onClick={() => void signOut()}`.  
   - No call to `prepareSignOut()` or `resetForSignOut()`.  
   - After `signOut()` completes, the app remains on the Settings page (no explicit navigation).  
   - The local store still contains the pending scan; it is never synced and will be lost when the browser session ends.

**SYNTAX‑FILTER:** No candidate finding concerns spelling, undefined identifiers, or missing declarations.  

**VERDICT:** FLAWED – the Settings page sign‑out path bypasses unsynced‑scan handling, violating honesty and data‑integrity laws.  

**FINDINGS:**  
1. **[Critical]** *Settings page Sign out button does not drain or wipe pending scans.*  
   - **Failure scenario**:  
     - *Starting state*: `pendingSyncQueue.length = 1` (scan T‑12345).  
     - *Action sequence*: User clicks the “Sign out” button on Settings.  
     - *Wrong outcome*: `signOut()` logs the user out but leaves the pending scan in local store; no navigation to `/login`. The unsynced scan is never synced and will be lost when the browser session ends.  
     - *Expected outcome*: Unsynced scans should first be drained (`prepareSignOut()`), then, if any remain, the user must be warned before `resetForSignOut()` wipes them; finally the app navigates to `/login`.  
   - **Evidence line**: `onClick={() => void signOut()}` in `src/app/(app)/settings/page.tsx`.

2. **[Medium]** *Nav button’s confirm message may mislead if `prepareSignOut()` fails silently.*  
   - If `prepareSignOut()` returns a non‑zero count but the draining actually succeeded, the user would be warned unnecessarily. The code does not verify that the returned `left` truly reflects unsynced work after the drain.  
   - **Evidence line**: `const left = await useScanStore.getState().prepareSignOut();`.

3. **[Low]** *Settings page Sign out button does not navigate to `/login`.*  
   - The handler calls only `signOut()`; any redirection must rely on global auth‑change listeners. If those are absent or misconfigured, the user remains on the Settings page after logout, confusing the UI state.  
   - **Evidence line**: same as (1).

**QUESTIONS:**  
- What does `useScanStore.getState().prepareSignOut()` return when there are unsynced scans?  
- Does `signOut()` clear local store or perform navigation to `/login` on its own?  
- Is there a global listener that redirects after auth change, ensuring the Settings page is not shown post‑logout?
