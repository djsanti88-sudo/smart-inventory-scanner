"use client";

import { useMemo, useState } from "react";
import { useIsPlatformOwner } from "@/users-businesses/roles/useAccessLevel";
import { customerDisplayName } from "@/services/displayName";
import { prettifyProductName, resolvedBrand, resolvedModel, resolvedSizeTag, resolvedSizeDisplay } from "@/services/format/productDisplay";
import { DecodeStatusBadge } from "@/components/badges";
import type { Product } from "@/types";

// One row of the session counts spreadsheet. `product` is the store join (getProduct) when the
// counted product is resolvable; an unresolvable row keeps only the scanned clean code and shows
// the table's honest empty-cell convention ("-") for every product-derived column. `aliasesSeen`
// exists only when the data source provides it (current-session finalCounts); past-session timeline
// rows leave it undefined and the whole column is omitted rather than rendered as an empty fake.
export interface SessionCountRow {
  id: string;
  code: string;
  quantity: number;
  product?: Product;
  location?: string;
  lastScannedAt?: string;
  aliasesSeen?: string[];
}

// Session detail page: the "full spreadsheet" of a session's product counts - the same columns, in
// the same order, as the home page's "Your counts" table (FinalCountTable.tsx:119-138) EXCEPT the
// Sync and Actions columns: this is a read-only historical view, so no mutating controls. The page
// derives `rows` for the CURRENT session from the store's finalCounts, or for a past session from
// its scan timeline, and passes them in.
export function SessionCountsTable({ rows }: { rows: SessionCountRow[] }) {
  const isPlatform = useIsPlatformOwner();
  const [filterQuery, setFilterQuery] = useState("");

  const totalUnits = useMemo(() => rows.reduce((sum, r) => sum + r.quantity, 0), [rows]);

  // "Other codes scanned" renders only when the data source actually carries alias data (current
  // session finalCounts). A past-session timeline has none, so the column is omitted entirely.
  const showAliasColumn = isPlatform && rows.some((r) => r.aliasesSeen !== undefined);
  const columnCount = showAliasColumn ? 13 : 12;

  const visibleRows = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.product?.name ?? "").toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        (r.product?.primaryBarcode ?? "").toLowerCase().includes(q),
    );
  }, [rows, filterQuery]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 id="session-counts-heading" className="text-lg font-semibold text-zinc-900">Product counts</h2>
        <span className="text-sm text-zinc-600" data-testid="session-counts-total">
          {totalUnits} total units - {visibleRows.length} of {rows.length} products
        </span>
      </div>
      <div className="px-4 pt-3">
        <input
          type="text"
          data-testid="session-counts-filter"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Search by product name or code"
          aria-label="Search product counts"
          className="min-h-[44px] w-full max-w-md rounded-lg border border-zinc-300 px-3 text-base"
        />
      </div>
      <div
        className="overflow-auto shadow-[inset_-8px_0_6px_-6px_rgba(0,0,0,0.08)]"
        tabIndex={0}
        role="region"
        aria-label="Session counts table, scroll horizontally for more columns"
      >
        <table className="w-full border-collapse text-left text-base" aria-labelledby="session-counts-heading">
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
              <th scope="col" className="px-4 py-3">Barcode</th>
              {showAliasColumn && <th scope="col" className="px-4 py-3">Other codes scanned</th>}
              <th scope="col" className="px-4 py-3">Location</th>
              <th scope="col" className="px-4 py-3">Last scanned</th>
              <th scope="col" className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody data-testid="session-counts-body">
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-6 text-center text-base text-zinc-600">
                  {rows.length === 0
                    ? "No counts in this session."
                    : "No products match this search."}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
                <SessionCountRowView
                  key={row.id}
                  row={row}
                  isPlatform={isPlatform}
                  showAliasColumn={showAliasColumn}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SessionCountRowView({
  row,
  isPlatform,
  showAliasColumn,
}: {
  row: SessionCountRow;
  isPlatform: boolean;
  showAliasColumn: boolean;
}) {
  const { product } = row;
  // Unresolvable product: the scanned clean code shows in Product and Barcode; every other
  // product-derived cell shows the honest "-" convention - never fabricated values.
  const displayName = product
    ? prettifyProductName(isPlatform ? product.name : customerDisplayName(product.name))
    : row.code || "Unknown product";
  const statusBadge = product ? (
    product.verified ? (
      <DecodeStatusBadge status="verified" />
    ) : product.provisional ? (
      <DecodeStatusBadge status="needs_review" />
    ) : (
      "-"
    )
  ) : (
    "-"
  );

  return (
    <tr className="border-t border-zinc-100 align-top hover:bg-zinc-50" data-testid={`session-count-row-${row.id}`}>
      <td className="px-4 py-3 text-lg font-semibold tabular-nums" data-testid={`session-count-qty-${row.id}`}>
        {row.quantity}
      </td>
      <td className="px-4 py-3 font-medium text-zinc-800">{displayName}</td>
      <td className="px-4 py-3" data-testid={`session-count-brand-${row.id}`}>
        {product ? resolvedBrand(product) || "-" : "-"}
      </td>
      <td className="px-4 py-3" data-testid={`session-count-model-${row.id}`}>
        {product ? resolvedModel(product, isPlatform) || "-" : "-"}
      </td>
      <td className="px-4 py-3">{product?.category || "-"}</td>
      <td className="px-4 py-3">{product?.specsShort || "-"}</td>
      <td
        className="px-4 py-3 font-mono text-sm tabular-nums"
        data-testid={`session-count-size-${row.id}`}
        title={product ? resolvedSizeTag(product) || undefined : undefined}
      >
        {product ? resolvedSizeDisplay(product) || "-" : "-"}
      </td>
      <td className="px-4 py-3 font-mono text-sm">{product?.primarySku || "-"}</td>
      <td className="px-4 py-3 font-mono text-sm" data-testid={`session-count-barcode-${row.id}`}>
        {product?.primaryBarcode || row.code || "-"}
      </td>
      {showAliasColumn && (
        <td className="px-4 py-3 font-mono text-sm text-zinc-600">{(row.aliasesSeen ?? []).join(", ")}</td>
      )}
      <td className="px-4 py-3">{row.location || product?.location || "-"}</td>
      <td className="px-4 py-3 text-sm text-zinc-600">
        {row.lastScannedAt ? new Date(row.lastScannedAt).toLocaleTimeString() : "-"}
      </td>
      <td className="px-4 py-3">{statusBadge}</td>
    </tr>
  );
}
