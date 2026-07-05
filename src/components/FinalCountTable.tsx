"use client";

import { useMemo, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { customerDisplayName } from "@/services/displayName";
import { SyncBadge } from "@/components/badges";
import { plainTireSizeDigits } from "@/services/tire/tireSizeNormalizer";
import { UndoDeleteBanner, confirmAndDeleteProduct } from "@/components/UndoDeleteBanner";
import { filterProducts } from "@/services/polish/filterProducts";
import type { InventoryCount, Product } from "@/types";

// Task 4 (product-name polish): resolves the display Brand / Model / Size for one row, preferring
// the deterministic-structurer fields and falling back to the existing product.brand/name/specsShort
// so older (pre-structuring) products still render sensibly.
function resolvedBrand(product: Product): string {
  return product.structuredBrand || product.brand;
}
// Task 4 review fix: the Model column shows the table's existing empty-cell convention ("-") for a
// row with no structuredModel yet, rather than duplicating the full Product-column name. Filtering
// by name still works via the description field (structuredDescription falls back to product.name).
function resolvedModel(product: Product): string {
  return product.structuredModel || "";
}
function resolvedSizeTag(product: Product): string {
  return product.sizeTag || plainTireSizeDigits(product.specsShort);
}

// Final count database: spreadsheet-style, grouped by PRODUCT (not by code). Raw codes (barcode +
// aliases) are platformOwner-only. Row actions let the owner fix a wrong saved decode safely:
// Correct (edit product fields), Remove from count (session-only), Mark wrong (platformOwner: deactivate
// the bad alias + reopen Needs Review + Gemini Pro recheck).
export function FinalCountTable() {
  const finalCounts = useScanStore((s) => s.finalCounts);
  const getProduct = useScanStore((s) => s.getProduct);
  const isPlatform = useIsPlatformOwner();
  const [filterQuery, setFilterQuery] = useState("");

  const rows = finalCounts
    .map((c) => ({ count: c, product: getProduct(c.productId) }))
    .filter((r): r is { count: InventoryCount; product: Product } => !!r.product)
    .sort((a, b) => b.count.quantity - a.count.quantity);

  // Task 4: digits-only query filters by sizeTag prefix; any other text filters brand/model/description.
  const visibleRows = useMemo(() => {
    const filterable = rows.map((r) => ({
      id: r.count.id,
      brand: resolvedBrand(r.product),
      model: resolvedModel(r.product),
      description: r.product.structuredDescription || r.product.name,
      sizeTag: resolvedSizeTag(r.product),
    }));
    const kept = new Set(filterProducts(filterable, filterQuery).map((f) => f.id));
    return rows.filter((r) => kept.has(r.count.id));
  }, [rows, filterQuery]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 id="counts-heading" className="text-lg font-semibold text-zinc-900">Your counts</h2>
        <span className="text-sm text-zinc-600">{visibleRows.length} of {rows.length} products</span>
      </div>
      {isPlatform && (
        <div className="px-4 pt-3">
          <UndoDeleteBanner />
        </div>
      )}
      <div className="px-4 pt-3">
        <input
          type="text"
          data-testid="polish-filter"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter by brand, model, description, or size (e.g. 205)"
          aria-label="Filter counts"
          className="min-h-[44px] w-full max-w-md rounded-lg border border-zinc-300 px-3 text-base"
        />
      </div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-base" aria-labelledby="counts-heading">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
            <tr>
              <th scope="col" className="px-4 py-3">Qty</th>
              <th scope="col" className="px-4 py-3">Product</th>
              <th scope="col" className="px-4 py-3">Brand</th>
              <th scope="col" className="px-4 py-3">Model</th>
              <th scope="col" className="px-4 py-3">Category</th>
              <th scope="col" className="px-4 py-3">Specs</th>
              <th scope="col" className="px-4 py-3">Size</th>
              <th scope="col" className="px-4 py-3">{isPlatform ? "SKU" : "Part number"}</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Barcode</th>}
              {isPlatform && <th scope="col" className="px-4 py-3">Other codes scanned</th>}
              <th scope="col" className="px-4 py-3">Location</th>
              <th scope="col" className="px-4 py-3">Last scanned</th>
              <th scope="col" className="px-4 py-3">Sync</th>
              <th scope="col" className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="final-count-body">
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 14 : 12} className="px-4 py-6 text-center text-base text-zinc-600">
                  {rows.length === 0
                    ? "No counts yet. Scan a barcode to start counting your inventory."
                    : "No products match this filter."}
                </td>
              </tr>
            ) : (
              visibleRows.map(({ count, product }) => (
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
  // For now (owner request) keep the row to TWO simple actions: Modify + Delete. The extra/destructive
  // actions (Mark wrong, hard product delete) are hidden behind this flag (code kept). Set true to restore.
  const SHOW_ADVANCED_ACTIONS = false;

  const onRemove = () => {
    if (window.confirm("Remove this product from the count? The product stays in your catalog. Scan it again to add it back.")) {
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
    <tr className="border-t border-zinc-100 align-top hover:bg-zinc-50" data-testid={`count-row-${product.id}`}>
      <td className="px-4 py-3 text-lg font-semibold tabular-nums" data-testid={`qty-${product.id}`}>
        {count.quantity}
      </td>
      <td className="px-4 py-3 font-medium text-zinc-800">{isPlatform ? product.name : customerDisplayName(product.name)}</td>
      <td className="px-4 py-3" data-testid={`brand-${product.id}`}>{resolvedBrand(product)}</td>
      <td className="px-4 py-3" data-testid={`model-${product.id}`}>{resolvedModel(product) || "-"}</td>
      <td className="px-4 py-3">{product.category}</td>
      <td className="px-4 py-3">{product.specsShort}</td>
      <td className="px-4 py-3 font-mono text-sm tabular-nums" data-testid={`size-${product.id}`}>
        {resolvedSizeTag(product) || "-"}
      </td>
      <td className="px-4 py-3 font-mono text-sm">
        <div>{product.primarySku || "-"}</div>
        {discovered.length > 0 && (
          <div className="mt-1 flex flex-col items-start gap-1" data-testid={`discovered-${product.id}`}>
            {discovered.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`approve-discovered-${product.id}-${a.cleanCode}`}
                onClick={() => approveDiscoveredIdentifiers(product.id, [a.cleanCode])}
                title="New barcode found - approve it so scanning this code counts this product"
                className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                + Approve {a.cleanCode}
              </button>
            ))}
          </div>
        )}
      </td>
      {isPlatform && <td className="px-4 py-3 font-mono text-sm">{product.primaryBarcode || "-"}</td>}
      {isPlatform && <td className="px-4 py-3 font-mono text-sm text-zinc-600">{count.aliasesSeen.join(", ")}</td>}
      <td className="px-4 py-3">{product.location || "-"}</td>
      <td className="px-4 py-3 text-sm text-zinc-600">
        {count.lastScannedAt ? new Date(count.lastScannedAt).toLocaleTimeString() : "-"}
      </td>
      <td className="px-4 py-3">
        <SyncBadge status={count.syncStatus} />
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <div className="flex w-56 flex-col gap-1.5" data-testid={`correct-form-${product.id}`}>
            <input
              aria-label="product name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Product name"
              className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
            />
            <div className="flex gap-1.5">
              <input
                aria-label="brand"
                value={form.brand}
                onChange={(e) => setForm({ ...form, brand: e.target.value })}
                placeholder="Brand"
                className="min-h-[44px] w-1/2 rounded-lg border border-zinc-300 px-3 text-base"
              />
              <input
                aria-label="category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Category"
                className="min-h-[44px] w-1/2 rounded-lg border border-zinc-300 px-3 text-base"
              />
            </div>
            <input
              aria-label="location"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="Location"
              className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
            />
            <div className="flex gap-2">
              <button type="button" data-testid={`correct-save-${product.id}`} onClick={onSave} className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 active:scale-95">
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 active:scale-95">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button type="button" data-testid={`correct-${product.id}`} onClick={() => setEditing(true)} className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 active:scale-95">
              Edit details
            </button>
            <button type="button" data-testid={`remove-count-${product.id}`} onClick={onRemove} className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-800 hover:bg-red-100 active:scale-95">
              Remove from count
            </button>
            {SHOW_ADVANCED_ACTIONS && isPlatform && (
              <button type="button" data-testid={`mark-wrong-${product.id}`} onClick={onMarkWrong} className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-700 hover:bg-red-100">
                Mark wrong
              </button>
            )}
            {SHOW_ADVANCED_ACTIONS && isPlatform && (
              <button type="button" data-testid={`delete-product-${product.id}`} onClick={() => confirmAndDeleteProduct(product.id, product.name)} className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-700 hover:bg-red-100">
                Delete product
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
