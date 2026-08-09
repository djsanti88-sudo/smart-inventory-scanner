"use client";

import { useState, useSyncExternalStore } from "react";
import type { User } from "firebase/auth";
import { resendVerificationEmail } from "@/lib/auth";

const DISMISS_KEY = "sis-verify-banner-dismissed";

// Dismissal is session-scoped external state (sessionStorage), so it is read via
// useSyncExternalStore: the server snapshot is always "not dismissed" and React reconciles the real
// client value right after hydration without a mismatch warning, and without calling setState inside
// an effect (which the react compiler lint rejects). sessionStorage fires no cross-write events of
// its own, so dismiss() notifies subscribers manually.
const dismissListeners = new Set<() => void>();
function subscribeDismiss(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage unavailable; the notify below still hides the banner for this page's lifetime */
  }
  dismissListeners.forEach((l) => l());
}

/** Non-blocking email-verification nudge. Shows ONLY for password-provider users whose email is
 *  unverified. Never gates any route or the scan flow (TOP-LEVEL LAW). Dumb component: the caller
 *  passes the current user from the app's existing auth state source. */
export function EmailVerifyBanner({ user }: { user: User | null }) {
  const dismissed = useSyncExternalStore(subscribeDismiss, readDismissed, () => false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [sending, setSending] = useState(false);

  const isUnverifiedPasswordUser =
    !!user &&
    !user.emailVerified &&
    user.providerData.some((p) => p.providerId === "password");

  if (!isUnverifiedPasswordUser || dismissed) return null;

  const resend = async () => {
    setSending(true);
    setSendError(false);
    setSent(false);
    try {
      const { error } = await resendVerificationEmail(user);
      if (error) {
        setSendError(true);
      } else {
        setSent(true);
      }
    } catch {
      // A silent failure must never look like success: show the honest error state instead.
      setSendError(true);
    } finally {
      setSending(false);
    }
  };

  const dismiss = () => {
    writeDismissed();
  };

  return (
    <div role="status" className="flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-2">
      <span>
        Verify your email. We sent a link to {user.email}. Until you verify, password recovery for
        this account will not work.
      </span>
      {sent && <span className="font-medium">Sent.</span>}
      {sendError && <span className="font-medium text-red-700">Could not send the email. Try again.</span>}
      {!sent && (
        <button type="button" onClick={resend} disabled={sending} className="underline font-medium disabled:opacity-50">
          Resend
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="ml-auto font-medium">
        Dismiss
      </button>
    </div>
  );
}
