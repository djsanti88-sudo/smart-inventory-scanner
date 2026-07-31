"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";
import { getSession, listMemberships } from "@/lib/auth";
import { getSelectedBusinessId, isFirebaseBackend } from "@/lib/selectedBusiness";
import { isLiveAuth } from "@/services/auth/authMode";
import { hasLegacyBlob, persistKeyForUid } from "@/stores/scanPersistNamespace";

// Wires the REAL signed-in business context into the scan/count workflow (live mode + Firebase backend).
// On mount it resolves the authenticated user + the selected business and verifies a real membership.
// If this browser still holds the pre-account legacy blob (sis-scan-v1) and the user has no per-uid
// key yet, it STOPS and asks the owner whether to adopt that data - adoption is an explicit choice,
// never an automatic first-sign-in inheritance (shared-browser hazard). Then it re-points persist to
// the per-uid key and calls setBusinessContext exactly once. The mock path renders children directly.
export function BusinessContextGate({ children }: { children: React.ReactNode }) {
  const cloud = isLiveAuth() && isFirebaseBackend();
  const pathname = usePathname();
  const isBusinessSetupRoute = pathname === "/business";
  const bootstrapStarted = useRef(false);
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);
  const setBusinessContext = useScanStore((s) => s.setBusinessContext);
  const [status, setStatus] = useState<"resolving" | "no-user" | "no-business" | "adopt-choice" | "ready">("resolving");
  const [pendingCtx, setPendingCtx] = useState<{ businessId: string; uid: string } | null>(null);

  useEffect(() => {
    if (!cloud) return; // mock/local path: nothing to wire (context + data already "ready")
    // Business setup creates/selects the context this gate validates, so it must remain reachable.
    if (isBusinessSetupRoute) {
      bootstrapStarted.current = false;
      return;
    }
    // This client component lives in the shared (app) layout. Keep a resolved tenant across
    // sibling route changes; only returning from /business deliberately starts a new bootstrap.
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
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

      // Legacy pre-account data on this browser + no per-uid key yet: the OWNER decides.
      const legacy = typeof window !== "undefined" && hasLegacyBlob(window.localStorage);
      const alreadyOwn =
        typeof window !== "undefined" && window.localStorage.getItem(persistKeyForUid(user.uid)) !== null;
      if (legacy && !alreadyOwn) {
        setPendingCtx({ businessId: membership.businessId, uid: user.uid });
        setStatus("adopt-choice");
        return;
      }

      // Await rehydrate BEFORE setBusinessContext: only once the persisted per-uid state has loaded
      // does the store's businessId/userId reflect it, letting setBusinessContext's same-tenant guard
      // recognize a refresh (vs a real switch) and preserve scanFeed/finalCounts/needsReviewQueue.
      await useScanStore.getState().rehydrateForUid(user.uid);
      if (!active) return;
      setBusinessContext(membership.businessId, user.uid);
      setStatus("ready");
    })();
    return () => { active = false; };
  }, [cloud, isBusinessSetupRoute, setBusinessContext]);

  if (!cloud) return <>{children}</>;

  if (isBusinessSetupRoute) return <>{children}</>;

  if (status === "adopt-choice" && pendingCtx) {
    return (
      <div data-testid="adopt-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        This device has local scan data saved from before sign-in. Adopt it into your account, or leave it and start fresh.
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-testid="adopt-data"
            onClick={async () => {
              await useScanStore.getState().adoptLegacyLocalData(pendingCtx.uid);
              setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
              setStatus("ready");
            }}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-amber-600 px-3 font-medium text-white hover:bg-amber-700"
          >
            Adopt it into my account
          </button>
          <button
            type="button"
            data-testid="skip-adopt"
            onClick={async () => {
              await useScanStore.getState().rehydrateForUid(pendingCtx.uid);
              setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
              setStatus("ready");
            }}
            className="inline-flex min-h-[40px] items-center rounded-lg border border-amber-400 px-3 font-medium hover:bg-amber-100"
          >
            Start fresh (leave it)
          </button>
        </div>
      </div>
    );
  }

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
