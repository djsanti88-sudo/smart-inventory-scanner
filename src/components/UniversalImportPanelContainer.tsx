"use client";

import { getSession } from "@/lib/auth";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { isLiveAuth } from "@/services/auth/authMode";
import type { ColumnMapping, MappedImportRow, UniversalSheet, UploadFileLike } from "@/services/importSchema";
import { readUniversalWorkbook } from "@/services/universalFileReader";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { mapUniversalRows } from "@/services/universalImportPreview";
import type { IdentityInput, ScopedIdentifier } from "@/services/identity/types";
import type { PreviewMatchResult } from "@/services/universalImportPreview";
import { useScanStore } from "@/stores/scanStore";

type LocalPreviewRequest = {
  rows: IdentityInput[];
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  sourceFileHashes: string[];
  importerVersion: string;
};

/** Browser-only shaping: every physical source row becomes one engine input in stable source order. */
export function buildLocalIdentityPreviewRequest({ file, sheets, businessId }: { file: Pick<UploadFileLike, "name" | "size">; sheets: UniversalSheet[]; businessId: string }): LocalPreviewRequest {
  const rows: IdentityInput[] = [];
  const orderedMappings: LocalPreviewRequest["orderedMappings"] = [];
  const fileFingerprint = `${file.name}:${file.size ?? 0}`;
  sheets.forEach((sheet, sheetIndex) => {
    const inference = inferColumnMapping([sheet.headers, ...sheet.rows]);
    const mapping = inference.mapping;
    orderedMappings.push({ sheetName: sheet.importedSheetName ?? sheet.fileName, mapping: Object.fromEntries(Object.entries(mapping).map(([field, index]) => [field, sheet.headers[index!] ?? ""])) });
    const mapped = mapUniversalRows(sheet, mapping);
    const mappedByLine = new Map([...mapped.rows, ...mapped.heldForReview.flatMap((item) => item.source ? [item.source] : [])].map((item) => [item.line, item]));
    sheet.rows.forEach((cells, rowIndex) => {
      const physicalRow = sheet.sourceRowNumbers?.[rowIndex] ?? sheet.headerRowIndex + rowIndex + 2;
      const line = sheet.headerRowIndex + rowIndex + 2;
      const item = mappedByLine.get(line);
      const value = (field: keyof ColumnMapping) => mapping[field] === undefined ? "" : cells[mapping[field]!] ?? "";
      const barcode = item?.barcode ?? value("barcode");
      const partNumber = item?.partNumber ?? value("partNumber");
      const brand = item?.brand ?? value("brand");
      const identifiers: ScopedIdentifier[] = [];
      if (barcode.trim()) identifiers.push({ type: "barcode", raw: barcode, normalized: barcode.trim(), namespace: "local-upload", source: "universal_import", evidenceAuthority: "vendor_import", evidenceId: `${sheetIndex}:${physicalRow}:barcode`, evidenceVersion: "v1" });
      if (partNumber.trim()) identifiers.push({ type: "manufacturer_part_number", raw: partNumber, normalized: partNumber.trim().toUpperCase(), namespace: brand.trim().toLowerCase() || "local-upload", source: "universal_import", evidenceAuthority: "vendor_import", evidenceId: `${sheetIndex}:${physicalRow}:part_number`, evidenceVersion: "v1" });
      const quantityText = item ? String(item.quantity) : value("quantity");
      const parsedQuantity = Number(quantityText);
      rows.push({
        businessId: businessId || "local-demo", sourceSystem: "universal_import", sourceSignature: fileFingerprint,
        vendorId: "local-upload", sourceFileFingerprint: fileFingerprint, sourceFileOrdinal: sheet.sheetOrdinal ?? sheetIndex + 1,
        sheetName: sheet.importedSheetName ?? sheet.fileName, sourceRowNumber: physicalRow, identifiers,
        brand: brand || undefined, title: item?.name || value("name") || `Source row ${physicalRow}`,
        attributes: { model: item?.model ?? value("model"), size: item?.size ?? value("size"), category: item?.category ?? value("category"), adapterStatus: item ? (mapped.rows.includes(item) ? "mapped" : "held") : "invalid" },
        quantity: Number.isSafeInteger(parsedQuantity) && parsedQuantity >= 0 ? parsedQuantity : 0,
        unitOfMeasure: item?.uom || value("uom") || "each",
        rawRecordFingerprint: `${fileFingerprint}:${sheet.sheetOrdinal ?? sheetIndex + 1}:${sheet.importedSheetName ?? sheet.fileName}:${physicalRow}`,
      });
    });
  });
  return { rows, orderedMappings, sourceFileHashes: [fileFingerprint], importerVersion: "universal-import-ui-v1" };
}

