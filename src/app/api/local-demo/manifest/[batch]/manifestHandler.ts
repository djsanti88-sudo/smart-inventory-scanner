import "server-only";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isLocalDemo } from "@/server/localDemo";
import {
  computeLocalDemoBatchHashes,
  computeLocalDemoManifestHash,
  hasExactLocalDemoManifestAllocation,
  hasExactKeys,
  isSha256,
  LocalDemoBatchRow,
  readContainedJson,
} from "@/server/localDemoArtifacts";
import {
  isLoopbackRequest,
  localDemoEvidenceErrorResponse,
  localDemoNoStoreHeaders,
  localDemoNotFoundResponse,
} from "@/server/localDemoHttp";
import { isTrustedLocalDemoTireRow } from "@/server/tire-knowledge/localDemoTrust.mjs";

type PreflightResult = { databaseSha256: string };
type ManifestOptions = {
  reportsRoot: string;
  preflight: () => PreflightResult;
  expectedGitSha?: () => string | undefined;
  expectedDatabaseSha256?: () => string | undefined;
};
type RouteContext = { params: Promise<{ batch: string }> };

const ACTIVE_KEYS = ["schemaVersion", "runDirectory", "gitSha", "databaseSha256", "manifestSha256", "generatedAt"] as const;
const BATCH_KEYS = ["schemaVersion", "seed", "gitSha", "databaseSha256", "batch", "agent", "rowCount", "batchSha256", "expectedBarcodesSha256", "expectedCanonicalProductUidsSha256", "rows"] as const;
const MANIFEST_KEYS = ["schemaVersion", "seed", "gitSha", "databaseSha256", "generatedAt", "total", "batchSize", "batchCount", "agentCount", "manifestSha256", "rows"] as const;
const ROW_KEYS = ["barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size", "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season", "sourceCount", "confidence", "currentStatus", "usableFor", "fieldCompletenessScore", "angle", "stratum", "ordinal", "batch", "agent"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRow(value: unknown, batch: number): value is LocalDemoBatchRow {
  if (!isRecord(value) || !hasExactKeys(value, ROW_KEYS)) return false;
  const trusted = isTrustedLocalDemoTireRow({
    barcode: value.barcode,
    barcode_type: value.barcodeType,
    canonical_product_uid: value.canonicalProductUid,
    brand: value.brand,
    model: value.model,
    size: value.size,
    current_status: value.currentStatus,
    usable_for: value.usableFor,
    source_count: value.sourceCount,
  });
  return trusted &&
    Number.isSafeInteger(value.ordinal) &&
    value.batch === batch &&
    Number.isSafeInteger(value.agent) &&
    typeof value.barcode === "string" &&
    /^\d{8,14}$/.test(value.barcode) &&
    typeof value.canonicalProductUid === "string" &&
    value.canonicalProductUid.length > 0 &&
    value.canonicalProductUid.length <= 200 &&
    Number.isSafeInteger(value.sourceCount) &&
    Number.isFinite(value.fieldCompletenessScore) &&
    ["barcodeType", "brand", "model", "size", "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season", "confidence", "currentStatus", "usableFor", "angle", "stratum"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).length <= 500,
    );
}

