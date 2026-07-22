"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, onAuthChange, isAuthBypassEnabled } from "@/lib/auth";
import { isOpenAccess } from "@/services/auth/authMode";

// Client-side gate for protected pages. In mock (open-access) mode children render immediately.
// In live mode it checks a real Firebase auth session (async) and redirects to /login when there is none.
// The E2E/test bypass keeps existing Playwright specs green and is impossible in production.

type GateState = "loading" | "authed" | "anon";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>(() =>
    isAuthBypassEnabled() || isOpenAccess() ? "authed" : "loading",
  );

  useEffect(() => {
    if (isAuthBypassEnabled() || isOpenAccess()) return;
    let active = true;
    getSession().then((s) => {
      if (active) setState(s ? "authed" : "anon");
    });
    const unsub = onAuthChange((s) => {
      if (active) setState(s ? "authed" : "anon");
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (state === "anon") router.replace("/login");
  }, [state, router]);

  if (state !== "authed") return null;
  return <>{children}</>;
}
