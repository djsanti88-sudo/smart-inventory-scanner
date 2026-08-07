"use client";

import { useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import type { User } from "firebase/auth";

const DISMISS_KEY = "sis-verify-banner-dismissed";

/** Non-blocking email-verification nudge. Shows ONLY for password-provider users whose email is
 *  unverified. Never gates any route or the scan flow (TOP-LEVEL LAW). Dumb component: the caller
 *  passes the current user from the app's existing auth state source. */
export function EmailVerifyBanner({ user }: { user: User | null }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  const isUnverifiedPasswordUser =
    !!user &&
    !user.emailVerified &&
    user.providerData.some((p) => p.providerId === "password");

  if (!isUnverifiedPasswordUser || dismissed) return null;

  const resend = async () => {
    setSending(true);
    try {
      await sendEmailVerification(user);
      setSent(true);
    } catch {
      setSent(true);
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
      {sent ? (
        <span className="font-medium">Sent.</span>
      ) : (
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
