"use client";

import { useMemo, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { safeStructuredFieldsFor } from "@/services/polish/structuredFields";
import type { UnknownCodeReview } from "@/types";

// Build 3 (docs/superpowers/specs/2026-07-05-batch-approve-design.md): batch-approve screen for the
// Suggested pile. Trust rules do NOT change here - approving a row runs through the exact same
// resolveUnknown path as the single-row "Approve suggestion" button (see scanStore.batchApprove and
// NeedsReviewTable's "Approve suggestion"); a human still approves every suggestion, one click at a
// time or many at once. This screen lives on /review only - it never touches the scan flow.

function isSuggestedRow(r: UnknownCodeReview): boolean {
  // Task 9b (owner-ratified 2026-07-14): PENDING inline suggestions (status "suggested") surface here
  // too for end-of-session batch cleanup - approving one runs the exact same resolveUnknown core.
  return (r.status === "open" || r.status === "suggested") && r.hasSuggestion && !!r.suggestedProductName;
}

// Read-only preview of the Build 2 structured identity (brand/model/size), computed from the
// SUGGESTED name/brand. Deterministic + pure - nothing is written to the review or a product until
// the row is actually approved.
function StructuredPreview({ review }: { review: UnknownCodeReview }) {
  const s = safeStructuredFieldsFor(review.suggestedProductName, review.suggestedBrand);
  const chips = [
    s.structuredBrand ? { label: "Brand", value: s.structuredBrand } : null,
    s.structuredModel ? { label: "Model", value: s.structuredModel } : null,
    s.sizeTag ? { label: "Size", value: s.sizeTag } : null,
  ].filter(Boolean) as { label: string; value: string }[];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="structured-preview">
      {chips.map((c) => (
        <span key={c.label} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">
          {c.label}: {c.value}
        </span>
      ))}
    </div>
  );
}

export function SuggestedApprovalPanel() {
  const allReviews = useScanStore((s) => s.needsReviewQueue);
  const batchApprove = useScanStore((s) => s.batchApprove);
  const resolveUnknown = useScanStore((s) => s.resolveUnknown);
  const declineSuggestion = useScanStore((s) => s.declineSuggestion);
  const reopenNeedsReview = useScanStore((s) => s.reopenNeedsReview);
  const scanFeed = useScanStore((s) => s.scanFeed);
  const isPlatform = useIsPlatformOwner();

  const rows = useMemo(() => allReviews.filter(isSuggestedRow), [allReviews]);
  const [selected, setSelected] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<{ approved: string[]; failed: Array<{ id: string; reason: string }> } | null>(null);

  // A row that leaves the Suggested pile (approved/rejected elsewhere) can no longer be selected.
  const rowIds = new Set(rows.map((r) => r.id));
  const validSelected = selected.filter((id) => rowIds.has(id));
  const allSelected = rows.length > 0 && validSelected.length === rows.length;

  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => (on ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)));
  const toggleAll = (on: boolean) => setSelected(on ? rows.map((r) => r.id) : []);

  const handleApproveSelected = () => {
    const result = batchApprove(validSelected);
    setLastResult(result);
    setSelected([]);
  };

  const handleReject = (id: string) => {
    const r = allReviews.find((x) => x.id === id);
    if (r?.status === "suggested") {
      // Task 9b: rejecting a PENDING inline suggestion is the SAME decline action as the feed row's
      // ✕ control (floor rename + creates the open review). Fall back to reopenNeedsReview when the
      // feed row's suggestion field is gone (e.g. after a customer reload, which persists the review
      // but strips the scan event's suggestion field).
      const ev = scanFeed.find(
        (e) =>
          e.suggestion?.status === "pending" &&
          ((e.cleanCode && e.cleanCode === r.cleanCode) ||
            (e.matchedProductId && e.matchedProductId === r.provisionalProductId)),
      );
      if (ev) declineSuggestion(ev.id);
      else reopenNeedsReview(r.cleanCode, "Suggestion declined by operator - needs a correct name");
    } else {
      resolveUnknown(id, "ignore", {});
    }
    setSelected((prev) => prev.filter((x) => x !== id));
  };

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white" data-testid="suggested-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Suggested products</h2>
          <p className="text-sm text-zinc-700">
            Select the ones that look right and approve them all at once. Each approval works exactly
            like confirming one at a time - it saves the product, learns the barcode, and counts it once.
          </p>
        </div>
        <button
          type="button"
          data-testid="approve-selected"
          onClick={handleApproveSelected}
          disabled={validSelected.length === 0}
          className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Approve selected ({validSelected.length})
        </button>
      </div>

      {lastResult && (
        <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm" data-testid="batch-approve-result">
          <p className="text-zinc-800">Approved {lastResult.approved.length} product(s).</p>
          {lastResult.failed.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-red-700" data-testid="batch-approve-failed">
              {lastResult.failed.map((f) => {
                const row = allReviews.find((r) => r.id === f.id);
                return (
                  <li key={f.id}>
                    {row?.cleanCode ?? f.id}: {f.reason}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-base">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th scope="col" className="px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="select all suggested rows"
                  data-testid="suggested-select-all"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="h-5 w-5 rounded"
                />
              </th>
              {isPlatform && <th scope="col" className="px-4 py-3">Code</th>}
              <th scope="col" className="px-4 py-3">Product</th>
              <th scope="col" className="px-4 py-3">Confidence</th>
              <th scope="col" className="px-4 py-3">Sources</th>
              <th scope="col" className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="suggested-body">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 6 : 5} className="px-4 py-6 text-center text-base text-zinc-600">
                  Nothing suggested right now. New suggestions will show up here for a quick batch approval.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const winningSource = r.sourceUrls?.[0];
                return (
                  <tr
                    key={r.id}
                    className="border-t border-zinc-100 align-top hover:bg-zinc-50"
                    data-testid={`suggested-row-${r.cleanCode}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`select ${r.suggestedProductName}`}
                        data-testid={`suggested-checkbox-${r.cleanCode}`}
                        checked={validSelected.includes(r.id)}
                        onChange={(e) => toggleOne(r.id, e.target.checked)}
                        className="h-5 w-5 rounded"
                      />
                    </td>
                    {isPlatform && <td className="px-4 py-3 font-mono text-sm">{r.cleanCode}</td>}
                    <td className="max-w-64 px-4 py-3 text-sm">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-zinc-800">
                          {r.suggestedProductName}
                          {r.suggestedBrand ? ` - ${r.suggestedBrand}` : ""}
                        </span>
                        <StructuredPreview review={r} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums" data-testid="suggested-confidence">
                      {r.confidence > 0 ? `${Math.round(r.confidence * 100)}%` : "-"}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span data-testid="suggested-source-count">{r.sourceUrls?.length ?? 0}</span>
                      {winningSource ? (
                        <>
                          {" "}
                          <a
                            href={winningSource}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline"
                          >
                            view source
                          </a>
                        </>
                      ) : (
                        // Finding 3 (Build 3 review): a row with zero sourceUrls carries no evidence at all.
                        // Flag it visibly so a bulk approver can spot and skip it instead of approving an
                        // evidence-free row along with the rest.
                        <span
                          data-testid={`suggested-no-sources-${r.cleanCode}`}
                          className="ml-1 font-medium text-amber-700"
                        >
                          No sources
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        data-testid={`reject-suggestion-${r.cleanCode}`}
                        onClick={() => handleReject(r.id)}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
