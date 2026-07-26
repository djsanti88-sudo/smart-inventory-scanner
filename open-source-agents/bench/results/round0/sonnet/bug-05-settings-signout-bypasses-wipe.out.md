# Review: bug-05-settings-signout-bypasses-wipe

## Defect 1 (Critical): Settings page's "Sign out" button calls `signOut()` directly, skipping `prepareSignOut`, the unsynced-work warning, and `resetForSignOut()` entirely

```tsx
// settings/page.tsx
<button
  type="button"
  data-testid="sign-out"
  onClick={() => void signOut()}
  ...
>
  Sign out
</button>
```

Compare this to `Nav.tsx`'s "Log out" button, which:
1. Awaits `useScanStore.getState().prepareSignOut()` to attempt a drain and learn how many scans are still unsynced.
2. Shows an honest `window.confirm` warning naming the exact count of scans that will be permanently discarded if the user proceeds, and lets the user cancel.
3. Only on confirmation calls `useScanStore.getState().resetForSignOut()` — which is presumably what wipes the local tenant state (scan feed, counts, review queue, etc.) so the next user of a shared browser does not inherit the previous user's business data.
4. Only then calls `signOut()` and redirects.

The Settings page's button does none of this. It calls `signOut()` alone, with no drain attempt, no warning about unsynced work, and — critically — no `resetForSignOut()` call. On a shared browser (the stated threat model for this multi-tenant app, per the file's own docstring), a user who signs out via Settings leaves the previous business's local Zustand/localStorage state (scan feed, counts, needs-review queue, product/alias data) fully intact and readable by whoever uses the browser next, until/unless something else happens to reset it. This is exactly the "signout bypasses wipe" bug: there are two sign-out affordances in the app, and only one of them actually performs the wipe.

Secondary consequence: because `prepareSignOut`/drain is skipped, any unsynced scans that would have been flushed to the cloud (or explicitly surfaced to the user as "about to be lost") are neither synced nor flagged — they're just silently abandoned with no confirmation and no chance for the user to cancel and wait for sync.

## Defect 2 (Medium): Settings page's `signOut()` call has no navigation afterward

Nav.tsx explicitly does `router.replace("/login")` after signing out. The Settings page's handler does not navigate anywhere after `signOut()` resolves. Depending on how `onAuthChange`/route guards are wired elsewhere, the user may be left sitting on the Settings page in a signed-out state (or worse, in a state where `businessContextReady`/session data is stale because `resetForSignOut` never ran), rather than being routed to `/login` the way the Nav flow guarantees.

## Defect 3 (Low): No error handling around `signOut()`

`onClick={() => void signOut()}` fires-and-forgets the promise with no `.catch`/try-catch. If `signOut()` rejects (network failure, auth provider error), the failure is silently swallowed — the button gives no feedback that sign-out did not actually happen, and (combined with Defect 1) the user may believe they've signed out and safely handed the browser to someone else when they have not.

## Not a defect
- Nav.tsx's flow itself (drain, honest count-based warning, confirm-gate, reset, sign out, redirect) is correctly designed and matches the documented "F1" fix intent in its own comment.
- Gating the Nav button on `isLiveAuth()` is reasonable and not itself a defect in this snippet.

## Recommendation
The Settings page's sign-out handler must call the same sequence as Nav.tsx: `await prepareSignOut()` → confirm with an honest unsynced-count warning → `resetForSignOut()` → `signOut()` → redirect to `/login`. Ideally this sequence should be extracted into one shared function (e.g. `performSignOut()`) so there is exactly one code path that can wipe tenant state on sign-out, rather than two independent UI buttons that can silently drift out of sync with each other, as they have here.
