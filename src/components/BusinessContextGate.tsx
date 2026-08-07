"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";
import { getSession, listMemberships } from "@/lib/auth";
import { getSelectedBusinessId, isFirebaseBackend } from "@/lib/selectedBusiness";
import { isLiveAuth } from "@/services/auth/authMode";
import { hasMeaningfulLegacyBlobAsync, hasPersistedBlobAsync, persistKeyForUid } from "@/stores/scanPersistNamespace";

// Bounded wait for the bootstrap chain's own async steps (getSession's onAuthStateChanged wait,
// listMemberships' getDocs). Firebase Auth persistence restore / Firestore reads can hang
// indefinitely (IndexedDB lock contention, offline boot, a stuck first callback) with nothing
// thrown - this turns that silent hang into a visible, actionable timeout instead. Applied at the
// gate's call site only; getSession/listMemberships keep their existing contract for every other
// caller (notably AuthGuard).
const AUTH_BOOTSTRAP_TIMEOUT_MS = 15_000;

function withBootstrapTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}.`));
    }, AUTH_BOOTSTRAP_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// Wires the REAL signed-in business context into the scan/count workflow (live mode + Firebase backend).
// On mount it resolves the authenticated user + the selected business and verifies a real membership.
// If this browser still holds the pre-account legacy blob (sis-scan-v1) and the user has no per-uid
// key yet, it STOPS and asks the owner whether to adopt that data - adoption is an explicit choice,
// never an automatic first-sign-in inheritance (shared-browser hazard). Then it re-points persist to
// the per-uid key and calls setBusinessContext exactly once. The mock path renders children directly.
// Any failure or unbounded wait in this chain surfaces as an honest error with a Retry affordance
// (never a silent hang, never a fallback into a wrong business context).
export function BusinessContextGate({ children }: { children: React.ReactNode }) {
  const cloud = isLiveAuth() && isFirebaseBackend();
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);
  const setBusinessContext = useScanStore((s) => s.setBusinessContext);
  const [status, setStatus] = useState<"resolving" | "no-user" | "no-business" | "adopt-choice" | "ready" | "error">("resolving");
  const [pendingCtx, setPendingCtx] = useState<{ businessId: string; uid: string } | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!cloud) return; // mock/local path: nothing to wire (context + data already "ready")
    let active = true;
    void (async () => {
      try {
        const user = await withBootstrapTimeout(getSession(), "sign-in status");
        if (!active) return;
        if (!user) { setStatus("no-user"); return; }

        const selected = getSelectedBusinessId();
        const memberships = await withBootstrapTimeout(listMemberships(), "your businesses");
        if (!active) return;
        const membership = selected ? memberships.find((m) => m.businessId === selected) : undefined;
        if (!membership) { setStatus("no-business"); return; }

        // Legacy pre-account data on this browser + no per-uid key yet: the OWNER decides.
        const legacy = typeof window !== "undefined" && (await hasMeaningfulLegacyBlobAsync());
        const alreadyOwn =
          typeof window !== "undefined" && (await hasPersistedBlobAsync(persistKeyForUid(user.uid)));
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
      } catch {
        // Never fall open into a wrong business context: surface an honest error and let the
        // owner retry instead of silently hanging on "Loading business data..." forever.
        if (active) setStatus("error");
      }
    })();
    return () => { active = false; };
  }, [cloud, setBusinessContext, retryToken]);

  if (!cloud) return <>{children}</>;

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

  if (status === "error") {
    return (
      <div data-testid="business-context-error" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
        We could not load your business data. This is usually temporary.
        <div className="mt-2">
          <button
            type="button"
            data-testid="retry-bootstrap"
            onClick={() => {
              setStatus("resolving");
              setRetryToken((t) => t + 1);
            }}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-3 font-medium text-white hover:bg-red-700"
          >
            Try again
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
