// src/components/UniversalImportPanel.tsx
"use client";

import { useRef, useState } from "react";
import { IMPORT_FIELD_ORDER, type ColumnMapping, type ImportField, type ImportPreview, type ImportPreviewRow, type MappedImportRow, type UniversalImportApplySummary, type UniversalSheet, type UploadFileLike } from "@/services/importSchema";
import { inferColumnMapping, validateManualMapping, type FieldTier } from "@/services/columnIntelligence";
import { readUniversalFile } from "@/services/universalFileReader";
import { buildImportPreview, describeSkippedSheets, mapUniversalRows, type PreviewMatchResult } from "@/services/universalImportPreview";
import { getIdentityConfidenceBand, identityBandWord } from "@/services/ai/identityConfidenceBand";

const PREVIEW_LIMIT = 20;

export interface UniversalImportPanelProps {
  readFile?: (file: UploadFileLike) => Promise<UniversalSheet>;
  loadMapping(sourceSignature: string): Promise<ColumnMapping | null>;
  saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void>;
  matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]>;
  onApply(rows: ImportPreviewRow[]): Promise<UniversalImportApplySummary> | UniversalImportApplySummary;
}

const FIELD_LABELS: Record<(typeof IMPORT_FIELD_ORDER)[number], string> = {
  partNumber: "Part number",
  brand: "Brand",
  model: "Model",
  size: "Size",
  quantity: "Quantity",
  uom: "Unit",
  barcode: "Barcode",
  name: "Name",
  category: "Category",
};

