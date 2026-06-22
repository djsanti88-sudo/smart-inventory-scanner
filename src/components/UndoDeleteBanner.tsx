"use client";

import { useScanStore } from "@/stores/scanStore";
import type { ProductDeleteBackup } from "@/stores/scanStore";

// Plain-language confirm + JSON backup download + delete, all in one reusable handler. Delete is REVERSIBLE
// (the store snapshots everything for Undo and we also hand the user a downloadable backup file), honoring
// the project's "safe correction over destructive wipe" ethos.

function downloadJson(filename: string, data: unknown) {
  if (typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Confirm, download a backup, then delete. Returns true if the product was deleted. */
export function confirmAndDeleteProduct(productId: string, productName: string): boolean {
  if (typeof window !== "undefined" && !window.confirm(`Delete "${productName || "this product"}"? It will be removed from your counts. You can undo this.`)) {
    return false;
  }
  const backup: ProductDeleteBackup | null = useScanStore.getState().deleteProduct(productId);
  if (!backup) return false;
  try {
    downloadJson(`deleted-product-${productId}.json`, backup);
  } catch {
    // a failed backup download must not block the (reversible) delete
  }
  return true;
}

/** Top-of-page banner offering a one-click Undo for the most recent delete/purge. */
export function UndoDeleteBanner() {
  const backup = useScanStore((s) => s.lastProductDeleteBackup);
  const undo = useScanStore((s) => s.undoDeleteProduct);
  if (!backup) return null;
  const n = backup.products.length;
  return (
    <div
      data-testid="undo-delete-banner"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-base text-amber-900"
    >
      <span>
        Deleted {n} {n === 1 ? "product" : "products"}. A backup file was saved to your downloads.
      </span>
      <button
        type="button"
        data-testid="undo-delete"
        onClick={() => undo()}
        className="ml-auto inline-flex min-h-[44px] items-center rounded-lg bg-amber-600 px-4 text-base font-medium text-white hover:bg-amber-700"
      >
        Undo
      </button>
    </div>
  );
}
