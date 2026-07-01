"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, onAuthChange, isAuthBypassEnabled } from "@/lib/auth";

// Client-side gate for protected pages. Checks a real Firebase auth session (async) and redirects to /login
// when there is none. The E2E/test bypass (isAuthBypassEnabled) keeps existing Playwright specs green
// and is impossible in production.
//
// Open access by default until login is re-enabled. Set NEXT_PUBLIC_REQUIRE_LOGIN=1 to restore the
// login wall. This does NOT remove any login code — it's a reversible flag.
const OPEN_ACCESS = process.env.NEXT_PUBLIC_REQUIRE_LOGIN !== "1";

type GateState = "loading" | "authed" | "anon";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // Lazy initial state: bypass resolves to "authed" at first render (pure env read, SSR-consistent), so
  // we never call setState synchronously inside the effect (react-hooks/set-state-in-effect).
  const [state, setState] = useState<GateState>(() => (isAuthBypassEnabled() || OPEN_ACCESS ? "authed" : "loading"));

  useEffect(() => {
    if (isAuthBypassEnabled() || OPEN_ACCESS) return;
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
