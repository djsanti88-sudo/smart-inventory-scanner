"use client";

import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { DecodeStatusBadge, MatchBadge, StatusBadge, SyncBadge } from "@/components/badges";

// Raw live scan feed: every scan event in order, newest first. Keeps the full audit trail. Raw/clean
// codes AND the internal match type are platformOwner-only; customers see the product name + part number
// and the scan status of each scan, never the code strings or how the code matched internally.
export function LiveScanFeed() {
  const scanFeed = useScanStore((s) => s.scanFeed);
  const getProduct = useScanStore((s) => s.getProduct);
  const needsReviewQueue = useScanStore((s) => s.needsReviewQueue);
  const isPlatform = useIsPlatformOwner();
  // The "Barcode" column shows the code the user JUST scanned (their own in-memory scan, never persisted
  // for customers and never the catalog/alias database) - visible to ALL roles. Raw code + Match remain
  // platformOwner-only. Customer columns: Time, Barcode, Product, SKU, Qty, Status, Reason, Sync = 8.
  const colSpan = isPlatform ? 10 : 8;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="text-lg font-semibold text-zinc-900">What you just scanned</h2>
        <span className="text-sm text-zinc-600">{scanFeed.length} events</span>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse text-left text-base">
          <thead className="sticky top-0 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th className="px-3 py-2">Time</th>
              {isPlatform && <th className="px-3 py-2">Raw code</th>}
              <th className="px-3 py-2">Barcode</th>
              {isPlatform && <th className="px-3 py-2">Match</th>}
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">{isPlatform ? "SKU" : "Part number"}</th>
              <th className="px-3 py-2">Qty after</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Saved</th>
            </tr>
          </thead>
          <tbody data-testid="scan-feed-body">
            {scanFeed.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-3 py-6 text-center text-base text-zinc-600">
                  No scans yet. Click the scan box and scan a code.
                </td>
              </tr>
            ) : (
              scanFeed.map((e) => {
                const product = getProduct(e.matchedProductId);
                // PHASE 1 (Suggested display): for a scan that did NOT count (no matched product), surface the
                // decoded SUGGESTION from its Needs Review item so the row shows the product name instead of
                // "-". This is read-only display: the row still reads "Suggested", Qty stays "-", and nothing
                // is counted, aliased, or verified here.
                const suggestion = product
                  ? undefined
                  : needsReviewQueue.find((r) => r.cleanCode === e.cleanCode && r.suggestedProductName);
                const displayName = product?.name ?? suggestion?.suggestedProductName ?? "-";
                const displaySku = product?.primarySku || suggestion?.suggestedPrimarySku || "-";
                const isSuggestionOnly = !product && !!suggestion?.suggestedProductName;
                return (
                  <tr key={e.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "-"}
                    </td>
                    {isPlatform && <td className="px-3 py-2 font-mono text-xs">{e.rawCode}</td>}
                    <td className="px-3 py-2 font-mono text-xs" data-testid={`feed-barcode-${e.id}`}>{e.cleanCode || "-"}</td>
                    {isPlatform && (
                      <td className="px-3 py-2">
                        <MatchBadge type={e.matchType} />
                      </td>
                    )}
                    <td className="px-3 py-2" data-testid={`feed-product-${e.id}`}>
                      {displayName}
                      {isSuggestionOnly ? <span className="ml-1 text-xs text-amber-600">(suggested)</span> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs" data-testid={`feed-part-number-${e.id}`}>
                      {displaySku}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{e.status === "known" ? e.quantityAfterScan : "-"}</td>
                    <td className="px-3 py-2">
                      {e.decodeStatus && e.decodeStatus !== "none" ? (
                        <DecodeStatusBadge status={e.decodeStatus} />
                      ) : (
                        <StatusBadge status={e.status} />
                      )}
                    </td>
                    <td className="max-w-56 px-3 py-2 text-xs text-zinc-500" title={isPlatform && e.decodeNote ? `${e.reason} — ${e.decodeNote}` : e.reason}>
                      {e.reason}
                      {isPlatform && e.decodeNote ? <span className="text-zinc-400"> — {e.decodeNote}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <SyncBadge status={e.syncStatus} />
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
