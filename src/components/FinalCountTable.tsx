"use client";

import { useMemo, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { customerDisplayName } from "@/services/displayName";
import { prettifyProductName, resolvedBrand, resolvedModel, resolvedSizeTag, resolvedSizeDisplay } from "@/services/format/productDisplay";
import { getReviewIdentityBand, identityBandLabel } from "@/services/ai/identityConfidenceBand";
import { DecodeStatusBadge, SyncBadge } from "@/components/badges";
import { UndoDeleteBanner, confirmAndDeleteProduct } from "@/components/UndoDeleteBanner";
import { filterProducts } from "@/services/polish/filterProducts";
import { requiresOwnerPin } from "@/services/security/destructiveGuard";
import type { InventoryCount, Product, UnknownCodeReview } from "@/types";

// DEFECT #29/#37 residual (live-reproduced 2026-08-05/06, canelo round 2): same freeze class as
// LiveScanFeed - a fresh-device restore with ~1,800 count rows synchronously mounted ALL of them into
// the DOM. WINDOWING (display-only, sanctioned contingency - no new dependency): render only the first
// COUNTS_RENDER_WINDOW rows of the already-sorted list, plus a summary row stating exactly how many
// more products are hidden, with a "Show more" control that grows the window by COUNTS_RENDER_CHUNK
// per click. The header total ("N of M products") and all store totals are computed over the FULL
// filtered set, never the rendered window.
export const COUNTS_RENDER_WINDOW = 200;
export const COUNTS_RENDER_CHUNK = 300;

// Final count database: spreadsheet-style, grouped by PRODUCT (not by code). Raw codes (barcode +
// aliases) are platformOwner-only. Row actions let the owner fix a wrong saved decode safely:
// Correct (edit product fields), Remove from count (session-only), Mark wrong (platformOwner: deactivate
// the bad alias + reopen Needs Review + Gemini Pro recheck).
export function FinalCountTable() {
  const finalCounts = useScanStore((s) => s.finalCounts);
  const currentSession = useScanStore((s) => s.currentSession);
  const products = useScanStore((s) => s.products);
  const needsReviewQueue = useScanStore((s) => s.needsReviewQueue);
  const isPlatform = useIsPlatformOwner();
  const [filterQuery, setFilterQuery] = useState("");
  const [renderWindow, setRenderWindow] = useState(COUNTS_RENDER_WINDOW);

  // F2 fix (Phase 3 review): refreshFromCloud intentionally does an ADDITIVE cross-session merge into
  // finalCounts (a tested cross-device sync path - see refreshFromCloud.store.test.ts). This table
  // must show only the CURRENT session's counts, not every session's counts merged into the store.
  const sessionCounts = useMemo(
    () => (currentSession ? finalCounts.filter((c) => c.sessionId === currentSession.id) : finalCounts),
    [finalCounts, currentSession],
  );

  // PERF FIX (defect #37, live-reproduced 2026-08-05/06): `getProduct(id)` does a linear
  // `products.find()`. Mapping every session count through it - AND recomputing that map on every
  // render since `rows` was not memoized - made this O(finalCounts.length * products.length) on every
  // render, freezing the renderer for 30+ seconds on a fresh device with thousands of scans/products.
  // Build the id -> product index ONCE per `products` change (O(M)) and memoize `rows` itself so the
  // O(N) mapping over sessionCounts only re-runs when the underlying data actually changes.
  const productsById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const rows = useMemo(
    () =>
      sessionCounts
        .map((c) => ({ count: c, product: productsById.get(c.productId) }))
        .filter((r): r is { count: InventoryCount; product: Product } => !!r.product)
        .sort((a, b) => b.count.quantity - a.count.quantity),
    [sessionCounts, productsById],
  );

  // Task 4: digits-only query filters by sizeTag prefix; any other text filters brand/model/description.
  const visibleRows = useMemo(() => {
    const filterable = rows.map((r) => ({
      id: r.count.id,
      brand: resolvedBrand(r.product),
      // Filtering always searches the raw structured model (not the customer-cleaned display value):
      // the filter box is a search index, not a rendered cell, and this keeps filter behavior
      // unchanged for both roles.
      model: resolvedModel(r.product, true),
      description: r.product.structuredDescription || r.product.name,
      sizeTag: resolvedSizeTag(r.product),
    }));
    const kept = new Set(filterProducts(filterable, filterQuery).map((f) => f.id));
    return rows.filter((r) => kept.has(r.count.id));
  }, [rows, filterQuery]);

  const windowedRows = useMemo(() => visibleRows.slice(0, renderWindow), [visibleRows, renderWindow]);
  const hiddenCount = Math.max(0, visibleRows.length - windowedRows.length);

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
          onChange={(e) => {
            setFilterQuery(e.target.value);
            // Display-only window resets with the filter so a narrowed search never inherits a
            // stale, oversized window from a prior filter.
            setRenderWindow(COUNTS_RENDER_WINDOW);
          }}
          placeholder="Filter by brand, model, description, or size (e.g. 205)"
          aria-label="Filter counts"
          className="min-h-[44px] w-full max-w-md rounded-lg border border-zinc-300 px-3 text-base"
        />
      </div>
      <div
        className="overflow-auto shadow-[inset_-8px_0_6px_-6px_rgba(0,0,0,0.08)]"
        tabIndex={0}
        role="region"
        aria-label="Your counts table, scroll horizontally for more columns"
      >
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
              {/* Owner order 2026-07-10: the code the shop scanned is THEIR data - visible to all
                  roles (same rule the feed applies to its Barcode column). The alias DB column
                  below stays platformOwner-only. */}
              <th scope="col" className="px-4 py-3">Barcode</th>
              {isPlatform && <th scope="col" className="px-4 py-3">Other codes scanned</th>}
              <th scope="col" className="px-4 py-3">Location</th>
              <th scope="col" className="px-4 py-3">Last scanned</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Sync</th>
              <th scope="col" className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="final-count-body">
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={isPlatform ? 15 : 14} className="px-4 py-6 text-center text-base text-zinc-600">
                  {rows.length === 0
                    ? "No counts yet. Scan a barcode to start counting your inventory."
                    : "No products match this filter."}
                </td>
              </tr>
            ) : (
              <>
              {windowedRows.map(({ count, product }) => (
                <CountRow key={count.id} count={count} product={product} isPlatform={isPlatform} needsReviewQueue={needsReviewQueue} />
              ))}
              {hiddenCount > 0 && (
                <tr className="border-t border-zinc-100 bg-zinc-50">
                  <td colSpan={isPlatform ? 15 : 14} className="px-4 py-3 text-center text-sm text-zinc-600" data-testid="counts-hidden-summary">
                    + {hiddenCount} more {hiddenCount === 1 ? "product" : "products"}
                    <button
                      type="button"
                      onClick={() => setRenderWindow((w) => w + COUNTS_RENDER_CHUNK)}
                      data-testid="counts-show-more"
                      className="ml-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                    >
                      Show more
                    </button>
                  </td>
                </tr>
              )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountRow({
  count,
  product,
  isPlatform,
  needsReviewQueue,
}: {
  count: InventoryCount;
  product: Product;
  isPlatform: boolean;
  needsReviewQueue: UnknownCodeReview[];
}) {
  const removeFromCount = useScanStore((s) => s.removeFromCount);
  const correctProduct = useScanStore((s) => s.correctProduct);
  const markWrong = useScanStore((s) => s.markWrong);
  const aliases = useScanStore((s) => s.aliases);
  const approveDiscoveredIdentifiers = useScanStore((s) => s.approveDiscoveredIdentifiers);
  const hasPin = useScanStore((s) => !!s.settings.ownerPinHash);
  const verifyOwnerPin = useScanStore((s) => s.verifyOwnerPin);
  // Discovered (grounded, not-yet-approved) identifiers for this product: offered for one-click approval.
  // They do NOT match or count until approved (the resolver ignores approved !== true).
  const discovered = aliases.filter((a) => a.productId === product.id && !a.approved);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: product.name, brand: product.brand, category: product.category, location: product.location ?? "" });
  // For now (owner request) keep the row to TWO simple actions: Modify + Delete. The extra/destructive
  // actions (Mark wrong, hard product delete) are hidden behind this flag (code kept). Set true to restore.
  const SHOW_ADVANCED_ACTIONS = false;

  const [removePinPrompt, setRemovePinPrompt] = useState(false);
  const [removePin, setRemovePin] = useState("");
  const [removePinErr, setRemovePinErr] = useState("");

  const onRemove = () => {
    if (window.confirm("Remove this product from the count? The product stays in your catalog. Scan it again to add it back.")) {
      if (requiresOwnerPin("removeFromCount", hasPin)) {
        setRemovePinPrompt(true);
        return;
      }
      removeFromCount(product.id);
    }
  };
  const submitRemovePin = async () => {
    const ok = await verifyOwnerPin(removePin);
    if (!ok) { setRemovePinErr("Wrong PIN"); return; }
    removeFromCount(product.id);
    setRemovePinPrompt(false);
    setRemovePin("");
    setRemovePinErr("");
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

  // Same render-time suggestion lookup LiveScanFeed uses (LiveScanFeed.tsx:59-83), applied only for
  // provisional rows: prefer a review keyed by this product's id (auto-applied identity still resolves
  // to the correct review for its confidence/tag), falling back to a cleanCode match on this product's
  // barcode with a usable suggested name.
  const suggestion = product.provisional
    ? needsReviewQueue.find(
        (r) => r.provisionalProductId === product.id || (r.cleanCode === product.primaryBarcode && r.suggestedProductName),
      )
    : undefined;
  const hasAppliedIdentity = product.provisional && !product.name.startsWith("Unidentified item");
  // Owner order 2026-07-10 refinement: "all rows showing something if possible... whats available
  // suggested or if full specs suggested everything". A row with a findable suggestion (and no
  // already-applied identity) displays through a MERGED product - the suggestion's fields overlaid
  // on the real (mostly-empty placeholder) product fields - fed through the SAME resolver pipelines
  // (resolvedBrand/resolvedModel/resolvedSizeTag/resolvedSizeDisplay) the real columns use, so every
  // mappable column (Brand, Model, Category, Specs, Size, Part number) fills in identically to a real
  // product row instead of showing "-" across the board. Fields the suggestion doesn't carry keep the
  // product's own (placeholder) value, preserving the existing "-" convention.
  const displayProduct: Product =
    suggestion && !hasAppliedIdentity
      ? {
          ...product,
          name: suggestion.suggestedProductName || product.name,
          brand: suggestion.suggestedBrand || product.brand,
          structuredBrand: undefined,
          structuredModel: undefined,
          category: suggestion.suggestedCategory || product.category,
          specsShort: suggestion.suggestedSpecsShort || product.specsShort,
          primarySku: suggestion.suggestedPrimarySku || product.primarySku,
        }
      : product;
  const displayName = prettifyProductName(hasAppliedIdentity ? product.name : displayProduct.name);
  const displayBrand = resolvedBrand(displayProduct);
  // Trust rule (same as the feed): an unverified identity carries the app-derived band, never a raw
  // percentage. No tag when no suggestion/review is findable for a provisional row.
  const suggestionLabel = suggestion ? identityBandLabel(getReviewIdentityBand(suggestion)) : null;
  const statusBadge = product.verified ? (
    <DecodeStatusBadge status="verified" />
  ) : product.provisional && (suggestion || hasAppliedIdentity) ? (
    <DecodeStatusBadge status="suggested" />
  ) : product.provisional ? (
    <DecodeStatusBadge status="needs_review" />
  ) : (
    "-"
  );

  return (
    <tr className="border-t border-zinc-100 align-top hover:bg-zinc-50" data-testid={`count-row-${product.id}`}>
      <td className="px-4 py-3 text-lg font-semibold tabular-nums" data-testid={`qty-${product.id}`}>
        {count.quantity}
      </td>
      <td className="px-4 py-3 font-medium text-zinc-800">
        {isPlatform ? displayName : prettifyProductName(customerDisplayName(displayName))}
        {/* COSMETIC FIX (2026-08-04, cocacola-bug-report.md): adjacent {text}{element} JSX renders with
            no whitespace text node between them - the ml-1 margin alone (4px) reads as a concatenated
            word ("Delinte D7Suggested") in a screenshot. Add a literal space, matching the codebase's
            own {" "} convention elsewhere (e.g. CleanupRecommendations.tsx). */}
        {suggestionLabel ? (
          <>
            {" "}
            <span className="ml-1 text-xs text-amber-700">({suggestionLabel})</span>
          </>
        ) : null}
      </td>
      <td className="px-4 py-3" data-testid={`brand-${product.id}`}>{displayBrand}</td>
      <td className="px-4 py-3" data-testid={`model-${product.id}`}>{resolvedModel(displayProduct, isPlatform) || "-"}</td>
      <td className="px-4 py-3">{displayProduct.category || "-"}</td>
      <td className="px-4 py-3">{displayProduct.specsShort || "-"}</td>
      <td
        className="px-4 py-3 font-mono text-sm tabular-nums"
        data-testid={`size-${product.id}`}
        title={resolvedSizeTag(displayProduct) || undefined}
      >
        {resolvedSizeDisplay(displayProduct) || "-"}
      </td>
      <td className="px-4 py-3 font-mono text-sm">
        <div>{displayProduct.primarySku || "-"}</div>
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
      <td className="px-4 py-3 font-mono text-sm" data-testid={`count-barcode-${product.id}`}>{product.primaryBarcode || "-"}</td>
      {isPlatform && <td className="px-4 py-3 font-mono text-sm text-zinc-600">{count.aliasesSeen.join(", ")}</td>}
      <td className="px-4 py-3">{product.location || "-"}</td>
      <td className="px-4 py-3 text-sm text-zinc-600">
        {count.lastScannedAt ? new Date(count.lastScannedAt).toLocaleTimeString() : "-"}
      </td>
      <td className="px-4 py-3">{statusBadge}</td>
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
            {isPlatform && (
              <input
                type="number"
                step="0.01"
                min="0"
                aria-label="unit cost"
                data-testid={`edit-unit-cost-${product.id}`}
                defaultValue={product.unitCost ?? ""}
                placeholder="Unit cost"
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  const parsed = value ? Number(value) : undefined;
                  correctProduct(product.id, { unitCost: Number.isFinite(parsed) ? parsed : undefined });
                }}
                className="min-h-[36px] w-24 rounded border border-zinc-300 px-2 text-sm"
              />
            )}
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
            {removePinPrompt && (
              <div className="flex items-center gap-2" data-testid={`remove-pin-row-${product.id}`}>
                <input aria-label="owner PIN" inputMode="numeric" value={removePin}
                  onChange={(e) => setRemovePin(e.target.value.replace(/\D/g, ""))} maxLength={6}
                  placeholder="Owner PIN" data-testid="remove-pin"
                  className="min-h-[44px] w-28 rounded-lg border border-zinc-300 px-3 text-base" />
                <button type="button" data-testid="remove-pin-confirm" onClick={submitRemovePin}
                  className="inline-flex min-h-[44px] items-center rounded-lg bg-red-600 px-4 text-base font-medium text-white hover:bg-red-700">
                  Confirm remove
                </button>
                {removePinErr && <span className="text-sm text-red-600" data-testid="remove-pin-error">{removePinErr}</span>}
              </div>
            )}
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