async function token(): Promise<string | undefined> {
  if (!isLiveAuth()) return undefined;
  const user = await getSession();
  if (!user) throw new Error("Sign in required.");
  return user.getIdToken();
}

export function UniversalImportPanelContainer() {
  const businessId = useScanStore((state) => state.businessId);
  const applyUniversalImport = useScanStore((state) => state.applyUniversalImport);
  const isLocalDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
  const localIdentityEnabled = process.env.NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1 === "1" && !isLiveAuth();
  const localRole = process.env.NEXT_PUBLIC_LOCAL_IDENTITY_ROLE;

  if (isLocalDemo) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" data-testid="local-demo-import-unavailable">
        Import is unavailable in the certified local tire demo.
      </section>
    );
  }

  async function loadMapping(sourceSignature: string): Promise<ColumnMapping | null> {
    // No businessId yet (e.g. a fresh signup with no business membership resolved/selected): there is
    // nothing to look up server-side. Skip the network call entirely rather than firing a request the
    // server will 400/403 on, which used to throw and kill the whole import panel with a false "could
    // not load the remembered mapping" error even though there was simply no mapping to try.
    if (!businessId) return null;
    const idToken = await token();
    const query = new URLSearchParams({ businessId, sourceSignature });
    const response = await fetch(`/api/import-mapping?${query.toString()}`, {
      cache: "no-store",
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
    });
    if (!response.ok) throw new Error("Could not load the remembered column mapping.");
    return (await response.json() as { mapping: ColumnMapping | null }).mapping;
  }

  async function saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void> {
    // Same short-circuit as loadMapping: no businessId means there is no per-business memory to save.
    if (!businessId) return;
    const idToken = await token();
    const response = await fetch("/api/import-mapping", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, sourceSignature, mapping, ...(idToken ? { idToken } : {}) }),
    });
    if (!response.ok) throw new Error("Import applied, but the column mapping could not be remembered.");
  }

  async function matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]> {
    const idToken = await token();
    const response = await fetch("/api/reconcile/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: rows.map((row) => row.expected),
        businessId,
        ...(idToken ? { idToken } : {}),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Could not match the uploaded rows.");
    return body.matches as PreviewMatchResult[];
  }

  async function previewIdentity({ file, sheets }: { file: { name: string; size?: number }; sheets: Awaited<ReturnType<typeof readUniversalWorkbook>> }) {
    const request = buildLocalIdentityPreviewRequest({ file, sheets, businessId });
    const response = await fetch("/api/identity/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Could not create the identity preview.");
    return body as { preview: { decisions: Array<{ kind: "automatic" | "review" | "abstain" | "non_product" | "invalid" }> }; signedPayloads: string[] };
  }

  async function applyIdentity(input: { signedPayloads: string[]; mode: "physical_count" | "reconcile"; corrections: [] }) {
    const response = await fetch("/api/identity/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Object.assign(new Error(body.error ?? "Could not apply the identity preview."), { code: body.code ?? (response.status === 409 ? "apply_target_stale" : undefined) });
      throw error;
    }
    return { applied: body.applied ?? 0, queuedForReview: body.queuedForReview ?? 0, rejected: body.rejected ?? 0 };
  }

  return (
    <UniversalImportPanel
      loadMapping={loadMapping}
      saveMapping={saveMapping}
      matchRows={matchRows}
      onApply={async (rows) => applyUniversalImport(rows)}
      localIdentity={localIdentityEnabled ? { enabled: true, role: localRole, mode: "physical_count", readWorkbook: readUniversalWorkbook, previewIdentity, applyIdentity } : undefined}
    />
  );
}
