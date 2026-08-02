import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { createFileAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalAtomicBatchApply } from "@/server/identity/localAtomicBatchApply";
import { writeLocalInventoryProjection } from "@/server/identity/localInventoryProjection";
import { applyComposedIdentityImport, setLocalIdentityApplyCompositionForTest } from "@/server/identity/applyComposition";
import { createLocalPreviewSigner } from "@/server/identity/previewSigner";
import { createIdentityPreview, verifySignedPreviewChunks } from "@/services/identity/preview";
import type { IdentityCandidate, IdentityCandidateSource, IdentityInput } from "@/services/identity/types";

const actor = { actorId: "durable-perf-owner", businessId: "durable-perf-shop", role: "owner" as const };
const signedAt = "2026-08-02T12:00:00.000Z";
const versions = {
  engineVersion: "identity-engine-v2",
  pluginVersions: ["identity-tire-v1"],
  catalogVersion: "durable-perf-catalog-v1",
  catalogSnapshotHash: "durable-perf-snapshot-v1",
  linkVersion: "durable-perf-links-v1",
  linkSnapshotHash: "durable-perf-links-snapshot-v1",
};
const signingKey = Buffer.alloc(32, 17).toString("base64url");
const roots: string[] = [];

afterEach(async () => {
  setLocalIdentityApplyCompositionForTest(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(index: number): IdentityInput {
  return {
    businessId: actor.businessId,
    sourceSystem: "csv",
    sourceSignature: "durable-perf-headers-v1",
    vendorId: "durable-perf-vendor",
    sourceFileFingerprint: "durable-perf-source-v1",
    sourceFileOrdinal: 0,
    sheetName: "Tires",
    sourceRowNumber: index + 2,
    categoryHint: "tire",
    identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "csv", evidenceAuthority: "vendor_import", evidenceId: `durable-perf-row-${index}`, evidenceVersion: "1" }],
    attributes: { description: "Durable performance tire" },
    quantity: 1,
    unitOfMeasure: "each",
    rawRecordFingerprint: `durable-perf-raw-${index}`,
  };
}

const target: IdentityCandidate = {
  productId: "durable-perf-tire",
  category: "tire",
  businessScope: "master",
  verificationTier: "human_verified",
  automaticEligible: true,
  evidenceId: "durable-perf-catalog-evidence",
  evidenceVersion: "1",
  exactCodeEvidence: true,
  identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "master-catalog", evidenceAuthority: "human_verified_master", evidenceId: "durable-perf-catalog-evidence", evidenceVersion: "1" }],
  attributes: { description: "Durable performance tire" },
  catalogVersion: versions.catalogVersion,
  catalogSnapshotHash: versions.catalogSnapshotHash,
};

describe("durable local identity apply scale", () => {
  it("applies and read-replays 3,000 real signed counted rows in exactly thirty bounded commits", async () => {
    const root = path.join(process.cwd(), ".tmp", "identity-import", `apply-perf-${randomUUID()}`);
    roots.push(root);
    let generationCommits = 0;
    let revalidations = 0;
    let projectionWrites = 0;
    let batchCommits = 0;
    const storage = createFileAtomicLocalStorage({
      root,
      io: {
        replace: async (tempPath, statePath) => { generationCommits += 1; await rename(tempPath, statePath); },
      },
    });
    const signer = await createLocalPreviewSigner(signingKey);
    const rows = Array.from({ length: 3_000 }, (_, index) => input(index));
    const source: IdentityCandidateSource = {
      readonlyOnly: true,
      async lookupBatch(inputs) {
        return {
          catalogVersion: versions.catalogVersion,
          catalogSnapshotHash: versions.catalogSnapshotHash,
          candidatesByRecord: new Map(inputs.map((row) => [row.rawRecordFingerprint, [target]])),
        };
      },
    };
    const preview = await createIdentityPreview({
      actorId: actor.actorId,
      versions,
      rows,
      orderedMappings: [{ sheetName: "Tires", mapping: { barcode: "UPC", quantity: "Qty" } }],
      sourceFileHashes: ["durable-perf-source-v1"],
      importerVersion: "durable-perf-v1",
      issuedAt: signedAt,
      expiresAt: "2026-08-02T12:10:00.000Z",
    }, { source, signer });
    expect(preview.signedPayloads.length).toBeGreaterThan(1);
    const signedChunks = await verifySignedPreviewChunks(preview.signedPayloads, signer, signedAt, { actorId: actor.actorId, businessId: actor.businessId, versions });
    const firstSignedRowId = signedChunks[0]?.rowIds[0];
    expect(firstSignedRowId).toBeTypeOf("string");
    setLocalIdentityApplyCompositionForTest({
      storage,
      signingKey: () => signingKey,
      versions,
      now: () => new Date(signedAt),
      authenticate: async () => actor,
      // Fixed server-owned target read model: every new row must validate this exact product.
      revalidateCountableTarget: async (validation) => {
        revalidations += 1;
        return validation.targetProductId === target.productId;
      },
      createAtomicBatchForTest: (composedStorage, revalidate) => {
        const atomic = createLocalAtomicBatchApply(composedStorage, revalidate, {
          writeProjection: async (transaction, entries, businessId, sessionId) => {
            projectionWrites += 1;
            return writeLocalInventoryProjection(transaction, entries, businessId, sessionId);
          },
        });
        return async (batch) => {
          batchCommits += 1;
          return atomic(batch);
        };
      },
    });
    const apply = () => applyComposedIdentityImport({ signedPayloads: preview.signedPayloads, mode: "physical_count", corrections: [] }, actor);

    const started = performance.now();
    const first = await apply();
    const firstDurationMs = performance.now() - started;
    expect(first).toMatchObject({ importId: preview.preview.importId, countedRows: 3_000, countQuantity: 3_000 });
    expect(first.rows).toHaveLength(3_000);
    expect(first.rows[0]).toMatchObject({ rowId: firstSignedRowId, status: "counted", audit: { targetProductId: target.productId, sourceQuantity: 1 } });
    expect(batchCommits).toBe(30);
    expect(projectionWrites).toBe(30);
    expect(revalidations).toBe(3_000);
    // Three import-run lifecycle commits (create, applying, complete) are deliberately distinct
    // from the thirty max-100 counted batches.
    expect(generationCommits).toBe(33);
    await storage.read!(async (transaction) => {
      const ledger = await transaction.get<Record<string, unknown>>("aggregate-ledger");
      expect(Object.keys(ledger ?? {})).toHaveLength(3_000);
      const projections = await transaction.get<Record<string, Array<{ productId: string; quantity: number }>>>("inventory-count-projection");
      const projection = Object.values(projections ?? {}).flat();
      expect(projection).toEqual([expect.objectContaining({ productId: target.productId, quantity: 3_000 })]);
    });

    const beforeReplay = { generationCommits, revalidations, projectionWrites, batchCommits };
    const replayStarted = performance.now();
    const replay = await apply();
    const replayDurationMs = performance.now() - replayStarted;
    expect(replay).toEqual(first);
    expect({ generationCommits, revalidations, projectionWrites, batchCommits }).toEqual(beforeReplay);
    console.info("identity_durable_apply_performance", JSON.stringify({ firstDurationMs, replayDurationMs, signedChunkCount: preview.signedPayloads.length, generationCommits, batchCommits }));
  }, 120_000);
});