export function UniversalImportPanel({
  readFile = readUniversalFile,
  loadMapping,
  saveMapping,
  matchRows,
  onApply,
}: UniversalImportPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<UniversalSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [tiers, setTiers] = useState<Partial<Record<ImportField, FieldTier>>>({});
  const [mappingMode, setMappingMode] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<UniversalImportApplySummary | null>(null);

  async function previewWith(nextSheet: UniversalSheet, nextMapping: ColumnMapping, source: "header" | "content" | "manual" | "remembered") {
    const validation = validateManualMapping(nextSheet.headers, nextMapping);
    if (!validation.ok) {
      setError(`${validation.errors.join(" ")} Seen headers: ${nextSheet.headers.join(", ") || "(none)"}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const mapped = mapUniversalRows(nextSheet, nextMapping);
      const matches = await matchRows(mapped.rows);
      setPreview(buildImportPreview(mapped, matches, source));
      setMapping(nextMapping);
      setMappingMode(false);
    } catch (cause) {
      // STRESS WAVE 2 (Item 3): `cause.message || fallback`, never a bare `cause.message` - an Error
      // with an EMPTY message previously set error to "" which renders NOTHING ({error && ...}),
      // leaving the user a silent dead-end: no preview, no mapping UI, no message.
      setError((cause instanceof Error && cause.message) || "Could not build the import preview. Check your connection and try the upload again.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setSummary(null);
    try {
      const nextSheet = await readFile(file);
      setSheet(nextSheet);
      const remembered = await loadMapping(nextSheet.sourceSignature);
      if (remembered) {
        await previewWith(nextSheet, remembered, "remembered");
        return;
      }
      const inferred = inferColumnMapping([nextSheet.headers, ...nextSheet.rows]);
      setMapping(inferred.mapping);
      setTiers(inferred.tiers);
      const allHigh = Object.values(inferred.tiers).every((tier) => tier === "high");
      if (inferred.confidence === "high" && allHigh) {
        // Every mapped column is HIGH tier (exact synonym, or fuzzy header and cell content agree):
        // auto-map and go straight to the confirmed preview.
        await previewWith(nextSheet, inferred.mapping, "header");
      } else {
        // At least one MEDIUM guess: pre-fill every guess into the dropdowns and ask for a one-tap
        // confirm before importing. Nothing is applied silently under a guessed column.
        setMappingMode(true);
        setError(inferred.reasons.join(" "));
      }
    } catch (cause) {
      setSheet(null);
      setError((cause instanceof Error && cause.message) || "Could not read this file."); // never a blank error (wave 2, Item 3)
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!sheet || !preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await onApply(preview.rows);
      setSummary(result);
      await saveMapping(sheet.sourceSignature, mapping);
    } catch (cause) {
      setError((cause instanceof Error && cause.message) || "Could not apply this import."); // never a blank error (wave 2, Item 3)
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4" data-testid="universal-import-panel">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Universal inventory import</h2>
        <p className="text-sm text-zinc-600">Choose CSV, TSV, XLSX, or XLS. Nothing changes until you press Apply.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => inputRef.current?.click()} className="min-h-[44px] rounded-lg border border-zinc-300 px-4 font-medium">Choose file</button>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          data-testid="universal-import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void onFile(file);
          }}
        />
        {sheet && <span className="text-sm text-zinc-600">{sheet.fileName}</span>}
      </div>
      {error && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="import-error">{error}</p>}
      {sheet && describeSkippedSheets(sheet) && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="import-skipped-sheets">{describeSkippedSheets(sheet)}</p>
      )}
      {mappingMode && sheet && (() => {
        const mediumFields = IMPORT_FIELD_ORDER.filter((field) => tiers[field] === "medium" && mapping[field] !== undefined);
        return (
        <div className="flex flex-col gap-3" data-testid="column-mapping">
          <h3 className="font-semibold">Map the columns we saw</h3>
          {mediumFields.length > 0 && (
            <p role="status" data-testid="mapping-confirm" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              We pre-filled our best guess for {mediumFields.map((field) => FIELD_LABELS[field]).join(", ")}. Please confirm these look right, then preview.
            </p>
          )}
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead><tr>{sheet.headers.map((header, index) => <th key={`${header}-${index}`} className="px-2 py-1">{header || `(blank ${index + 1})`}</th>)}</tr></thead>
              <tbody>{sheet.rows.slice(0, 3).map((row, rowIndex) => <tr key={rowIndex}>{sheet.headers.map((_, index) => <td key={index} className="px-2 py-1">{row[index] || "-"}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {IMPORT_FIELD_ORDER.map((field) => {
              const tier = mapping[field] !== undefined ? tiers[field] : undefined;
              return (
              <label key={field} className="flex flex-col gap-1 text-sm">
                <span className="flex items-center gap-2">
                  {FIELD_LABELS[field]}
                  {tier === "high" && <span className="rounded bg-emerald-100 px-1.5 text-xs font-medium text-emerald-800" data-testid={`tier-${field}`}>Confirmed</span>}
                  {tier === "medium" && <span className="rounded bg-amber-100 px-1.5 text-xs font-medium text-amber-800" data-testid={`tier-${field}`}>Confirm this</span>}
                </span>
                <select
                  aria-label={`${FIELD_LABELS[field]} column`}
                  value={mapping[field] ?? ""}
                  onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value === "" ? undefined : Number(event.target.value) }))}
                  className={`min-h-[44px] rounded border px-2 ${tier === "medium" ? "border-amber-400 bg-amber-50" : "border-zinc-300"}`}
                >
                  <option value="">Not mapped</option>
                  {sheet.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header || `(blank ${index + 1})`}</option>)}
                </select>
              </label>
              );
            })}
          </div>
          <button type="button" disabled={busy} onClick={() => void previewWith(sheet, mapping, "manual")} className="min-h-[44px] w-fit rounded-lg bg-blue-600 px-4 font-medium text-white disabled:opacity-50">Confirm and preview</button>
        </div>
        );
      })()}
      {preview && (
        <div className="flex flex-col gap-3" data-testid="import-preview">
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
            <p className="text-xl font-bold text-emerald-900" data-testid="import-headline">{preview.headline}</p>
            <p className="text-sm text-emerald-800">{preview.exact} exact, {preview.fuzzy} fuzzy, {preview.review} review, {preview.reject} rejected</p>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead><tr><th className="px-2 py-2">Line</th><th className="px-2 py-2">Item</th><th className="px-2 py-2">Qty</th><th className="px-2 py-2">Result</th><th className="px-2 py-2">Why</th></tr></thead>
              <tbody>{preview.rows.slice(0, PREVIEW_LIMIT).map((row) => <tr key={row.line} className="border-t border-zinc-100"><td className="px-2 py-2">{row.line}</td><td className="px-2 py-2">{row.source?.expected.name ?? row.source?.partNumber ?? "Unreadable row"}</td><td className="px-2 py-2">{row.source?.quantity ?? "-"}</td><td className="px-2 py-2 font-medium">{row.status}</td><td className="px-2 py-2">{row.reason}{row.status === "exact" ? " (Exact)" : row.confidence !== null ? ` (${identityBandWord(getIdentityConfidenceBand({ confidence: row.confidence }))})` : ""}</td></tr>)}</tbody>
            </table>
          </div>
          {!summary && <button type="button" data-testid="import-apply" disabled={busy} onClick={() => void apply()} className="min-h-[44px] w-fit rounded-lg bg-blue-600 px-4 font-medium text-white disabled:opacity-50">Apply {preview.total} rows</button>}
        </div>
      )}
      {summary && <p aria-live="polite" className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900" data-testid="import-summary">Applied {summary.applied}. Needs Review {summary.queuedForReview}. Rejected {summary.rejected}.</p>}
      {busy && <p aria-live="polite" className="text-sm text-zinc-600">Working...</p>}
    </section>
  );
}
