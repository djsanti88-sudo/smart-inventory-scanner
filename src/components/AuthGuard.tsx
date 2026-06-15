"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, onAuthChange, isAuthBypassEnabled } from "@/lib/auth";

// Client-side gate for protected pages. Checks a real Supabase session (async) and redirects to /login
// when there is none. The E2E/test bypass (isAuthBypassEnabled) keeps existing Playwright specs green
// and is impossible in production.

type GateState = "loading" | "authed" | "anon";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // Lazy initial state: bypass resolves to "authed" at first render (pure env read, SSR-consistent), so
  // we never call setState synchronously inside the effect (react-hooks/set-state-in-effect).
  const [state, setState] = useState<GateState>(() => (isAuthBypassEnabled() ? "authed" : "loading"));

  useEffect(() => {
    if (isAuthBypassEnabled()) return;
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
