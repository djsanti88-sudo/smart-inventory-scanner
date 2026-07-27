"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createBusiness,
  ensureWorkspace,
  listMemberships,
  signOut,
  type Membership,
} from "@/lib/auth";
import { setSelectedBusinessId } from "@/lib/selectedBusiness";
import { useRouter } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";

// Business-creation + membership flow. A signed-in user sees the businesses they belong to (with their
// admin/counter role) and can create a new business (becoming its admin via the hardened RPC). This is
// the foundation; Phase 2 wires the selected business into the live scan/count workflow.
export default function BusinessPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setMemberships(await listMemberships());
    } catch {
      setLoadError("We could not load your businesses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    listMemberships()
      .then((nextMemberships) => {
        if (active) setMemberships(nextMemberships);
      })
      .catch(() => {
        if (active) setLoadError("We could not load your businesses.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Enter a business name.");
      return;
    }
    setBusy(true);
    const { error: err } = await createBusiness(name.trim());
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setName("");
    await refresh();
  }

  async function handleRepairWorkspace() {
    setBusy(true);
    setError("");
    const result = await ensureWorkspace();
    if (result.status === "ready") {
      await refresh();
    } else if (result.status === "selection_required") {
      await refresh();
    } else if (result.status !== "cancelled") {
      setError(result.error);
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Your businesses</h1>
        <button
          onClick={async () => {
            // F1: attempt one awaited drain first, then warn HONESTLY if unsynced work would be lost.
            const left = await useScanStore.getState().prepareSignOut();
            const message =
              left === 0
                ? "Log out now? Your counts are saved - you can sign back in any time to keep going."
                : `${left} scan${left === 1 ? "" : "s"} could not sync to the cloud yet. Signing out now will discard ${left === 1 ? "it" : "them"} permanently. Sign out anyway?`;
            if (!window.confirm(message)) return; // cancel aborts sign-out entirely: no reset, no signOut
            useScanStore.getState().resetForSignOut();
            await signOut();
            router.replace("/login");
          }}
          className="text-sm text-zinc-500 hover:underline"
          data-testid="sign-out"
        >
          Sign out
        </button>
      </div>

      <ul className="mt-4 space-y-2" data-testid="membership-list">
        {loading && <li className="text-sm text-zinc-400">Loading...</li>}
        {!loading && loadError && (
          <li className="text-sm text-red-600" data-testid="business-load-error">
            {loadError}{" "}
            <button
              type="button"
              onClick={refresh}
              data-testid="retry-business-load"
              className="font-semibold text-blue-700 hover:underline"
            >
              Try again
            </button>
          </li>
        )}
        {!loading && !loadError && memberships.length === 0 && (
          <li className="text-sm text-zinc-500">
            No businesses yet.{" "}
            <button
              type="button"
              onClick={handleRepairWorkspace}
              disabled={busy}
              data-testid="repair-workspace"
              className="font-semibold text-blue-700 hover:underline disabled:opacity-50"
            >
              Set up my workspace
            </button>
          </li>
        )}
        {memberships.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-3">
            <span className="text-sm font-medium text-zinc-800">{m.businessName}</span>
            <span className="flex items-center gap-2">
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">{m.role}</span>
              <button
                type="button"
                data-testid={`select-business-${m.businessId}`}
                onClick={() => { setSelectedBusinessId(m.businessId); router.push("/scan"); }}
                className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Select
              </button>
            </span>
          </li>
        ))}
      </ul>

      <form onSubmit={handleCreate} className="mt-6 rounded-xl border border-zinc-200 bg-white p-4">
        <label className="block text-sm font-medium text-zinc-700" htmlFor="business-name">New business name</label>
        <div className="mt-1 flex gap-2">
          <input
            id="business-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="business-name"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            placeholder="e.g. Main Street Auto"
          />
          <button
            type="submit"
            disabled={busy}
            data-testid="create-business"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600" data-testid="business-error">{error}</p>}
        <p className="mt-2 text-xs text-zinc-400">You become the owner of any business you create.</p>
      </form>
    </div>
  );
}
