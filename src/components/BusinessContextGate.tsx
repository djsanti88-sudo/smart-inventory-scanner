"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";
import { getSession, listMemberships } from "@/lib/auth";
import {
  getSelectedBusinessId,
  isFirebaseBackend,
  SELECTED_BUSINESS_CHANGED_EVENT,
} from "@/lib/selectedBusiness";
import { isLiveAuth } from "@/services/auth/authMode";
import { hasMeaningfulLegacyBlobAsync, hasPersistedBlobAsync, persistKeyForUid } from "@/stores/scanPersistNamespace";

// Bounded wait for the bootstrap chain's own async steps (getSession's onAuthStateChanged wait,
// listMemberships' getDocs). Firebase Auth persistence restore / Firestore reads can hang
// indefinitely (IndexedDB lock contention, offline boot, a stuck first callback) with nothing
// thrown - this turns that silent hang into a visible, actionable timeout instead. Applied at the
// gate's call site only; getSession/listMemberships keep their existing contract for every other
// caller (notably AuthGuard).
const AUTH_BOOTSTRAP_TIMEOUT_MS = 15_000;

type BusinessContextStatus = "resolving" | "no-user" | "no-business" | "adopt-choice" | "ready" | "error";
type PendingBusinessContext = { businessId: string; uid: string };
type AdoptStatus = "idle" | "adopting" | "error" | "error-postcopy";

type BusinessContextValue = {
  cloud: boolean;
  status: BusinessContextStatus;
  pendingCtx: PendingBusinessContext | null;
  adoptStatus: AdoptStatus;
  retryBootstrap: () => void;
  runAdopt: () => Promise<void>;
  skipAdopt: () => Promise<void>;
};

