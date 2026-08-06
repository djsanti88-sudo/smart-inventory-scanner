"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { getSession, onAuthChange, isAuthBypassEnabled } from "@/lib/auth";
import { isOpenAccess } from "@/services/auth/authMode";

// Client-side gate for protected pages. In mock (open-access) mode children render immediately.
// In live mode it checks a real Firebase auth session (async) and redirects to /login when there is none.
// The E2E/test bypass keeps existing Playwright specs green and is impossible in production.

type GateState = "loading" | "authed" | "anon";

// Bounded wait mirroring BusinessContextGate's AUTH_BOOTSTRAP_TIMEOUT_MS (src/components/
// BusinessContextGate.tsx). getSession()'s onAuthStateChanged wait can hang indefinitely
// (IndexedDB lock contention, offline boot, a stuck first callback). If getSession() has not
// settled by this deadline, fall back to whatever onAuthChange has reported in the meantime (or
// "anon" if nothing has arrived yet) instead of leaving the guard rendering null forever.
const AUTH_GUARD_SETTLE_TIMEOUT_MS = 15_000;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<GateState>(() =>
    isAuthBypassEnabled() || isOpenAccess() ? "authed" : "loading",
  );

  useEffect(() => {
    if (isAuthBypassEnabled() || isOpenAccess()) return;
    let active = true;
    // getSession() awaits Firebase's own onAuthStateChanged restore signal. onAuthChange is a
    // second, independent subscription that can receive an ambiguous pre-restore tick before
    // getSession settles. Ignore onAuthChange updates until getSession has resolved at least
    // once so a stray early null cannot flip this guard to "anon" and bounce a deep link before
    // the real (restored) auth state is known. Still track the latest onAuthChange value so the
    // bounded settle timeout below has something to fall back on if getSession never resolves.
    let initialSettled = false;
    let latestFromAuthChange: GateState | null = null;

    getSession().then((s) => {
      initialSettled = true;
      if (active) setState(s ? "authed" : "anon");
    });
    const unsub = onAuthChange((s) => {
      latestFromAuthChange = s ? "authed" : "anon";
      if (!active || !initialSettled) return;
      setState(latestFromAuthChange);
    });
    const settleTimer = setTimeout(() => {
      if (!active || initialSettled) return;
      // getSession() has stalled past the deadline: never hang forever on "loading". Use the
      // latest onAuthChange signal if one arrived, otherwise treat as anon (redirects to /login).
      initialSettled = true;
      setState(latestFromAuthChange ?? "anon");
    }, AUTH_GUARD_SETTLE_TIMEOUT_MS);

    return () => {
      active = false;
      clearTimeout(settleTimer);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (state === "anon") {
      const returnTo = pathname ? `?returnTo=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${returnTo}`);
    }
  }, [state, router, pathname]);

  if (state !== "authed") return null;
  return <>{children}</>;
}
