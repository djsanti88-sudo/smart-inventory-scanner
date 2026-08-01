"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { parseShopwareCsv, parseShopwareUnitCosts } from "@/services/reconcile/shopwareCsvAdapter";
import { mapUniversalSheetToAdapterResult, extractUniversalUnitCosts } from "@/services/reconcile/universalAdapter";
import { computeDollarVariance } from "@/services/reconcile/dollarVariance";
import { buildReconcileReport, reconcileReportCsv, type ReconcileBucket, type ReconcileLine } from "@/services/reconcile/reconcileReport";
import type { MatchResult } from "@/services/reconcile/identityMatcher";
import type { AdapterResult } from "@/services/reconcile/types";
import { deriveCountedByUid } from "@/services/reconcile/countedByUid";
import { resolveRawScan } from "@/services/resolver";
import { cleanScanCode } from "@/services/scanCleaner";
import { downloadCsv } from "@/services/exportFormats";
import { getSession } from "@/lib/auth";
import { isLiveAuth } from "@/services/auth/authMode";
import { readUniversalFile, readUniversalWorkbook } from "@/services/universalFileReader";
import { inferColumnMapping, validateManualMapping } from "@/services/columnIntelligence";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { buildLocalIdentityPreviewRequest } from "@/components/UniversalImportPanelContainer";

// Reconcile panel (Task 7, de-branded + universal intake M3/H1): upload an inventory export (CSV,
// TSV, or Excel), match it against the local tire corpus server-side, and compare the expected
// quantities with what THIS session counted. Its own page, far from the scan flow (scanner flow
// untouched).
//
// Intake (M3/H1): a Shop-Ware-style CSV runs through the fast, well-tested parseShopwareCsv path
// first (unchanged). Anything else - TSV, XLSX, XLS, or a CSV whose columns Shop-Ware's own
// synonyms cannot place - falls back to the SAME readUniversalFile + inferColumnMapping stack
// Universal Import uses (read-only reuse; see universalAdapter.ts for the reconcile-shaped mapper).
//
// Dollar variance (M3/H1): an opt-in "include unit cost" checkbox captures a per-SKU cost column
// LOCALLY ONLY (reconcileStore's separate `unitCosts` field, never part of `session.adapter`, so it
// structurally cannot reach the /api/reconcile/match request body below - see the guard test in
// ReconcilePanel.test.tsx). When priced, the report shows a "$X variance across N SKUs" headline.
//
// AM-R6 (Resolver Trust law): a reconcile match NEVER writes an alias by itself. Matched rows with
// a corpus barcode appear in the "Confirm barcode links" list below; clicking Confirm routes
// through the EXISTING scanStore human-approval path (reopenNeedsReview -> resolveUnknown
// "link_existing", applyToCount false) - the exact machinery Needs Review resolution uses. No new
// alias-approval path exists in this file, and nothing here counts inventory.

const BUCKET_ORDER: ReconcileBucket[] = [
  "variance",
  "agreement",
  "expected_not_counted",
  "ambiguous",
  "unmatched",
  "non_tire",
  "uom_review",
  "unparseable",
];

const BUCKET_LABELS: Record<ReconcileBucket, string> = {
  variance: "Variances (your count differs from the imported file)",
  agreement: "Matches in agreement",
  expected_not_counted: "Expected but not counted in this session (out of scope, not shrinkage)",
  ambiguous: "Ambiguous (needs review)",
  unmatched: "Unmatched",
  non_tire: "Not a tire product",
  uom_review: "Quantity unit needs review",
  unparseable: "Rows that could not be read",
};

