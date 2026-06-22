"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { SyncBadge } from "@/components/badges";
import { ImageHoverPreview } from "@/components/ImageHoverPreview";
import { UndoDeleteBanner, confirmAndDeleteProduct } from "@/components/UndoDeleteBanner";
import type { InventoryCount, Product } from "@/types";

// Final count database: spreadsheet-style, grouped by PRODUCT (not by code). Raw codes (barcode +
// aliases) are platformOwner-only. Row actions let the owner fix a wrong saved decode safely:
// Correct (edit product fields), Remove from count (session-only), Mark wrong (platformOwner: deactivate
// the bad alias + reopen Needs Review + Gemini Pro recheck).
export function FinalCountTable() {
  const finalCounts = useScanStore((s) => s.finalCounts);
  const getProduct = useScanStore((s) => s.getProduct);
  const isPlatform = useIsPlatformOwner();

  const rows = finalCounts
    .map((c) => ({ count: c, product: getProduct(c.productId) }))
    .filter((r): r is { count: InventoryCount; product: Product } => !!r.product)
    .sort((a, b) => b.count.quantity - a.count.quantity);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="text-lg font-semibold text-zinc-900">Your counts</h2>
        <span className="text-sm text-zinc-600">{rows.length} products</span>
      </div>
      {isPlatform && (
        <div className="px-4 pt-3">
          <UndoDeleteBanner />
        </div>
      )}
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-base">
          <thead className="bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Brand</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Specs</th>
              <th className="px-3 py-2">{isPlatform ? "SKU" : "Part number"}</th>
              {isPlatform && <th className="px-3 py-2">Primary barcode</th>}
              {isPlatform && <th className="px-3 py-2">Aliases</th>}
              <th className="px-3 py-2">Image</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">Last scanned</th>
              <th className="px-3 py-2">Saved</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="final-count-body">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 13 : 11} className="px-3 py-6 text-center text-base text-zinc-600">
                  No counts yet.
                </td>
              </tr>
            ) : (
              rows.map(({ count, product }) => (
                <CountRow key={count.id} count={count} product={product} isPlatform={isPlatform} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountRow({ count, product, isPlatform }: { count: InventoryCount; product: Product; isPlatform: boolean }) {
  const removeFromCount = useScanStore((s) => s.removeFromCount);
  const correctProduct = useScanStore((s) => s.correctProduct);
  const markWrong = useScanStore((s) => s.markWrong);
  const aliases = useScanStore((s) => s.aliases);
  const approveDiscoveredIdentifiers = useScanStore((s) => s.approveDiscoveredIdentifiers);
  // Discovered (grounded, not-yet-approved) identifiers for this product: offered for one-click approval.
  // They do NOT match or count until approved (the resolver ignores approved !== true).
  const discovered = aliases.filter((a) => a.productId === product.id && !a.approved);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: product.name, brand: product.brand, category: product.category, location: product.location ?? "" });

  const onRemove = () => {
    if (window.confirm("Remove this product from the current count? The product and its codes are kept - you can re-scan to count again.")) {
      removeFromCount(product.id);
    }
  };
  const onMarkWrong = () => {
    if (
      window.confirm(
        "Mark this product as the WRONG match? This removes the count, deactivates the scanned code's alias so it stops counting, reopens Needs Review, and runs a Gemini Pro recheck if configured.",
      )
    ) {
      void markWrong(product.id, { reason: "marked wrong from final count" });
    }
  };
  const onSave = () => {
    correctProduct(product.id, form);
    setEditing(false);
  };

  return (
    <tr className="border-t border-zinc-100 align-top" data-testid={`count-row-${product.id}`}>
      <td className="px-3 py-2 text-lg font-semibold tabular-nums" data-testid={`qty-${product.id}`}>
        {count.quantity}
      </td>
      <td className="px-3 py-2 font-medium text-zinc-800">{product.name}</td>
      <td className="px-3 py-2">{product.brand}</td>
      <td className="px-3 py-2">{product.category}</td>
      <td className="px-3 py-2">{product.specsShort}</td>
      <td className="px-3 py-2 font-mono text-xs">
        <div>{product.primarySku || "-"}</div>
        {discovered.length > 0 && (
          <div className="mt-1 flex flex-col items-start gap-1" data-testid={`discovered-${product.id}`}>
            {discovered.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`approve-discovered-${product.id}-${a.cleanCode}`}
                onClick={() => approveDiscoveredIdentifiers(product.id, [a.cleanCode])}
                title="Discovered identifier - approve so scanning it counts this product"
                className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
              >
                + Approve {a.cleanCode}
              </button>
            ))}
          </div>
        )}
      </td>
      {isPlatform && <td className="px-3 py-2 font-mono text-xs">{product.primaryBarcode || "-"}</td>}
      {isPlatform && <td className="px-3 py-2 font-mono text-xs text-zinc-500">{count.aliasesSeen.join(", ")}</td>}
      <td className="px-3 py-2">
        <ImageHoverPreview imageUrl={product.imageUrl} alt={product.name} />
      </td>
      <td className="px-3 py-2">{product.location || "-"}</td>
      <td className="px-3 py-2 text-xs text-zinc-500">
        {count.lastScannedAt ? new Date(count.lastScannedAt).toLocaleTimeString() : "-"}
      </td>
      <td className="px-3 py-2">
        <SyncBadge status={count.syncStatus} />
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <div className="flex w-56 flex-col gap-1" data-testid={`correct-form-${product.id}`}>
            <input
              aria-label="product name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Product name"
              className="rounded border border-zinc-300 px-2 py-1 text-xs"
            />
            <div className="flex gap-1">
              <input
                aria-label="brand"
                value={form.brand}
                onChange={(e) => setForm({ ...form, brand: e.target.value })}
                placeholder="Brand"
                className="w-1/2 rounded border border-zinc-300 px-2 py-1 text-xs"
              />
              <input
                aria-label="category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Category"
                className="w-1/2 rounded border border-zinc-300 px-2 py-1 text-xs"
              />
            </div>
            <input
              aria-label="location"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="Location"
              className="rounded border border-zinc-300 px-2 py-1 text-xs"
            />
            <div className="flex gap-1">
              <button type="button" data-testid={`correct-save-${product.id}`} onClick={onSave} className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700">
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className="rounded border border-zinc-300 px-2 py-1 text-xs">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            <button type="button" data-testid={`correct-${product.id}`} onClick={() => setEditing(true)} className="rounded border border-zinc-300 px-2 py-1 text-xs">
              Correct
            </button>
            <button type="button" data-testid={`remove-count-${product.id}`} onClick={onRemove} className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600">
              Remove from count
            </button>
            {isPlatform && (
              <button type="button" data-testid={`mark-wrong-${product.id}`} onClick={onMarkWrong} className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
                Mark wrong
              </button>
            )}
            {isPlatform && (
              <button type="button" data-testid={`delete-product-${product.id}`} onClick={() => confirmAndDeleteProduct(product.id, product.name)} className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
                Delete
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
