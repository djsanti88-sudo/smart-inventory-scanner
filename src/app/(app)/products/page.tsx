"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { ImageHoverPreview } from "@/components/ImageHoverPreview";
import type { Product } from "@/types";

export default function ProductsPage() {
  const products = useScanStore((s) => s.products);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
          <h2 className="text-sm font-semibold text-zinc-800">Product Database</h2>
          <span className="text-xs text-zinc-500">{products.length} products</span>
        </div>
        <div className="overflow-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Specs</th>
                <th className="px-3 py-2">Primary SKU</th>
                <th className="px-3 py-2">Primary barcode</th>
                <th className="px-3 py-2">GTIN/UPC/EAN</th>
                <th className="px-3 py-2">Codes</th>
                <th className="px-3 py-2">Image</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody data-testid="products-body">
              {products.map((p) => (
                <ProductRow key={p.id} product={p} allProducts={products} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ProductRow({ product: p, allProducts }: { product: Product; allProducts: Product[] }) {
  const aliases = useScanStore((s) => s.aliases.filter((a) => a.productId === p.id));
  const unlinkAlias = useScanStore((s) => s.unlinkAlias);
  const moveAlias = useScanStore((s) => s.moveAlias);
  const [open, setOpen] = useState(false);
  const approvedCount = aliases.filter((a) => a.approved).length;

  return (
    <>
      <tr className="border-t border-zinc-100" data-testid={`product-row-${p.id}`}>
        <td className="px-3 py-2 font-medium text-zinc-800">{p.name}</td>
        <td className="px-3 py-2">{p.brand}</td>
        <td className="px-3 py-2">{p.category}</td>
        <td className="px-3 py-2">{p.specsShort}</td>
        <td className="px-3 py-2 font-mono text-xs">{p.primarySku || "-"}</td>
        <td className="px-3 py-2 font-mono text-xs">{p.primaryBarcode || "-"}</td>
        <td className="px-3 py-2 font-mono text-xs text-zinc-500">{[p.gtin, p.upc, p.ean].filter(Boolean).join(" / ") || "-"}</td>
        <td className="px-3 py-2 text-xs">
          <button type="button" onClick={() => setOpen((v) => !v)} className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50" data-testid={`manage-codes-${p.id}`}>
            {approvedCount} {open ? "▲" : "▼"}
          </button>
        </td>
        <td className="px-3 py-2"><ImageHoverPreview imageUrl={p.imageUrl} alt={p.name} /></td>
        <td className="px-3 py-2">{p.location || "-"}</td>
        <td className="px-3 py-2 text-xs text-zinc-500">{p.source}</td>
      </tr>
      {open && (
        <tr className="bg-zinc-50" data-testid={`codes-panel-${p.id}`}>
          <td colSpan={11} className="px-3 py-2">
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
