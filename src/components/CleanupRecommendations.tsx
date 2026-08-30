"use client";

import { useMemo, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/users-businesses/roles/useAccessLevel";
import { buildCleanupRecommendations, type CleanupConfidence } from "@/services/cleanup/recommendations";

function downloadJson(filename: string, data: unknown) {
  if (typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const CONF_STYLE: Record<CleanupConfidence, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-zinc-100 text-zinc-700",
};

// Recommendation-FIRST cleanup. Shows exactly what would be removed and why, grouped by reason, with
// confidence and checkboxes. Nothing is removed until the owner clicks the final button; a JSON backup
// downloads first and Undo is always available.
export function CleanupRecommendations() {
  const finalCounts = useScanStore((s) => s.finalCounts);
  const products = useScanStore((s) => s.products);
  const aliases = useScanStore((s) => s.aliases);
  const catalog = useScanStore((s) => s.catalog);
  const currentSession = useScanStore((s) => s.currentSession);
  const applyCleanupSelections = useScanStore((s) => s.applyCleanupSelections);
  const undoCleanup = useScanStore((s) => s.undoCleanup);
  const lastCleanupBackup = useScanStore((s) => s.lastCleanupBackup);

  // M2 fix (same leak class as F2/FinalCountTable): refreshFromCloud intentionally does an ADDITIVE
  // cross-session merge into finalCounts (a tested cross-device sync path - see
  // refreshFromCloud.store.test.ts). Cleanup recommendations must only consider the CURRENT
  // session's counts, not every session's counts merged into the store.
  const sessionFinalCounts = currentSession
    ? finalCounts.filter((c) => c.sessionId === currentSession.id)
    : finalCounts;

  const { groups, recommendations } = useMemo(
    () => buildCleanupRecommendations({ finalCounts: sessionFinalCounts, products, aliases, catalog }),
    [sessionFinalCounts, products, aliases, catalog],
  );

  const isPlatform = useIsPlatformOwner();
  const previewIdentifierBackfill = useScanStore((s) => s.previewIdentifierBackfill);
  const applyIdentifierBackfill = useScanStore((s) => s.applyIdentifierBackfill);
  const undoIdentifierBackfill = useScanStore((s) => s.undoIdentifierBackfill);
  const lastIdentifierBackfill = useScanStore((s) => s.lastIdentifierBackfill);

  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState("");
  const [backfillMsg, setBackfillMsg] = useState("");

  // Recompute each render (cheap single pass over products) so it reflects state after a backfill/undo.
  // `products` is read here only to re-run when the product list changes.
  void products;
  const backfillCandidates = isPlatform ? previewIdentifierBackfill() : [];

  function runBackfill() {
    const ids = backfillCandidates.map((c) => c.productId);
    if (ids.length === 0) { setBackfillMsg("No products need a barcode backfill."); return; }
    const res = applyIdentifierBackfill(ids);
    setBackfillMsg(`Filled the barcode field on ${res.changed} product(s) from the name. You can Undo.`);
  }
  function undoBackfill() {
    if (undoIdentifierBackfill()) setBackfillMsg("Backfill undone. Barcode fields restored.");
  }

  function review() {
    const init: Record<string, boolean> = {};
    for (const r of recommendations) init[r.id] = r.defaultChecked;
    setChecked(init);
    setOpen(true);
    setMsg("");
  }

  const selectedIds = recommendations.filter((r) => checked[r.id]).map((r) => r.id);

  function apply() {
    if (selectedIds.length === 0) {
      setMsg("Select at least one row to remove.");
      return;
    }
    const ok =
      typeof window === "undefined" ||
      window.confirm(`Remove ${selectedIds.length} selected row(s)? A JSON backup downloads first and you can Undo.`);
    if (!ok) return;
    downloadJson("inventory-backup-before-cleanup.json", {
      exportedAt: new Date().toISOString(),
      finalCounts,
      products,
      aliases,
    });
    const res = applyCleanupSelections(selectedIds);
    setMsg(`Removed ${res.removed} row(s). Backup downloaded. You can Undo below.`);
    setOpen(false);
  }

  function undo() {
    if (undoCleanup()) setMsg("Cleanup undone. Removed rows were restored.");
  }

  return (
    <div className="flex flex-col gap-3" data-testid="cleanup-recommendations">
      <p className="text-xs text-zinc-500">
        Review what is recommended for removal and why before anything is deleted. A backup file
        downloads first, and you can undo any removal. Products that have been verified or still have
        counts are never removed automatically. Changes stay on this device only.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="cleanup-review"
          onClick={review}
          className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
        >
          Review cleanup recommendations ({recommendations.length})
        </button>
        {lastCleanupBackup && (
          <button
            type="button"
            data-testid="undo-cleanup"
            onClick={undo}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Undo cleanup ({lastCleanupBackup.removedCounts.length})
          </button>
        )}
      </div>

      {isPlatform && (backfillCandidates.length > 0 || lastIdentifierBackfill) && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 p-2" data-testid="identifier-backfill">
          <span className="text-xs text-zinc-600">
            {backfillCandidates.length} product(s) have a barcode in the name but not in the barcode field. Fix this so the same product is not counted twice.
          </span>
          {backfillCandidates.length > 0 && (
            <button type="button" data-testid="backfill-apply" onClick={runBackfill}
              className="rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100">
              Backfill barcodes ({backfillCandidates.length})
            </button>
          )}
          {lastIdentifierBackfill && (
            <button type="button" data-testid="undo-backfill" onClick={undoBackfill}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
              Undo backfill ({lastIdentifierBackfill.length})
            </button>
          )}
          {backfillMsg && <span className="text-xs text-zinc-600" data-testid="backfill-msg">{backfillMsg}</span>}
        </div>
      )}

      {open && recommendations.length === 0 && (
        <p className="text-xs text-green-700" data-testid="cleanup-empty">
          No cleanup recommendations. Your inventory looks clean.
        </p>
      )}

      {open && groups.length > 0 && (
        <div className="flex flex-col gap-3 rounded border border-zinc-200 p-3" data-testid="cleanup-preview">
          {groups.map((g) => (
            <div key={g.reason} data-testid={`cleanup-group-${g.reason}`}>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-800">{g.reasonLabel}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${CONF_STYLE[g.confidence]}`}>
                  {g.confidence}
                </span>
                <span className="text-xs text-zinc-600">{g.items.length} row(s)</span>
              </div>
              <ul className="flex flex-col gap-1">
                {g.items.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      data-testid={`cleanup-item-${r.id}`}
                      checked={!!checked[r.id]}
                      onChange={(e) => setChecked((c) => ({ ...c, [r.id]: e.target.checked }))}
                    />
                    <span>
                      <span className="font-medium text-zinc-800">{r.productName}</span>{" "}
                      <span className="text-zinc-600">(qty {r.quantity})</span>
                      <br />
                      <span className="text-zinc-500">{r.explanation}</span>
                      <br />
                      <span className="text-zinc-600">
                        {r.removesProduct
                          ? `Removes the product + ${r.aliasIds.length} alias(es).`
                          : "Removes this count row only (product kept - still has other counts)."}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <button
              type="button"
              data-testid="cleanup-apply"
              onClick={apply}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
            >
              Download backup &amp; remove selected ({selectedIds.length})
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className="text-xs text-zinc-600" data-testid="cleanup-msg">
          {msg}
        </p>
      )}
    </div>
  );
}
