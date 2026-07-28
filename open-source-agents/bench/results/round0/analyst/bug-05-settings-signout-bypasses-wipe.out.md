<!-- subject=analyst case=bug-05-settings-signout-bypasses-wipe round=0 elapsed=94s rc=0 -->
**VERDICT:** FLAWED – the Settings “Sign out” button bypasses critical state‑reset logic, risking data loss and double‑counting of scanned items.  

**FINDINGS:**  
1. **[Correctness & data integrity]** *Critical* – The `Nav` component calls `prepareSignOut()` to determine unsynced scans (`left`) and then `resetForSignOut()` before signing out, ensuring all pending scans are either synced or deliberately discarded. The `SettingsPage` button simply invokes `signOut()`, skipping both checks and the reset. If a user signs out from Settings while having unsynced scans, those scans remain in the store; on next login they may be re‑synced, causing duplicate counts, or if the app clears the store on load, they are lost entirely. This directly violates the TOP LAW that every scanned code must appear on the scan feed and count in totals.  
   *Evidence:* `Nav.tsx` line 15–23 contains `const left = await useScanStore.getState().prepareSignOut(); … useScanStore.getState().resetForSignOut();`, whereas `settings/page.tsx` line 12 only has `onClick={() => void signOut()}`.  

2. **[Failure modes & honesty]** *Important* – The Settings button offers no user confirmation or warning about unsynced work. A silent sign‑out could lead users to believe all data was preserved when in fact pending scans are lost, violating the system’s promise of honest status reporting.  
   *Evidence:* `Nav.tsx` shows a `window.confirm(message)` guard; `settings/page.tsx` lacks any such prompt.  

3. **[Correctness & data integrity]** *Minor* – Because the Settings button does not call `prepareSignOut()`, it cannot detect race conditions where scans are being added concurrently with the sign‑out action, potentially leaving half‑completed scans in an indeterminate state.  
   *Scenario:* User scans a new item while the Settings page is rendered; clicking “Sign out” immediately clears the session but leaves the scan in the store, which may be re‑synced later or discarded without notice.  

4. **[Simplicity & scope]** *Minor* – The Settings button’s omission of reset logic simplifies its implementation but at the cost of violating the intended workflow; a minimal change (adding `prepareSignOut()` and `resetForSignOut()`) would align it with the Nav button without affecting other features.  

5. **[The skeptic]** *Critical* – Assuming the Settings sign‑out is harmless leads to a false sense of safety: if unsynced scans are lost, the app’s core promise (every scanned code appears on the feed and counts) fails. The only way to refute this claim would be evidence that `signOut()` itself clears the store; however, the provided snippet shows no such behavior, so the claim is demonstrably wrong.  

**QUESTIONS:**  
- Does the implementation of `signOut()` in `@/lib/auth` perform any state cleanup on the client side?  
- Is there a global effect or hook that automatically resets the scan store upon session termination, which might mitigate the missing reset logic in Settings?  
- What is the exact contract of `useScanStore.getState().prepareSignOut()` and `resetForSignOut()`—do they guarantee idempotency and prevent double‑counting?
