<!-- subject=coder case=bug-05-settings-signout-bypasses-wipe round=1 elapsed=27s rc=0 -->
Looking at this code, I need to trace through the behavior of both sign-out mechanisms and identify any defects.

Let me analyze what happens in each case:

1. In `Nav.tsx`, when clicking "Log out":
   - It calls `useScanStore.getState().prepareSignOut()` 
   - If there are unsynced scans, it shows a confirmation dialog
   - Then it calls `useScanStore.getState().resetForSignOut()`
   - Finally calls `signOut()` and redirects to `/login`

2. In `settings/page.tsx`, when clicking "Sign out":
   - It directly calls `signOut()` with no preparation or reset

The defect is clear: the settings page's sign-out button bypasses all the safety checks that are present in the navigation bar's log out button.

Let me trace through what should happen:
- Both buttons should perform the same safety checks
- The settings page button skips the `prepareSignOut()` and `resetForSignOut()` steps

This creates a security vulnerability where users can sign out without being warned about unsynced work, potentially losing data.

```diff
// src/app/(app)/settings/page.tsx
export default function SettingsPage() {
  // ...component state/effects omitted...

  return (
    <div>
      {/* ...settings sections omitted... */}
      <div>
        <button
          type="button"
          data-testid="sign-out"
          onClick={async () => {
            // F1: attempt one awaited drain first, then warn HONESTLY if unsynced work would be lost.
            const left = await useScanStore.getState().prepareSignOut();
            const message =
              left === 0
                ? "Log out now? Your counts are saved - you can sign back in any time to keep going."
                : `${left} scan${left === 1 ? "" : "s"} could not sync to the cloud yet. Signing out now will discard ${left === 1 ? "it" : "them"} permanently. Sign out anyway?`;
            if (!window.confirm(message)) return; // cancel aborts sign-out entirely: no reset, no signOut
            useScanStore.getState().resetForSignOut();
            await signOut();
          }}
          className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
```

NOTES:
- The fix requires importing `useScanStore` in the settings page component
- I'm assuming that `signOut()` is a function that handles the actual logout process (which appears to be imported from "@/lib/auth")
- The implementation follows exactly the same pattern as used in Nav.tsx for consistency
- This addresses the security issue where the settings sign-out bypassed data safety checks
