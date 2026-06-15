"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { isAuthed } from "@/lib/auth";

// Client-side gate for protected pages. Reads the local demo auth flag in an SSR-safe way
// (server snapshot is always false) and redirects to /login when absent. Using
// useSyncExternalStore avoids setState-in-effect cascading renders.
const noopSubscribe = () => () => {};

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const authed = useSyncExternalStore(
    noopSubscribe,
    () => isAuthed(), // client snapshot
    () => false, // server snapshot
  );

  useEffect(() => {
    if (!authed) router.replace("/login");
  }, [authed, router]);

  if (!authed) return null;
  return <>{children}</>;
}
