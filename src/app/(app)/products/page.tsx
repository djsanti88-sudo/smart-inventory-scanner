"use client";

import { useScanStore } from "@/stores/scanStore";
import { ImageHoverPreview } from "@/components/ImageHoverPreview";

export default function ProductsPage() {
  const products = useScanStore((s) => s.products);
  const aliases = useScanStore((s) => s.aliases);

  const aliasCount = (productId: string) => aliases.filter((a) => a.productId === productId).length;

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
                <th className="px-3 py-2">Aliases</th>
                <th className="px-3 py-2">Image</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody data-testid="products-body">
              {products.map((p) => (
                <tr key={p.id} className="border-t border-zinc-100" data-testid={`product-row-${p.id}`}>
                  <td className="px-3 py-2 font-medium text-zinc-800">{p.name}</td>
                  <td className="px-3 py-2">{p.brand}</td>
                  <td className="px-3 py-2">{p.category}</td>
                  <td className="px-3 py-2">{p.specsShort}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.primarySku || "-"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.primaryBarcode || "-"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                    {[p.gtin, p.upc, p.ean].filter(Boolean).join(" / ") || "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">{aliasCount(p.id)}</td>
                  <td className="px-3 py-2">
                    <ImageHoverPreview imageUrl={p.imageUrl} alt={p.name} />
                  </td>
                  <td className="px-3 py-2">{p.location || "-"}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