export function createLocalDemoManifestHandler(options: ManifestOptions) {
  return async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
    if (!isLocalDemo() || !isLoopbackRequest(request)) return localDemoNotFoundResponse();
    const { batch: batchText } = await context.params;
    if (!/^(?:0[1-9]|[12][0-9]|30)$/.test(batchText)) {
      return NextResponse.json({ error: "Invalid batch", localDemo: true }, { status: 400, headers: localDemoNoStoreHeaders });
    }
    try {
      const batch = Number(batchText);
      const active = readContainedJson(options.reportsRoot, resolve(options.reportsRoot, "active-run.json"), 16 * 1024);
      if (!isRecord(active) || !hasExactKeys(active, ACTIVE_KEYS) || active.schemaVersion !== 1 || typeof active.runDirectory !== "string" || active.runDirectory.length < 1 || active.runDirectory.length > 200 || typeof active.gitSha !== "string" || !/^[a-f0-9]{7,64}$/i.test(active.gitSha) || !isSha256(active.databaseSha256) || !isSha256(active.manifestSha256) || typeof active.generatedAt !== "string" || !Number.isFinite(Date.parse(active.generatedAt))) throw new Error("Invalid active run");
      const runDirectory = resolve(options.reportsRoot, active.runDirectory);
      const manifest = readContainedJson(options.reportsRoot, resolve(runDirectory, "manifest.json"), 4 * 1024 * 1024);
      if (!isRecord(manifest) || !hasExactKeys(manifest, MANIFEST_KEYS) || manifest.schemaVersion !== 1 || manifest.gitSha !== active.gitSha || manifest.databaseSha256 !== active.databaseSha256 || manifest.manifestSha256 !== active.manifestSha256 || typeof manifest.seed !== "string" || manifest.seed.length < 1 || manifest.seed.length > 200 || manifest.generatedAt !== active.generatedAt || manifest.total !== 3_000 || manifest.batchSize !== 100 || manifest.batchCount !== 30 || manifest.agentCount !== 10 || !Array.isArray(manifest.rows) || manifest.rows.length !== 3_000 || !manifest.rows.every((row, index) => isRow(row, Math.floor(index / 100) + 1)) || !hasExactLocalDemoManifestAllocation(manifest.rows as LocalDemoBatchRow[]) || computeLocalDemoManifestHash(manifest) !== active.manifestSha256) throw new Error("Invalid active manifest");
      const preflight = options.preflight();
      if (!isSha256(preflight.databaseSha256) || preflight.databaseSha256 !== active.databaseSha256) throw new Error("Stale database");
      const expectedGitSha = options.expectedGitSha?.();
      const expectedDatabaseSha256 = options.expectedDatabaseSha256?.();
      if (
        (options.expectedGitSha !== undefined && (!/^[a-f0-9]{40}$/i.test(String(expectedGitSha)) || active.gitSha !== expectedGitSha)) ||
        (options.expectedDatabaseSha256 !== undefined && (!isSha256(expectedDatabaseSha256) || active.databaseSha256 !== expectedDatabaseSha256))
      ) throw new Error("Stale runtime manifest");
      const payload = readContainedJson(options.reportsRoot, resolve(runDirectory, "batches", `batch-${batchText}.json`), 2 * 1024 * 1024);
      if (!isRecord(payload) || !hasExactKeys(payload, BATCH_KEYS) || payload.schemaVersion !== 1 || payload.gitSha !== active.gitSha || payload.databaseSha256 !== active.databaseSha256 || typeof payload.seed !== "string" || payload.seed.length < 1 || payload.seed.length > 200 || payload.batch !== batch || payload.agent !== Math.floor((batch - 1) / 3) + 1 || payload.rowCount !== 100 || !isSha256(payload.batchSha256) || !isSha256(payload.expectedBarcodesSha256) || !isSha256(payload.expectedCanonicalProductUidsSha256) || !Array.isArray(payload.rows) || payload.rows.length !== 100 || !payload.rows.every((row) => isRow(row, batch))) throw new Error("Invalid batch payload");
      const rows = payload.rows as LocalDemoBatchRow[];
      const manifestRows = manifest.rows.slice((batch - 1) * 100, batch * 100) as LocalDemoBatchRow[];
      if (new Set(rows.map((row) => row.barcode)).size !== rows.length || new Set(rows.map((row) => row.canonicalProductUid)).size !== rows.length || JSON.stringify(rows) !== JSON.stringify(manifestRows)) throw new Error("Batch is not bound to the active manifest");
      const hashes = computeLocalDemoBatchHashes(rows);
      if (hashes.batchSha256 !== payload.batchSha256 || hashes.expectedBarcodesSha256 !== payload.expectedBarcodesSha256 || hashes.expectedCanonicalProductUidsSha256 !== payload.expectedCanonicalProductUidsSha256) throw new Error("Batch hash mismatch");
      return NextResponse.json({ schemaVersion: payload.schemaVersion, gitSha: payload.gitSha, databaseSha256: payload.databaseSha256, manifestSha256: active.manifestSha256, seed: payload.seed, batch: payload.batch, agent: payload.agent, rowCount: payload.rowCount, ...hashes, rows }, { headers: localDemoNoStoreHeaders });
    } catch {
      return localDemoEvidenceErrorResponse();
    }
  };
}
