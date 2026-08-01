"use client";

import { getSession } from "@/lib/auth";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { isLiveAuth } from "@/services/auth/authMode";
import type { ColumnMapping, MappedImportRow } from "@/services/importSchema";
import { readUniversalWorkbook } from "@/services/universalFileReader";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { mapUniversalRows } from "@/services/universalImportPreview";
import type { IdentityInput, ScopedIdentifier } from "@/services/identity/types";
import type { PreviewMatchResult } from "@/services/universalImportPreview";
import { useScanStore } from "@/stores/scanStore";

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
    const rows: IdentityInput[] = [];
    const orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }> = [];
    sheets.forEach((sheet, sheetIndex) => {
      const inference = inferColumnMapping([sheet.headers, ...sheet.rows]);
      const mapped = mapUniversalRows(sheet, inference.mapping).rows;
      orderedMappings.push({ sheetName: sheet.importedSheetName ?? sheet.fileName, mapping: Object.fromEntries(Object.entries(inference.mapping).map(([field, index]) => [field, sheet.headers[index!] ?? ""])) });
      mapped.forEach((row, rowIndex) => {
        const identifiers: ScopedIdentifier[] = [];
        if (row.barcode) identifiers.push({ type: "barcode", raw: row.barcode, normalized: row.barcode.trim(), source: "universal_import", evidenceAuthority: "vendor_import", evidenceId: `${sheetIndex}:${rowIndex}:barcode`, evidenceVersion: "v1" });
        if (row.partNumber) identifiers.push({ type: "manufacturer_part_number", raw: row.partNumber, normalized: row.partNumber.trim().toUpperCase(), namespace: row.brand.trim().toLowerCase() || "unscoped", source: "universal_import", evidenceAuthority: "vendor_import", evidenceId: `${sheetIndex}:${rowIndex}:part_number`, evidenceVersion: "v1" });
        const sourceRowNumber = sheet.sourceRowNumbers?.[rowIndex] ?? row.line;
        rows.push({ businessId: businessId || "local-demo", sourceSystem: "universal_import", sourceSignature: sheet.sourceSignature, vendorId: "local-upload", sourceFileFingerprint: `${file.name}:${file.size ?? 0}`, sourceFileOrdinal: sheetIndex + 1, sheetName: sheet.importedSheetName ?? sheet.fileName, sourceRowNumber, identifiers, brand: row.brand || undefined, title: row.name || undefined, attributes: { model: row.model, size: row.size, category: row.category }, quantity: row.quantity, unitOfMeasure: row.uom || "each", rawRecordFingerprint: `${sheet.sourceSignature}:${sourceRowNumber}` });
      });
    });
    const response = await fetch("/api/identity/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, orderedMappings, sourceFileHashes: [`${file.name}:${file.size ?? 0}`], importerVersion: "universal-import-ui-v1" }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Could not create the identity preview.");
    return body as { preview: { decisions: Array<{ kind: "automatic" | "review" | "abstain" | "non_product" | "invalid" }> }; signedPayloads: string[] };
  }

  async function applyIdentity(input: { signedPayloads: string[]; mode: "physical_count" | "reconcile"; corrections: [] }) {
    const response = await fetch("/api/identity/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Could not apply the identity preview.");
    return { applied: body.applied ?? 0, queuedForReview: body.queuedForReview ?? 0, rejected: body.rejected ?? 0 };
  }

  return (
    <UniversalImportPanel
      loadMapping={loadMapping}
      saveMapping={saveMapping}
      matchRows={matchRows}
      onApply={async (rows) => applyUniversalImport(rows)}
      localIdentity={localIdentityEnabled ? { enabled: true, canApply: localRole !== "counter" && localRole !== "viewer", readWorkbook: readUniversalWorkbook, previewIdentity, applyIdentity } : undefined}
    />
  );
}
