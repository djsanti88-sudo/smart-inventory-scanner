"use client";

import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { SyncBadge } from "@/components/badges";
import { ImageHoverPreview } from "@/components/ImageHoverPreview";

// Final count database: spreadsheet-style, grouped by PRODUCT (not by code). This is the clean
// inventory the user exports. Raw codes (barcode + aliases) are platformOwner-only.
export function FinalCountTable() {
  const finalCounts = useScanStore((s) => s.finalCounts);
  const getProduct = useScanStore((s) => s.getProduct);
  const isPlatform = useIsPlatformOwner();

  const rows = finalCounts
    .map((c) => ({ count: c, product: getProduct(c.productId) }))
    .filter((r) => r.product)
    .sort((a, b) => b.count.quantity - a.count.quantity);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <h2 className="text-sm font-semibold text-zinc-800">Final Count Database</h2>
        <span className="text-xs text-zinc-500">{rows.length} products</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Brand</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Specs</th>
              <th className="px-3 py-2">Part number</th>
              {isPlatform && <th className="px-3 py-2">Primary barcode</th>}
              {isPlatform && <th className="px-3 py-2">Aliases</th>}
              <th className="px-3 py-2">Image</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">Last scanned</th>
              <th className="px-3 py-2">Sync</th>
            </tr>
          </thead>
          <tbody data-testid="final-count-body">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-zinc-400">
                  No counts yet.
                </td>
              </tr>
            ) : (
              rows.map(({ count, product }) => (
                <tr key={count.id} className="border-t border-zinc-100" data-testid={`count-row-${product!.id}`}>
                  <td className="px-3 py-2 text-lg font-semibold tabular-nums" data-testid={`qty-${product!.id}`}>
                    {count.quantity}
                  </td>
                  <td className="px-3 py-2 font-medium text-zinc-800">{product!.name}</td>
                  <td className="px-3 py-2">{product!.brand}</td>
                  <td className="px-3 py-2">{product!.category}</td>
                  <td className="px-3 py-2">{product!.specsShort}</td>
                  <td className="px-3 py-2 font-mono text-xs">{product!.primarySku || "-"}</td>
                  {isPlatform && <td className="px-3 py-2 font-mono text-xs">{product!.primaryBarcode || "-"}</td>}
                  {isPlatform && <td className="px-3 py-2 font-mono text-xs text-zinc-500">{count.aliasesSeen.join(", ")}</td>}
                  <td className="px-3 py-2">
                    <ImageHoverPreview imageUrl={product!.imageUrl} alt={product!.name} />
                  </td>
                  <td className="px-3 py-2">{product!.location || "-"}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {count.lastScannedAt ? new Date(count.lastScannedAt).toLocaleTimeString() : "-"}
                  </td>
                  <td className="px-3 py-2">
                    <SyncBadge status={count.syncStatus} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
