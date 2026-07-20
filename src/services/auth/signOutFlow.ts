import { useScanStore } from "@/stores/scanStore";
import { signOut } from "@/lib/auth";

// ONE shared sign-out flow so Nav.tsx and the Settings "Sign out" button can never drift. This is the
// data-loss-protection surface: without resetForSignOut the NEXT user on this browser inherits the prior
// tenant's scan feed / products / aliases from localStorage (sis-scan-v1). Extracted verbatim from Nav's
// original handler (Nav.tsx: prepareSignOut -> honest confirm -> resetForSignOut -> signOut -> redirect).

/** Compose the honest confirm message from the count of scans that could not sync. */
export function unsyncedSignOutMessage(left: number): string {
  return left === 0
    ? "Log out now? Your counts are saved - you can sign back in any time to keep going."
    : `${left} scan${left === 1 ? "" : "s"} could not sync to the cloud yet. Signing out now will discard ${left === 1 ? "it" : "them"} permanently. Sign out anyway?`;
}

/**
 * The full user-initiated sign-out flow (Nav + Settings "Sign out"):
 *   1. attempt one awaited drain, then warn HONESTLY if unsynced work would be lost;
 *   2. cancelling the confirm aborts sign-out entirely (no reset, no signOut, no redirect);
 *   3. full tenant wipe (resetForSignOut) so the next user sees no prior-tenant residue;
 *   4. await signOut();
 *   5. redirect to /login via the caller-supplied navigator.
 *
 * Returns true if sign-out proceeded, false if the user cancelled at the confirm.
 * `confirmFn` defaults to window.confirm so callers need only pass the redirect.
 */
export async function runSignOutFlow(
  redirect: () => void,
  confirmFn: (message: string) => boolean = (m) =>
    typeof window === "undefined" ? true : window.confirm(m),
): Promise<boolean> {
  const left = await useScanStore.getState().prepareSignOut();
  if (!confirmFn(unsyncedSignOutMessage(left))) return false; // cancel aborts: no reset, no signOut
  useScanStore.getState().resetForSignOut();
  await signOut();
  redirect();
  return true;
}

/**
 * The wipe-and-sign-out half WITHOUT the unsynced-work confirm or redirect, for use after an action
 * that has ALREADY destroyed the tenant's data server-side (account deletion). No unsynced-work confirm
 * is shown here because the business is gone: the local pending queue is meaningless and there is nothing
 * to preserve. The deletion's own typed-phrase + confirm already gated the destructive act. Wiping local
 * state stops the deleted business's scan feed / products / aliases (sis-scan-v1) from ghosting into the
 * next session on this browser. The caller performs the redirect (deletion uses window.location.href).
 */
export async function wipeAndSignOut(): Promise<void> {
  useScanStore.getState().resetForSignOut();
  await signOut();
}
