"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";
import { getSession, listMemberships } from "@/lib/auth";
import { getSelectedBusinessId, isFirebaseBackend } from "@/lib/selectedBusiness";

// Wires the REAL signed-in business context into the scan/count workflow (Firebase backend only).
// On mount it resolves the authenticated user + the selected business and verifies a real membership,
// then calls setBusinessContext(businessId, userId) exactly once. No fake/default businessId or userId
// is ever used. It renders the scan UI only once the business's data has loaded (so a scan never runs
// against an empty catalog); otherwise it shows a clear message. The mock/local path is untouched
// (renders children directly). This is mount-time wiring only - it does NOT touch the scanner hot path,
// decode, barcode buffer, cache, Firecrawl, or count idempotency.
export function BusinessContextGate({ children }: { children: React.ReactNode }) {
  const cloud = isFirebaseBackend();
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);
  const setBusinessContext = useScanStore((s) => s.setBusinessContext);
  const [status, setStatus] = useState<"resolving" | "no-user" | "no-business" | "ready">("resolving");

  useEffect(() => {
    if (!cloud) return; // mock/local path: nothing to wire (context + data already "ready")
    let active = true;
    void (async () => {
      const user = await getSession();
      if (!active) return;
      if (!user) { setStatus("no-user"); return; }

      const selected = getSelectedBusinessId();
      const memberships = await listMemberships();
      if (!active) return;
      const membership = selected ? memberships.find((m) => m.businessId === selected) : undefined;
      if (!membership) { setStatus("no-business"); return; }

      // Real authenticated user + real membership -> safe to set the context.
      setBusinessContext(membership.businessId, user.uid);
      setStatus("ready");
    })();
    return () => { active = false; };
  }, [cloud, setBusinessContext]);

  if (!cloud) return <>{children}</>;

  // Needs a signed-in user or a selected business: a clear, actionable message (no fake context).
  if (status === "no-user" || status === "no-business") {
    return (
      <div data-testid="business-context-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {status === "no-user" ? (
          <>You are not signed in. <Link href="/login" className="font-medium underline">Sign in</Link> to sync to the cloud.</>
        ) : (
          <>Select or create a business before Firebase sync can run.{" "}
            <Link href="/business" className="font-medium underline" data-testid="go-to-business">Choose a business</Link>.</>
        )}
      </div>
    );
  }

  // Context set but the business's data is still loading: show a status, do not let a scan run yet.
  if (!businessContextReady || !businessDataLoaded) {
    return (
      <div data-testid="business-loading" className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
        Loading business data...
      </div>
    );
  }

  return <>{children}</>;
}