function deltaClass(delta: number): string {
  if (delta > 0) return "text-green-700";
  if (delta < 0) return "text-red-700";
  return "text-zinc-600";
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function ReconcilePanel() {
  const session = useReconcileStore((s) => s.session);
  const matches = useReconcileStore((s) => s.matches);
  const report = useReconcileStore((s) => s.report);
  const unitCosts = useReconcileStore((s) => s.unitCosts);
  const hydrated = useReconcileStore((s) => s._hasHydrated);
  const startSession = useReconcileStore((s) => s.startSession);
  const setResults = useReconcileStore((s) => s.setResults);

  const products = useScanStore((s) => s.products);
  const aliases = useScanStore((s) => s.aliases);
  const finalCounts = useScanStore((s) => s.finalCounts);
  const currentSession = useScanStore((s) => s.currentSession);
  const businessId = useScanStore((s) => s.businessId);

  // M2 fix (same leak class as F2/FinalCountTable): refreshFromCloud intentionally does an ADDITIVE
  // cross-session merge into finalCounts (a tested cross-device sync path - see
  // refreshFromCloud.store.test.ts). The reconcile comparison must use only the CURRENT session's
  // counts, not every session's counts merged into the store.
  const sessionFinalCounts = currentSession
    ? finalCounts.filter((c) => c.sessionId === currentSession.id)
    : finalCounts;

  const [importError, setImportError] = useState("");
  const [matchError, setMatchError] = useState("");
  const [running, setRunning] = useState(false);
  const [includeUnitCost, setIncludeUnitCost] = useState(false);
  const localIdentityEnabled = process.env.NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1 === "1" && !isLiveAuth();

  if (localIdentityEnabled) {
    const previewIdentity = async ({ file, sheets }: { file: { name: string; size?: number }; sheets: Awaited<ReturnType<typeof readUniversalWorkbook>> }) => {
      const response = await fetch("/api/identity/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildLocalIdentityPreviewRequest({ file, sheets, businessId })) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not create the reconcile preview.");
      return body as { preview: { decisions: Array<{ kind: "automatic" | "review" | "abstain" | "non_product" | "invalid" }> }; signedPayloads: string[] };
    };
    const applyIdentity = async (input: { signedPayloads: string[]; mode: "physical_count" | "reconcile"; corrections: [] }) => {
      const response = await fetch("/api/identity/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error ?? "Could not apply the reconcile preview."), { code: body.code ?? (response.status === 409 ? "apply_target_stale" : undefined) });
      return { applied: body.applied ?? 0, queuedForReview: body.queuedForReview ?? 0, rejected: body.rejected ?? 0 };
    };
    return <UniversalImportPanel
      fileTestId="reconcile-file"
      loadMapping={async () => null} saveMapping={async () => undefined} matchRows={async () => []}
      onApply={async () => ({ applied: 0, queuedForReview: 0, rejected: 0 })}
      localIdentity={{ enabled: true, role: process.env.NEXT_PUBLIC_LOCAL_IDENTITY_ROLE, mode: "reconcile", readWorkbook: readUniversalWorkbook, previewIdentity, applyIdentity }}
    />;
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const isCsv = file.name.trim().toLowerCase().endsWith(".csv");
      let adapterResult: AdapterResult | null = null;
      let unitCostsFromFile: Record<string, number> = {};

      if (isCsv) {
        // Fast path (unchanged): a Shop-Ware-style CSV export whose columns Shop-Ware's own
        // synonyms recognize goes through the existing, well-tested parser directly.
        const text = await file.text();
        const fast = parseShopwareCsv(text);
        if (fast.rows.length > 0 || fast.uomReview.length > 0) {
          adapterResult = fast;
          if (includeUnitCost) unitCostsFromFile = parseShopwareUnitCosts(text);
        }
      }

      if (!adapterResult) {
        // Universal fallback (M3/H1): TSV, XLSX, XLS, or any CSV Shop-Ware's synonyms could not
        // place. Reuses the SAME parse + column-mapping intelligence Universal Import uses.
        // The flagged local identity path must never silently select workbook tab one. It keeps
        // every sheet in source order; legacy callers retain their single-sheet compatibility seam.
        const sheets = process.env.NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1 === "1" && !isLiveAuth()
          ? await readUniversalWorkbook(file)
          : [await readUniversalFile(file)];
        const mapped = sheets.map((sheet) => {
          const inference = inferColumnMapping([sheet.headers, ...sheet.rows]);
          const validation = validateManualMapping(sheet.headers, inference.mapping);
          if (!validation.ok) throw new Error(`Nothing was imported: ${validation.errors.join(" ")} Seen headers: ${sheet.headers.join(", ") || "(none)"}.`);
          return { result: mapUniversalSheetToAdapterResult(sheet, inference.mapping), costs: includeUnitCost ? extractUniversalUnitCosts(sheet, inference.mapping) : {} };
        });
        adapterResult = {
          rows: mapped.flatMap(({ result }) => result.rows), uomReview: mapped.flatMap(({ result }) => result.uomReview),
          unparseable: mapped.flatMap(({ result }) => result.unparseable), assumptions: mapped.flatMap(({ result }) => result.assumptions),
        };
        unitCostsFromFile = Object.assign({}, ...mapped.map(({ costs }) => costs));
      }

      if (adapterResult.rows.length === 0 && adapterResult.uomReview.length === 0) {
        const reason = adapterResult.unparseable[0]?.reason ?? "no usable rows found";
        setImportError(`Nothing was imported: ${reason}`);
        return; // app state unchanged on a bad file
      }
      setImportError("");
      setMatchError("");
      startSession(adapterResult, file.name, unitCostsFromFile); // AM-R9: REPLACES any prior session
    } catch (cause) {
      setImportError((cause instanceof Error && cause.message) || "Could not read this file. Try choosing it again.");
    } finally {
      // Allow re-selecting the same file to re-import.
      e.target.value = "";
    }
  }

  async function onRunCompare() {
    if (!session || running) return;
    setRunning(true);
    setMatchError("");
    try {
      const user = isLiveAuth() ? await getSession() : null;
      const idToken = user ? await user.getIdToken() : undefined;
      const res = await fetch("/api/reconcile/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: session.adapter.rows, businessId, ...(idToken ? { idToken } : {}) }),
      });
      if (!res.ok) {
        setMatchError(`The match request failed (status ${res.status}). Your imported file is still here - try again.`);
        return;
      }
      const body = (await res.json()) as { matches: MatchResult[] };
      const countedByUid = deriveCountedByUid(body.matches, products, aliases, sessionFinalCounts, businessId);
      const builtReport = buildReconcileReport({ matches: body.matches, adapter: session.adapter, countedByUid });
      setResults(body.matches, builtReport);
    } catch {
      setMatchError("Could not reach the server to run the match. Check your connection and try again. Your imported file is still here.");
    } finally {
      setRunning(false);
    }
  }

  function onExportCsv() {
    if (!report) return;
    downloadCsv(reconcileReportCsv(report), "reconcile-report");
  }

  /** AM-R6: route confirmation through the EXISTING human-approval path. */
  function onConfirmLink(barcode: string, partNumber: string, productId: string) {
    const scan = useScanStore.getState();
    const reviewId = scan.reopenNeedsReview(
      barcode,
      `Reconcile: confirm ${barcode} as a scan code for part number ${partNumber}.`,
    );
    if (!reviewId) return;
    scan.resolveUnknown(reviewId, "link_existing", { productId, applyToCount: false });
  }

  // Linkage suggestions from matched rows (AM-R6): confirm-able only when the part number already
  // resolves deterministically to a local product (approved alias or verified identifier).
  const linkItems = (matches ?? []).flatMap((m) => {
    const link = m.linkageSuggestion;
    if (!link) return [];
    const cleanBarcode = cleanScanCode(link.barcode).cleanCode;
    const alreadyLinked = aliases.some((a) => a.cleanCode === cleanBarcode && a.approved);
    const res = resolveRawScan(link.partNumber, products, aliases, businessId);
    const target =
      res.resolverStatus === "known" && res.productId
        ? products.find((p) => p.id === res.productId) ?? null
        : null;
    return [{ link, cleanBarcode, alreadyLinked, target }];
  });

  const dollarVariance = report ? computeDollarVariance(report, unitCosts) : null;

  if (!hydrated) {
    return <p className="p-4 text-base text-zinc-600">Loading saved reconcile session...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h1 className="text-lg font-semibold text-zinc-900">Reconcile your inventory export</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Upload an inventory export (CSV, TSV, or Excel). The app matches each row against the
          tire catalog and compares the expected quantities with what you counted in this session.
          Importing a new file replaces the previous one.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="Inventory export file"
            data-testid="reconcile-file"
            onChange={(e) => void onFileChosen(e)}
            className="text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              data-testid="reconcile-include-cost"
              checked={includeUnitCost}
              onChange={(e) => setIncludeUnitCost(e.target.checked)}
            />
            Include unit cost from this file for dollar variance (stored on this device only, never sent to the server)
          </label>
          {session && (
            <button
              type="button"
              data-testid="reconcile-run"
              onClick={() => void onRunCompare()}
              disabled={running}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {running ? "Comparing..." : "Run compare"}
            </button>
          )}
        </div>
        {importError && (
          <p data-testid="reconcile-import-error" className="mt-2 text-sm font-medium text-red-700">
            {importError}
          </p>
        )}
        {matchError && (
          <p data-testid="reconcile-match-error" className="mt-2 text-sm font-medium text-red-700">
            {matchError}
          </p>
        )}
        {session && (
          <p className="mt-2 text-sm text-zinc-600" data-testid="reconcile-session-summary">
            Imported {session.fileName}: {session.adapter.rows.length} rows
            {session.adapter.uomReview.length > 0 ? `, ${session.adapter.uomReview.length} held for unit review` : ""}
            {session.adapter.unparseable.length > 0 ? `, ${session.adapter.unparseable.length} unreadable` : ""}.
          </p>
        )}
      </div>

      {!session && (
        <p data-testid="reconcile-empty-state" className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-base text-zinc-600">
          No file imported yet. Choose an inventory export above to compare expected inventory
          with what you counted.
        </p>
      )}

      {session && !report && (
        <p data-testid="reconcile-no-report-yet" className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-base text-zinc-600">
          File imported. Click &quot;Run compare&quot; to match it against the catalog and your counted session.
        </p>
      )}

      {report && (
        <div data-testid="reconcile-report" className="rounded-lg border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-zinc-900">Reconcile report</h2>
            <button
              type="button"
              data-testid="reconcile-export-csv"
              onClick={onExportCsv}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Export CSV
            </button>
          </div>

          {dollarVariance && dollarVariance.skuCount > 0 && (
            <p data-testid="reconcile-dollar-variance" className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-base font-semibold text-zinc-900">
              ${dollarVariance.totalDollarVariance.toFixed(2)} variance across {dollarVariance.skuCount} SKUs
            </p>
          )}

          {report.assumptions.length > 0 && (
            <p data-testid="reconcile-assumptions" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
              {report.assumptions.join(" ")}
            </p>
          )}

          <div className="flex flex-col gap-4 p-4">
            {BUCKET_ORDER.filter((b) => report.totals[b] > 0).map((bucket) => (
              <BucketSection
                key={bucket}
                bucket={bucket}
                label={BUCKET_LABELS[bucket]}
                lines={report.lines.filter((l) => l.bucket === bucket)}
              />
            ))}
            {report.lines.length === 0 && (
              <p className="text-base text-zinc-600">The report has no rows.</p>
            )}
          </div>
        </div>
      )}

      {linkItems.length > 0 && (
        <div data-testid="confirm-links" className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-900">Confirm barcode links</h2>
          <p className="mt-1 text-sm text-zinc-600">
            These barcodes came from catalog rows that matched your file. Nothing is saved until
            you confirm a link. A confirmed link becomes an approved scan code for that product.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {linkItems.map(({ link, cleanBarcode, alreadyLinked, target }) => (
              <li key={cleanBarcode} className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-100 px-3 py-2">
                <span className="text-sm text-zinc-700">
                  <span className="font-mono">{link.barcode}</span>
                  {" for part number "}
                  <span className="font-mono">{link.partNumber}</span>
                  {target ? ` (${target.name})` : ""}
                </span>
                {alreadyLinked ? (
                  <span className="text-sm font-medium text-green-700">Linked</span>
                ) : target ? (
                  <button
                    type="button"
                    data-testid={`confirm-link-${cleanBarcode}`}
                    onClick={() => onConfirmLink(link.barcode, link.partNumber, target.id)}
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-blue-300 bg-blue-50 px-4 text-sm font-medium text-blue-800 hover:bg-blue-100"
                  >
                    Confirm link
                  </button>
                ) : (
                  <span className="text-sm text-zinc-500">
                    No product in your inventory matches part number {link.partNumber} yet, so
                    there is nothing to link it to.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BucketSection({ bucket, label, lines }: { bucket: ReconcileBucket; label: string; lines: ReconcileLine[] }) {
  return (
    <section data-testid={`bucket-${bucket}`}>
      <h3 className="mb-2 text-base font-semibold text-zinc-800">
        {label} ({lines.length})
      </h3>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
            <tr>
              <th scope="col" className="px-3 py-2">Part numbers</th>
              <th scope="col" className="px-3 py-2">Brand</th>
              <th scope="col" className="px-3 py-2">Model</th>
              <th scope="col" className="px-3 py-2">Size</th>
              <th scope="col" className="px-3 py-2">Expected qty</th>
              <th scope="col" className="px-3 py-2">Counted qty</th>
              <th scope="col" className="px-3 py-2">Delta</th>
              <th scope="col" className="px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={`${bucket}-${i}`} className="border-t border-zinc-100 align-top">
                <td className="px-3 py-2 font-mono">{l.partNumbers.join(", ")}</td>
                <td className="px-3 py-2">{l.brand ?? ""}</td>
                <td className="px-3 py-2">{l.model ?? ""}</td>
                <td className="px-3 py-2">{l.sizeText ?? ""}</td>
                <td className="px-3 py-2 tabular-nums">{l.expectedQty ?? ""}</td>
                <td className="px-3 py-2 tabular-nums">{l.countedQty ?? ""}</td>
                <td
                  data-testid="reconcile-delta"
                  className={`px-3 py-2 font-semibold tabular-nums ${l.delta === undefined ? "text-zinc-400" : deltaClass(l.delta)}`}
                >
                  {l.delta === undefined ? "" : formatDelta(l.delta)}
                </td>
                <td className="px-3 py-2 text-zinc-600">{l.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
