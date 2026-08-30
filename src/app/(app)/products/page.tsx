"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/users-businesses/roles/useAccessLevel";
import { customerDisplayName } from "@/services/displayName";
import { ImageHoverPreview } from "@/components/ImageHoverPreview";
import { UndoDeleteBanner, confirmAndDeleteProduct } from "@/components/UndoDeleteBanner";
import { UniversalImportPanelContainer } from "@/components/UniversalImportPanelContainer";
import { BusinessContextGate } from "@/users-businesses/BusinessContextGate";
import type { Product } from "@/types";

// BusinessContextGate wraps this page's content (same convention as /scan, /review, /history,
// /sessions/[id]) so a hard page load directly on /products waits for the real signed-in business
// context to hydrate before UniversalImportPanelContainer can fire /api/import-mapping or
// /api/reconcile/match - otherwise those requests go out scoped to the coded mock default
// (demo-business) instead of the real tenant (same bug class as the /reconcile 403).
export default function ProductsPage() {
  const allProducts = useScanStore((s) => s.products);
  // Archived (deleted) products are hidden from the list but kept in state for Undo + audit.
  const products = allProducts.filter((p) => p.status !== "archived");
  // Raw codes (barcode/GTIN/UPC/EAN), the alias "Codes" panel, the source, and Delete are platformOwner-
  // only. Customers see product-facing columns + the part number (SKU).
  const isPlatform = useIsPlatformOwner();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <BusinessContextGate>
      {isPlatform && <UndoDeleteBanner />}
      <UniversalImportPanelContainer />
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 id="products-heading" className="text-lg font-semibold text-zinc-900">Your products</h2>
          <span className="text-sm text-zinc-600">{products.length} products</span>
        </div>
        <div className="overflow-auto">
          <table className="w-full border-collapse text-left text-base" aria-labelledby="products-heading">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-700">
              <tr>
                <th scope="col" className="px-4 py-3">Name</th>
                <th scope="col" className="px-4 py-3">Brand</th>
                <th scope="col" className="px-4 py-3">Category</th>
                <th scope="col" className="px-4 py-3">Specs</th>
                <th scope="col" className="px-4 py-3">{isPlatform ? "SKU" : "Part number"}</th>
                {isPlatform && <th scope="col" className="px-4 py-3">Barcode</th>}
                {isPlatform && <th scope="col" className="px-4 py-3">Global barcode (GTIN/UPC/EAN)</th>}
                {isPlatform && <th scope="col" className="px-4 py-3">Codes</th>}
                <th scope="col" className="px-4 py-3">Image</th>
                <th scope="col" className="px-4 py-3">Location</th>
                {isPlatform && <th scope="col" className="px-4 py-3">Source</th>}
                {isPlatform && <th scope="col" className="px-4 py-3">Actions</th>}
              </tr>
            </thead>
            <tbody data-testid="products-body">
              {products.map((p) => (
                <ProductRow key={p.id} product={p} allProducts={products} isPlatform={isPlatform} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </BusinessContextGate>
    </div>
  );
}

function ProductRow({ product: p, allProducts, isPlatform }: { product: Product; allProducts: Product[]; isPlatform: boolean }) {
  // Select the STABLE aliases array reference, then filter in the render body. Filtering inside the
  // selector returns a new array every call and trips React's "getSnapshot should be cached" infinite loop.
  const allAliasesForRow = useScanStore((s) => s.aliases);
  const unlinkAlias = useScanStore((s) => s.unlinkAlias);
  const moveAlias = useScanStore((s) => s.moveAlias);
  const aliases = allAliasesForRow.filter((a) => a.productId === p.id);
  const [open, setOpen] = useState(false);
  const approvedCount = aliases.filter((a) => a.approved).length;

  return (
    <>
      <tr className="border-t border-zinc-100 hover:bg-zinc-50" data-testid={`product-row-${p.id}`}>
        <td className="px-4 py-3 font-medium text-zinc-800">{isPlatform ? p.name : customerDisplayName(p.name)}</td>
        <td className="px-4 py-3">{p.brand}</td>
        <td className="px-4 py-3">{p.category}</td>
        <td className="px-4 py-3">{p.specsShort}</td>
        <td className="px-4 py-3 font-mono text-sm">{p.primarySku || "-"}</td>
        {isPlatform && <td className="px-4 py-3 font-mono text-sm">{p.primaryBarcode || "-"}</td>}
        {isPlatform && <td className="px-4 py-3 font-mono text-sm text-zinc-600">{[p.gtin, p.upc, p.ean].filter(Boolean).join(" / ") || "-"}</td>}
        {isPlatform && (
          <td className="px-4 py-3 text-sm">
            <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-lg border border-zinc-300 px-3 py-1 hover:bg-zinc-50" data-testid={`manage-codes-${p.id}`}>
              {approvedCount} <span className={`inline-block transition-transform ${open ? "rotate-180" : ""}`}>&#x25BE;</span>
            </button>
          </td>
        )}
        <td className="px-4 py-3"><ImageHoverPreview imageUrl={p.imageUrl} alt={p.name} /></td>
        <td className="px-4 py-3">{p.location || "-"}</td>
        {isPlatform && <td className="px-4 py-3 text-sm text-zinc-600">{p.source}</td>}
        {isPlatform && (
          <td className="px-4 py-3">
            <button
              type="button"
              data-testid={`delete-product-${p.id}`}
              onClick={() => confirmAndDeleteProduct(p.id, p.name)}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-800 hover:bg-red-100"
            >
              Delete
            </button>
          </td>
        )}
      </tr>
      {isPlatform && open && (
        <tr className="bg-zinc-50" data-testid={`codes-panel-${p.id}`}>
          <td colSpan={12} className="px-3 py-2">
            <p className="mb-1 text-xs font-semibold text-zinc-600">Codes for {p.name} (unlink a wrong code, or move it to the correct product)</p>
            <div className="flex flex-col gap-1">
              {aliases.length === 0 && <span className="text-xs text-zinc-400">No codes.</span>}
              {aliases.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`alias-${a.cleanCode}`}>
                  <span className="font-mono">{a.cleanCode}</span>
                  <span className={a.approved ? "text-green-700" : "text-zinc-400 line-through"}>{a.approved ? a.aliasType : "unlinked"}</span>
                  {a.approved && (
                    <>
                      <button type="button" data-testid={`unlink-${a.cleanCode}`} onClick={() => unlinkAlias(a.id)} className="rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50">
                        Unlink
                      </button>
                      <MoveControl aliasId={a.id} currentProductId={p.id} allProducts={allProducts} onMove={moveAlias} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function MoveControl({ aliasId, currentProductId, allProducts, onMove }: { aliasId: string; currentProductId: string; allProducts: Product[]; onMove: (aliasId: string, toProductId: string) => void }) {
  const others = allProducts.filter((p) => p.id !== currentProductId);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  if (others.length === 0) return null;
  return (
    <span className="flex items-center gap-1">
      <select aria-label="move to product" value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-40 rounded border border-zinc-300 px-1 py-0.5">
        {others.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button type="button" data-testid={`move-${aliasId}`} onClick={() => target && onMove(aliasId, target)} className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50">
        Move
      </button>
    </span>
  );
}
