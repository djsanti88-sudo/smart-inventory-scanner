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
## GROUND TRUTH (never shown to subject)
- Defect: The two sign-out buttons are not equivalent. Nav's "Log out" button runs a full flow: it drains unsynced work with an honest confirm dialog if data would be lost, calls `resetForSignOut()` to wipe the current tenant's local state, THEN calls `signOut()`, then redirects. Settings' "Sign out" button just calls bare `signOut()` — it never drains pending work, never warns about unsynced scans, and critically never calls `resetForSignOut()`, so the previous tenant's data (scanFeed, products, counts, etc.) is left sitting in localStorage. The next person who signs in on that same browser inherits the prior user's business data, and any unsynced scans are silently discarded with no warning.
- Fix commit: 42bfdca fix(auth): one shared sign-out flow - Settings button no longer bypasses the tenant wipe (ultra CRITICAL)
- Key evidence: Settings' button is `onClick={() => void signOut()}` with no call to `prepareSignOut()`, no confirm dialog, and no call to `useScanStore.getState().resetForSignOut()` — compare against Nav's button, which calls `prepareSignOut()`, shows a confirm message, calls `resetForSignOut()`, and only then calls `signOut()` before redirecting.
- Scoring: HIT if the subject identifies that Settings' sign-out handler skips the tenant-state wipe (`resetForSignOut`) and the unsynced-work drain/warning that Nav's Log out button performs, meaning the previous tenant's data survives in localStorage for the next user on the same browser (a tenant-isolation/data-leak bug) and/or unsynced scans are silently lost with no warning. PARTIAL if the subject notices the two sign-out implementations differ or flags that Settings' handler is "too simple"/missing error handling, without specifically naming the missing `resetForSignOut()` call or the tenant-data-leak consequence. Plausible-but-wrong findings: (1) claiming the missing `await` on `signOut()` in Nav's async handler is a bug (it is awaited: `await signOut();`); (2) flagging that `isLiveAuth()` is checked in Nav but not in Settings as a bug (Settings is only reachable when signed in, so this is not the historical defect); (3) suggesting the confirm dialog text logic (`left === 0 ? ... : ...`) has an off-by-one or grammar bug (the singular/plural handling is correct).
