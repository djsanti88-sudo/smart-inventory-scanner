"use client";

import { getSession } from "@/authentication/auth";
import { UniversalImportPanel } from "@/import/UniversalImportPanel";
import { isLiveAuth } from "@/authentication/service/authMode";
import type { ColumnMapping, MappedImportRow } from "@/import/importSchema";
import type { PreviewMatchResult } from "@/import/universalImportPreview";
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

  return (
    <UniversalImportPanel
      loadMapping={loadMapping}
      saveMapping={saveMapping}
      matchRows={matchRows}
      onApply={async (rows) => applyUniversalImport(rows)}
    />
  );
}
