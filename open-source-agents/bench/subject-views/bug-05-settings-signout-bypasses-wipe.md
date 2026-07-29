# Case: bug-05-settings-signout-bypasses-wipe
## Task prompt (what the subject model sees)
Review the following code for real defects. Both snippets are from a multi-tenant inventory app: `Nav.tsx` is the app's top navigation bar (with its own "Log out" button) and `settings/page.tsx` is the account Settings page (with its own "Sign out" button), both letting a signed-in user sign out from a shared browser.
## Input code
```tsx
// src/components/Nav.tsx (Log out button)
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";
import { signOut } from "@/lib/auth";
import { isLiveAuth } from "@/services/auth/authMode";

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const openReviews = useScanStore((s) => s.needsReviewQueue.filter((r) => r.status === "open").length);
  // ...links array omitted...

  return (
    <header className="border-b border-zinc-200 bg-white">
      <nav className="mx-auto flex max-w-7xl items-center gap-1 px-4 py-2">
        {/* ...logo + nav links omitted... */}
        {isLiveAuth() && (
          <button
            type="button"
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
              router.replace("/login");
            }}
            className="ml-auto inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Log out
          </button>
        )}
      </nav>
    </header>
  );
}
```
```tsx
// src/app/(app)/settings/page.tsx (relevant imports + Sign out button)
import { getSession, onAuthChange, signOut } from "@/lib/auth";
// ...other imports omitted...

export default function SettingsPage() {
  // ...component state/effects omitted...

  return (
    <div>
      {/* ...settings sections omitted... */}
      <div>
        <button
          type="button"
          data-testid="sign-out"
          onClick={() => void signOut()}
          className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
```