const BusinessContext = createContext<BusinessContextValue | null>(null);

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
// (never a silent hang, never a fallback into a wrong business context). Mount this provider once in
// the protected app layout so page-to-page navigation does not re-run authenticated bootstrap.
export function BusinessContextProvider({ children }: { children: React.ReactNode }) {
  const cloud = isLiveAuth() && isFirebaseBackend();
  const setBusinessContext = useScanStore((s) => s.setBusinessContext);
  const [status, setStatus] = useState<BusinessContextStatus>("resolving");
  const [pendingCtx, setPendingCtx] = useState<PendingBusinessContext | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // B4 fix (owner-reported false-safety copy, 2026-08-09): "error" means the copy never landed (the
  // anon blob is untouched - both "try again" and "start fresh" are safe). "error-postcopy" means the
  // copy DID land before something else failed (scanStore tags this via postCopyAdoptFailure) - the
  // anon blob is gone and the per-uid key already holds the adopted data, so "start fresh" must not be
  // offered (it would silently discard nothing and just re-point at the already-adopted data, which
  // looks like data loss to an owner who picked "start fresh" expecting an empty namespace).
  const [adoptStatus, setAdoptStatus] = useState<AdoptStatus>("idle");

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
        const membership = selected ? memberships.find((m) => m.businessId === selected && m.userId === user.uid) : undefined;
        if (!membership) { setStatus("no-business"); return; }

        // Legacy pre-account data on this browser + no per-uid key yet: the OWNER decides.
        const legacy = typeof window !== "undefined" && (await hasMeaningfulLegacyBlobAsync());
        const alreadyOwn =
          typeof window !== "undefined" && (await hasPersistedBlobAsync(persistKeyForUid(user.uid)));
        if (legacy && !alreadyOwn) {
          setPendingCtx({ businessId: membership.businessId, uid: user.uid });
          setAdoptStatus("idle");
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

  useEffect(() => {
    if (!cloud || typeof window === "undefined") return;
    const rebootstrap = () => {
      setStatus("resolving");
      setPendingCtx(null);
      setAdoptStatus("idle");
      setRetryToken((t) => t + 1);
    };
    window.addEventListener(SELECTED_BUSINESS_CHANGED_EVENT, rebootstrap);
    return () => {
      window.removeEventListener(SELECTED_BUSINESS_CHANGED_EVENT, rebootstrap);
    };
  }, [cloud]);

  const runAdopt = useCallback(async () => {
    if (!pendingCtx) return;
    setAdoptStatus("adopting");
    // F5: the thrown error's tag alone left the post-copy window one line too narrow. Once
    // adoptLegacyLocalData RESOLVES the copy has landed and the anon blob is already gone, so
    // anything that throws after that point (setBusinessContext) is just as post-copy as a tagged
    // failure from inside the store - and must not get the pre-copy "still safe" + Start fresh UI.
    let copied = false;
    try {
      await useScanStore.getState().adoptLegacyLocalData(pendingCtx.uid);
      copied = true;
      setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
      setStatus("ready");
    } catch (err) {
      // Duck-typed (not instanceof) so this never depends on importing a class from scanStore -
      // keeps this check robust across the store's various test mocks.
      const tagged = !!(err && typeof err === "object" && (err as { postCopyAdoptFailure?: boolean }).postCopyAdoptFailure);
      if (copied || tagged) {
        // The anon blob is ALREADY GONE and the per-uid key already holds the adopted data: never
        // claim "your local data is still safe" and never offer "start fresh" here (see state note
        // above). Retry (re-running adoptLegacyLocalData) is idempotent and the only safe path.
        setAdoptStatus("error-postcopy");
      } else {
        // The anon blob is untouched by design on a failed copy: never discard it and never
        // silently fall through to a fresh empty namespace. Let the owner retry or start fresh.
        setAdoptStatus("error");
      }
    }
  }, [pendingCtx, setBusinessContext]);

  const skipAdopt = useCallback(async () => {
    if (!pendingCtx) return;
    await useScanStore.getState().rehydrateForUid(pendingCtx.uid);
    setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
    setStatus("ready");
  }, [pendingCtx, setBusinessContext]);

  const retryBootstrap = useCallback(() => {
    setStatus("resolving");
    setRetryToken((t) => t + 1);
  }, []);

  return (
    <BusinessContext.Provider value={{ cloud, status, pendingCtx, adoptStatus, retryBootstrap, runAdopt, skipAdopt }}>
      {children}
    </BusinessContext.Provider>
  );
}

// Page-level renderer for the provider's validated status. If a test or isolated page mounts the
// gate without the protected layout provider, keep the old self-contained behavior by wrapping it.
export function BusinessContextGate({ children }: { children: React.ReactNode }) {
  const provider = useContext(BusinessContext);
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);

  if (!provider) {
    return (
      <BusinessContextProvider>
        <BusinessContextGate>{children}</BusinessContextGate>
      </BusinessContextProvider>
    );
  }

  const { cloud, status, pendingCtx, adoptStatus, retryBootstrap, runAdopt, skipAdopt } = provider;

  if (!cloud) return <>{children}</>;

  if (status === "adopt-choice" && pendingCtx) {
    return (
      <div data-testid="adopt-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        This device has local scan data saved from before sign-in. Adopt it into your account, or leave it and start fresh.
        {adoptStatus === "error" && (
          <div data-testid="adopt-error" className="mt-2 text-red-700">
            We could not adopt that data. Your local data is still safe on this device. Try again, or start fresh instead.
          </div>
        )}
        {adoptStatus === "error-postcopy" && (
          <div data-testid="adopt-error-postcopy" className="mt-2 text-red-700">
            Your data was copied to your account but finishing setup failed. Try again.
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-testid={adoptStatus === "error" || adoptStatus === "error-postcopy" ? "retry-adopt" : "adopt-data"}
            disabled={adoptStatus === "adopting"}
            onClick={runAdopt}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-amber-600 px-3 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {adoptStatus === "adopting"
              ? "Adopting..."
              : adoptStatus === "error" || adoptStatus === "error-postcopy"
                ? "Try again"
                : "Adopt it into my account"}
          </button>
          {adoptStatus !== "error-postcopy" && (
            <button
              type="button"
              data-testid="skip-adopt"
              disabled={adoptStatus === "adopting"}
              onClick={skipAdopt}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-amber-400 px-3 font-medium hover:bg-amber-100 disabled:opacity-50"
            >
              Start fresh (leave it)
            </button>
          )}
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
            onClick={retryBootstrap}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-3 font-medium text-white hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (status === "resolving") {
    return (
      <div data-testid="business-loading" className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
        Loading business data...
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
