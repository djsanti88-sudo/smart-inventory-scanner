"use client";

import { useEffect, useMemo, useState } from "react";
import { buildLocalDemoLedgerProof, type LocalDemoLedgerProof, type LocalDemoLockedBatch } from "@/services/reports/localDemoLedgerProof";
import { useScanStore } from "@/stores/scanStore";

type ProofResult = LocalDemoLedgerProof | { schemaVersion: 1; passed: false; error: string };
type VerifiedManifest = {
  proofBatch: string;
  sessionId: string;
  generatedAt: string;
  batch: LocalDemoLockedBatch;
};
type ManifestResult =
  | { proofBatch: string; sessionId: string; status: "failed"; value: ProofResult }
  | ({ status: "verified" } & VerifiedManifest);

type ManifestRow = LocalDemoLockedBatch["rows"][number] & Record<string, unknown>;

const BATCH_PATTERN = /^(?:0[1-9]|[12][0-9]|30)$/;
const PAYLOAD_KEYS = [
  "schemaVersion", "gitSha", "databaseSha256", "manifestSha256", "seed", "batch", "agent", "rowCount",
  "batchSha256", "expectedBarcodesSha256", "expectedCanonicalProductUidsSha256", "rows",
] as const;
const ROW_KEYS = [
  "barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size", "loadIndex", "speedRating",
  "manufacturerPartNumber", "type", "season", "sourceCount", "confidence", "currentStatus", "usableFor",
  "fieldCompletenessScore", "angle", "stratum", "ordinal", "batch", "agent",
] as const;

function failed(error: string): ProofResult {
  return { schemaVersion: 1, passed: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isManifestRow(value: unknown, batch: number, agent: number): value is ManifestRow {
  if (!isRecord(value) || !hasExactKeys(value, ROW_KEYS)) return false;
  return typeof value.barcode === "string" && /^\d{8,14}$/.test(value.barcode) &&
    typeof value.canonicalProductUid === "string" && value.canonicalProductUid.length > 0 && value.canonicalProductUid.length <= 200 &&
    typeof value.sourceCount === "number" && Number.isSafeInteger(value.sourceCount) &&
    typeof value.fieldCompletenessScore === "number" && Number.isFinite(value.fieldCompletenessScore) &&
    Number.isSafeInteger(value.ordinal) && value.batch === batch && value.agent === agent &&
    ["barcodeType", "brand", "model", "size", "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season", "confidence", "currentStatus", "usableFor", "angle", "stratum"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).length <= 500,
    );
}

async function sha256Json(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Browser SHA-256 is unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateManifest(payload: unknown, batchText: string): Promise<LocalDemoLockedBatch> {
  if (!isRecord(payload) || !hasExactKeys(payload, PAYLOAD_KEYS)) throw new Error("Malformed manifest payload");
  const batch = Number(batchText);
  const agent = Math.floor((batch - 1) / 3) + 1;
  if (
    payload.schemaVersion !== 1 || typeof payload.gitSha !== "string" || !/^[a-f0-9]{7,64}$/i.test(payload.gitSha) ||
    !isSha256(payload.databaseSha256) || !isSha256(payload.manifestSha256) || typeof payload.seed !== "string" ||
    payload.seed.length < 1 || payload.seed.length > 200 || payload.batch !== batch || payload.agent !== agent || payload.rowCount !== 100 ||
    !isSha256(payload.batchSha256) || !isSha256(payload.expectedBarcodesSha256) || !isSha256(payload.expectedCanonicalProductUidsSha256) ||
    !Array.isArray(payload.rows) || payload.rows.length !== 100 || !payload.rows.every((row) => isManifestRow(row, batch, agent))
  ) throw new Error("Malformed manifest payload");
  const rows = payload.rows as ManifestRow[];
  if (new Set(rows.map((row) => row.barcode)).size !== 100 || new Set(rows.map((row) => row.canonicalProductUid)).size !== 100) {
    throw new Error("Invalid manifest allocation");
  }
  const [batchSha256, expectedBarcodesSha256, expectedCanonicalProductUidsSha256] = await Promise.all([
    sha256Json(rows), sha256Json(rows.map((row) => row.barcode)), sha256Json(rows.map((row) => row.canonicalProductUid)),
  ]);
  if (batchSha256 !== payload.batchSha256 || expectedBarcodesSha256 !== payload.expectedBarcodesSha256 || expectedCanonicalProductUidsSha256 !== payload.expectedCanonicalProductUidsSha256) {
    throw new Error("Manifest hash mismatch");
  }
  return {
    schemaVersion: 1, gitSha: payload.gitSha, databaseSha256: payload.databaseSha256, manifestSha256: payload.manifestSha256,
    seed: payload.seed, batch,
    batchSha256: payload.batchSha256, expectedBarcodesSha256: payload.expectedBarcodesSha256,
    expectedCanonicalProductUidsSha256: payload.expectedCanonicalProductUidsSha256,
    rows: rows.map(({ barcode, canonicalProductUid }) => ({ barcode, canonicalProductUid })),
  };
}

export function LocalDemoLedgerProof({ proofBatch }: { proofBatch: string }) {
  const sessionId = useScanStore((state) => state.sessionId);
  const scanFeed = useScanStore((state) => state.scanFeed);
  const finalCounts = useScanStore((state) => state.finalCounts);
  const isLocalDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
  const [manifestResult, setManifestResult] = useState<ManifestResult | null>(null);
  const immediateError = !isLocalDemo ? "Local demo disabled" : !BATCH_PATTERN.test(proofBatch)
    ? "Invalid proof batch"
    : !sessionId ? "Missing active session" : null;

  useEffect(() => {
    let active = true;
    if (immediateError) return () => { active = false; };
    void (async () => {
      try {
        const response = await fetch(`/api/local-demo/manifest/${proofBatch}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Manifest request failed");
        const batch = await validateManifest(await response.json(), proofBatch);
        if (active) setManifestResult({
          proofBatch,
          sessionId,
          status: "verified",
          generatedAt: new Date().toISOString(),
          batch,
        });
      } catch (error) {
        if (active) setManifestResult({
          proofBatch,
          sessionId,
          status: "failed",
          value: failed(error instanceof Error ? error.message : "Proof failed"),
        });
      }
    })();
    return () => { active = false; };
  }, [proofBatch, sessionId, immediateError]);

  const output = useMemo<ProofResult>(() => {
    if (immediateError) return failed(immediateError);
    if (manifestResult?.proofBatch !== proofBatch || manifestResult.sessionId !== sessionId) {
      return failed("Proof pending");
    }
    if (manifestResult.status === "failed") return manifestResult.value;
    try {
      return buildLocalDemoLedgerProof({
        batch: manifestResult.batch,
        sessionId,
        scanFeed,
        finalCounts,
        generatedAt: manifestResult.generatedAt,
      });
    } catch {
      return failed("Ledger proof failed");
    }
  }, [immediateError, manifestResult, proofBatch, sessionId, scanFeed, finalCounts]);

  if (!isLocalDemo) return null;
  const passed = "assertions" in output ? output.assertions.passed : output.passed;
  return <section aria-live="polite"><p>{passed ? "PASS" : "FAIL"}</p><pre data-testid="local-demo-ledger-proof">{JSON.stringify(output, null, 2)}</pre></section>;
}
