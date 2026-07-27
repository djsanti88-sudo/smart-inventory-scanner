"use client";

import { useCallback, useEffect, useState } from "react";
import { getSession } from "@/lib/auth";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";

// Task 3 (owner step 3): platform-owner-only review queue for pending catalogEntries (the shared,
// cross-tenant master catalog). Approve marks an entry human_verified; Reject marks it rejected. Both
// call the server route (/api/catalog-review/[id]), which re-verifies platformOwner server-side - this
// client gate is a UI convenience only, never the source of truth.

interface PendingEntry {
  id: string;
  normalizedBarcode?: string;
  barcode?: string;
  name?: string;
  brand?: string;
  size?: string;
  description?: string;
  confidence?: number;
  evidenceSummary?: string;
  firstSeenAt?: string;
}

interface ListResponse {
  entries?: PendingEntry[];
  nextCursor?: string | null;
  error?: string;
}

async function authHeaders(): Promise<HeadersInit> {
  const user = await getSession();
  if (!user) throw new Error("Sign in required.");
  const idToken = await user.getIdToken();
  return { Authorization: `Bearer ${idToken}` };
}

function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return "-";
  return `${Math.round(confidence * 100)}%`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function CatalogReviewTable() {
  const isPlatform = useIsPlatformOwner();
  const [entries, setEntries] = useState<PendingEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<Record<string, "approve" | "reject" | undefined>>({});
  const [actionError, setActionError] = useState<Record<string, string | undefined>>({});

  const load = useCallback(async (opts: { cursor?: string | null; barcode?: string } = {}) => {
    setLoading(true);
    setLoadError(null);
    try {
      const headers = await authHeaders();
      const params = new URLSearchParams();
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.barcode) params.set("barcode", opts.barcode);
      const response = await fetch(`/api/catalog-review?${params.toString()}`, { headers, cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as ListResponse;
      if (!response.ok) {
        setLoadError(body.error ?? "Could not load pending catalog entries.");
        setEntries([]);
        setCursor(null);
        return;
      }
      if (opts.cursor) {
        setEntries((prev) => [...prev, ...(body.entries ?? [])]);
      } else {
        setEntries(body.entries ?? []);
      }
      setCursor(body.nextCursor ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load pending catalog entries.");
      setEntries([]);
      setCursor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isPlatform) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlatform]);

  async function runAction(id: string, action: "approve" | "reject") {
    setPendingAction((prev) => ({ ...prev, [id]: action }));
    setActionError((prev) => ({ ...prev, [id]: undefined }));
    try {
      const headers = await authHeaders();
      const user = await getSession();
      const idToken = user ? await user.getIdToken() : "";
      const response = await fetch(`/api/catalog-review/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, action }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setActionError((prev) => ({ ...prev, [id]: body.error ?? "Action failed." }));
        return;
      }
      // Approved/rejected entries leave the pending list immediately.
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (error) {
      setActionError((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : "Action failed." }));
    } finally {
      setPendingAction((prev) => ({ ...prev, [id]: undefined }));
    }
  }

  if (!isPlatform) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600" data-testid="catalog-review-forbidden">
        This page is only available to the platform owner.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load({ barcode: search.trim() || undefined });
        }}
      >
        <input
          aria-label="search by barcode"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by barcode"
          className="min-h-[44px] w-64 rounded-lg border border-zinc-300 px-3 text-base"
          data-testid="catalog-review-search"
        />
        <button
          type="submit"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          data-testid="catalog-review-search-submit"
        >
          Search
        </button>
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              void load();
            }}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Clear
          </button>
        )}
      </form>

      {loadError && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid="catalog-review-error">
          {loadError}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[64rem] border-collapse text-left text-sm" data-testid="catalog-review-table">
          <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
            <tr>
              <th className="px-4 py-2">Barcode</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Brand</th>
              <th className="px-4 py-2">Size / specs</th>
              <th className="px-4 py-2">Confidence</th>
              <th className="px-4 py-2">Evidence summary</th>
              <th className="px-4 py-2">First seen</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="catalog-review-body">
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-zinc-500" data-testid="catalog-review-loading">
                  Loading pending catalog entries...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-zinc-500" data-testid="catalog-review-empty">
                  No pending catalog entries. Everything has been reviewed.
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const acting = pendingAction[entry.id];
                const rowError = actionError[entry.id];
                return (
                  <tr key={entry.id} className="border-t border-zinc-100 align-top hover:bg-zinc-50" data-testid={`catalog-review-row-${entry.id}`}>
                    <td className="px-4 py-2 font-mono">{entry.normalizedBarcode || entry.barcode || "-"}</td>
                    <td className="px-4 py-2">{entry.name || "-"}</td>
                    <td className="px-4 py-2">{entry.brand || "-"}</td>
                    <td className="px-4 py-2">{entry.size || entry.description || "-"}</td>
                    <td className="px-4 py-2">{formatConfidence(entry.confidence)}</td>
                    <td className="max-w-64 px-4 py-2 text-zinc-600">{entry.evidenceSummary || "-"}</td>
                    <td className="whitespace-nowrap px-4 py-2">{formatDate(entry.firstSeenAt)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            data-testid={`catalog-review-approve-${entry.id}`}
                            disabled={!!acting}
                            onClick={() => void runAction(entry.id, "approve")}
                            className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            data-testid={`catalog-review-reject-${entry.id}`}
                            disabled={!!acting}
                            onClick={() => void runAction(entry.id, "reject")}
                            className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-3 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-40"
                          >
                            Reject
                          </button>
                        </div>
                        {rowError && (
                          <span className="text-xs text-red-700" data-testid={`catalog-review-row-error-${entry.id}`}>
                            {rowError}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {cursor && (
        <button
          type="button"
          data-testid="catalog-review-load-more"
          disabled={loading}
          onClick={() => void load({ cursor })}
          className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          {loading ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}
