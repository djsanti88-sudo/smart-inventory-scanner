import { describe, expect, it, vi } from "vitest";
import { applyIdentityImport } from "./applyService";
import type { SignedPreviewChunk } from "@/services/identity/preview";

const versions = { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" };
const chunk = (): SignedPreviewChunk => ({
  manifestVersion: "identity-preview-v1", chunkIndex: 0, chunkCount: 1, sanitizedContentRootHash: "root", importId: "import-1", previewFingerprint: "preview-1",
  scope: { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a" }, actorId: "owner-a", versions,
  orderedMappings: [{ sheetName: "Stock", mapping: { quantity: "Qty" } }], importerVersion: "v1", sourceFileHashes: ["file-a"], issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z",
  rows: [{ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, quantity: 7, rawRecordFingerprint: "raw-1" }],
  decisions: [{ kind: "automatic", targetProductId: "product-1", candidates: [], decisionBasis: [], normalizedKeys: [], constraintOutcomes: [], candidateSnapshotHash: "snapshot-v1", engineVersion: "identity-engine-v1", pluginVersion: "identity-generic-v1", sourceRecordFingerprint: "raw-1", decisionFingerprint: "decision-1" }], rowIds: ["row-1"], signature: "signature",
});

function harness() {
  const applied: unknown[] = [];
  const operations = new Map<string, unknown>();
  const repository = {
    createImportRun: vi.fn(async (run) => ({ ...run, state: "previewed" as const })), transitionImportRun: vi.fn(async () => ({ importId: "import-1", businessId: "shop-a", sourceFingerprint: "root", mappingFingerprint: "mapping", previewFingerprint: "preview-1", actorId: "owner-a", engineVersion: "engine", pluginVersion: "plugin", catalogVersion: "catalog", createdAt: "now", state: "applying" as const })),
    getImportRun: vi.fn(async () => undefined),
    claimImportOperation: vi.fn(async (input) => {
      const found = operations.get(input.rowId);
      if (found) return { kind: "completed", operation: {}, result: found };
      return { kind: "claimed", operation: input, leaseId: "lease-1" };
    }),
    completeImportOperation: vi.fn(async (operation, _lease, result) => { operations.set((operation as { rowId: string }).rowId, result); return { ...operation, state: "applied", result }; }),
  };
  const ledger = { applyOnce: vi.fn(async (event) => { applied.push(event); return { event, idempotencyKey: (event as { idempotencyKey: string }).idempotencyKey }; }), findByIdempotencyKey: vi.fn(async () => null) };
  const verifier = vi.fn(async () => [chunk()]);
  return { repository, ledger, verifier, applied };
}

describe("applyIdentityImport", () => {
  it("verifies the current actor, tenant, and versions before any claim or mutation", async () => {
    const h = harness();
    h.verifier.mockRejectedValueOnce(new Error("preview_versions_stale"));
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, {
      ...h, source: { versions }, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("preview_versions_stale");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
    expect(h.ledger.applyOnce).not.toHaveBeenCalled();
  });

  it("creates one aggregate physical count, completes it, and returns the exact completed result on retry", async () => {
    const h = harness();
    const dependencies = { ...h, source: { versions }, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "admin" as const } };
    const request = { signedPayloads: ["token"], mode: "physical_count" as const, corrections: [] };
    const first = await applyIdentityImport(request, dependencies);
    const second = await applyIdentityImport(request, dependencies);
    expect(h.applied).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ importId: "import-1", countedRows: 1, countQuantity: 7 });
  });

  it("never calls the ledger for reconcile or unresolved review decisions", async () => {
    const h = harness();
    const dependencies = { ...h, source: { versions }, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    await applyIdentityImport({ signedPayloads: ["token"], mode: "reconcile", corrections: [] }, dependencies);
    const review = { ...chunk().decisions[0]! };
    delete review.targetProductId;
    h.verifier.mockResolvedValueOnce([{ ...chunk(), decisions: [{ ...review, kind: "review" }] }]);
    await applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, dependencies);
    expect(h.ledger.applyOnce).not.toHaveBeenCalled();
  });

  it("rejects a correction that targets another tenant before claiming anything", async () => {
    const h = harness();
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [{ rowId: "row-1", targetProductId: "product-2", businessId: "other-shop" }] }, {
      ...h, source: { versions }, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("apply_correction_scope_invalid");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
  });
});
