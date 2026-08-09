"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { resendVerificationEmail } from "@/lib/auth";

const DISMISS_KEY = "sis-verify-banner-dismissed";

/** Non-blocking email-verification nudge. Shows ONLY for password-provider users whose email is
 *  unverified. Never gates any route or the scan flow (TOP-LEVEL LAW). Dumb component: the caller
 *  passes the current user from the app's existing auth state source. */
export function EmailVerifyBanner({ user }: { user: User | null }) {
  // Read the session dismiss flag in an effect, not a useState initializer: an initializer runs
  // during the very first render (including SSR/hydration), so reading storage there can produce
  // a hydration mismatch flash. The effect runs after mount, client-side only.
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
    } catch {
      /* no persisted dismiss available; default (not dismissed) still applies */
    }
  }, []);

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
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* session-only dismiss still works in memory */
    }
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
