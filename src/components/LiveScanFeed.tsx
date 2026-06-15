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
  const isPlatform = useIsPlatformOwner();
  const colSpan = isPlatform ? 10 : 7;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <h2 className="text-sm font-semibold text-zinc-800">Live Scan Feed</h2>
        <span className="text-xs text-zinc-500">{scanFeed.length} events</span>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              {isPlatform && <th className="px-3 py-2">Raw code</th>}
              {isPlatform && <th className="px-3 py-2">Clean code</th>}
              {isPlatform && <th className="px-3 py-2">Match</th>}
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Part number</th>
              <th className="px-3 py-2">Qty after</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Sync</th>
            </tr>
          </thead>
          <tbody data-testid="scan-feed-body">
            {scanFeed.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-3 py-6 text-center text-zinc-400">
                  No scans yet. Click the scan box and scan a code.
                </td>
              </tr>
            ) : (
              scanFeed.map((e) => {
                const product = getProduct(e.matchedProductId);
                return (
                  <tr key={e.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "-"}
                    </td>
                    {isPlatform && <td className="px-3 py-2 font-mono text-xs">{e.rawCode}</td>}
                    {isPlatform && <td className="px-3 py-2 font-mono text-xs">{e.cleanCode}</td>}
                    {isPlatform && (
                      <td className="px-3 py-2">
                        <MatchBadge type={e.matchType} />
                      </td>
                    )}
                    <td className="px-3 py-2">{product ? product.name : "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs" data-testid={`feed-part-number-${e.id}`}>
                      {product ? product.primarySku || "Part number missing" : "-"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{e.status === "known" ? e.quantityAfterScan : "-"}</td>
                    <td className="px-3 py-2">
                      {e.decodeStatus && e.decodeStatus !== "none" ? (
                        <DecodeStatusBadge status={e.decodeStatus} />
                      ) : (
                        <StatusBadge status={e.status} />
                      )}
                    </td>
                    <td className="max-w-56 px-3 py-2 text-xs text-zinc-500" title={e.reason}>
                      {e.reason}
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
