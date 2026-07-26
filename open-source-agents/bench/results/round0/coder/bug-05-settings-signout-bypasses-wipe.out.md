<!-- subject=coder case=bug-05-settings-signout-bypasses-wipe round=0 elapsed=48s rc=0 -->
Looking at this code, I can identify a clear bug in the settings page's sign-out functionality. The issue is that the Settings page's "Sign out" button bypasses the important data synchronization checks that are properly implemented in the Nav component.

In `Nav.tsx`, when signing out, the code:
1. Calls `prepareSignOut()` to check for unsynced work
2. Shows a confirmation dialog based on the results
3. Only proceeds with sign-out if confirmed
4. Calls `resetForSignOut()` to clear local state
5. Then calls `signOut()`

However, in `settings/page.tsx`, the "Sign out" button simply calls `signOut()` directly without any of these safety checks or state resets.

Here's the fix:

```tsx
// src/app/(app)/settings/page.tsx
import { getSession, onAuthChange, signOut } from "@/lib/auth";
import { useScanStore } from "@/stores/scanStore";
import { useRouter } from "next/navigation";
// ...other imports omitted...

export default function SettingsPage() {
  // ...component state/effects omitted...
  const router = useRouter();

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
                ? "Sign out now? Your counts are saved - you can sign back in any time to keep going."
                : `${left} scan${left === 1 ? "" : "s"} could not sync to the cloud yet. Signing out now will discard ${left === 1 ? "it" : "them"} permanently. Sign out anyway?`;
            if (!window.confirm(message)) return; // cancel aborts sign-out entirely: no reset, no signOut
            useScanStore.getState().resetForSignOut();
            await signOut();
            router.replace("/login");
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
1. I've added the same sign-out logic from Nav.tsx to the settings page to ensure consistency
2. I imported `useScanStore` and `useRouter` to match the pattern in Nav.tsx
3. The fix ensures both sign-out buttons behave identically, preventing data loss by properly checking for unsynced work before signing out
4. This maintains the existing behavior while fixing the bypass vulnerability
