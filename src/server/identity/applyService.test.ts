import { describe, expect, it, vi } from "vitest";
import { applyIdentityImport } from "./applyService";
import type { SignedPreviewChunk } from "@/services/identity/preview";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalRepository } from "./localRepository";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { canonicalSha256 } from "@/services/identity/canonical";

const versions = { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" };
const freshSource = { versions, revalidateCountableTarget: async () => true };
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
      ...h, source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("preview_versions_stale");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
    expect(h.ledger.applyOnce).not.toHaveBeenCalled();
  });

  it("preflights every countable target against the current source before creating a run", async () => {
    const h = harness();
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, {
      ...h,
      source: { versions, revalidateCountableTarget: async () => false },
      clock: () => "2026-07-31T00:01:00.000Z",
      actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("apply_target_stale");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
    expect(h.repository.claimImportOperation).not.toHaveBeenCalled();
    expect(h.ledger.applyOnce).not.toHaveBeenCalled();
  });

  it("rejects duplicate row ids and malformed quantities before any durable action", async () => {
    const h = harness();
    h.verifier.mockResolvedValueOnce([{ ...chunk(), rowIds: ["row-1", "row-1"], rows: [chunk().rows[0]!, { ...chunk().rows[0]!, sourceRowNumber: 3, quantity: Infinity }], decisions: [chunk().decisions[0]!, chunk().decisions[0]!] }]);
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, {
      ...h, source: { versions, revalidateCountableTarget: async () => true }, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("apply_row_id_duplicate");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
    expect(h.repository.claimImportOperation).not.toHaveBeenCalled();
  });

  it("creates one aggregate physical count, completes it, and returns the exact completed result on retry", async () => {
    const h = harness();
    const dependencies = { ...h, source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "admin" as const } };
    const request = { signedPayloads: ["token"], mode: "physical_count" as const, corrections: [] };
    const first = await applyIdentityImport(request, dependencies);
    const second = await applyIdentityImport(request, dependencies);
    expect(h.applied).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ importId: "import-1", countedRows: 1, countQuantity: 7 });
  });

  it("never calls the ledger for reconcile or unresolved review decisions", async () => {
    const h = harness();
    const dependencies = { ...h, source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
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
      ...h, source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const },
    })).rejects.toThrow("apply_correction_scope_invalid");
    expect(h.repository.createImportRun).not.toHaveBeenCalled();
  });

  it("allows overlapping identical physical applies to share one durable count", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const dependencies = { repository: createLocalRepository(storage), ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    const input = { signedPayloads: ["token"], mode: "physical_count" as const, corrections: [] };
    const settled = await Promise.allSettled([applyIdentityImport(input, dependencies), applyIdentityImport(input, dependencies)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected").map((item) => item.status === "rejected" ? (item.reason as Error).message : "")).toEqual(["apply_in_progress"]);
    await expect(applyIdentityImport(input, dependencies)).resolves.toMatchObject({ countedRows: 1, countQuantity: 7 });
  });

  it("conflicts when the same signed preview is reapplied with a changed mode", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const dependencies = { repository: createLocalRepository(storage), ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    await applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, dependencies);
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "reconcile", corrections: [] }, dependencies)).rejects.toThrow("apply_idempotency_conflict");
  });

  it("completes the durable run only after all preflighted rows finish", async () => {
    const storage = createMemoryAtomicLocalStorage(); const repository = createLocalRepository(storage);
    await applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, { repository, ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } });
    await expect(repository.getImportRun("shop-a", "import-1")).resolves.toMatchObject({ state: "completed" });
  });

  it("persists an honest reconcile report without fabricating current inventory", async () => {
    const storage = createMemoryAtomicLocalStorage(); const repository = createLocalRepository(storage);
    await applyIdentityImport({ signedPayloads: ["token"], mode: "reconcile", corrections: [] }, { repository, ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } });
    await expect(repository.getImportRun("shop-a", "import-1")).resolves.toMatchObject({ result: { reconciliation: { expectedRows: 1, expectedQuantity: 7, currentInventoryStatus: "unavailable", varianceQuantity: null } } });
  });

  it("recovers a stored ledger result after a crash between ledger write and operation completion", async () => {
    let now = Date.parse("2026-07-31T00:01:00.000Z"); const storage = createMemoryAtomicLocalStorage();
    const repository = createLocalRepository(storage, { now: () => now }); const complete = repository.completeImportOperation.bind(repository); let crash = true;
    const dependencies = { repository: { ...repository, completeImportOperation: async (...args: Parameters<typeof complete>) => { if (crash) { crash = false; throw new Error("simulated_crash"); } return complete(...args); } }, ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => new Date(now).toISOString(), actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    const input = { signedPayloads: ["token"], mode: "physical_count" as const, corrections: [] };
    await expect(applyIdentityImport(input, dependencies)).rejects.toThrow("simulated_crash");
    now += 60_001;
    await expect(applyIdentityImport(input, dependencies)).resolves.toMatchObject({ countedRows: 1, countQuantity: 7 });
  });

  it("does not complete or count against an invalidated import run", async () => {
    const storage = createMemoryAtomicLocalStorage(); const repository = createLocalRepository(storage);
    await repository.createImportRun({ importId: "import-1", businessId: "shop-a", sourceFingerprint: "root", mappingFingerprint: await canonicalSha256(chunk().orderedMappings), previewFingerprint: "preview-1", actorId: "owner-a", engineVersion: "identity-engine-v1", pluginVersion: "identity-generic-v1", catalogVersion: "catalog-v1", createdAt: "2026-07-31T00:00:00.000Z" });
    await repository.transitionImportRun("shop-a", "import-1", "invalidated");
    const ledger = createLocalAggregateLedger(storage); const dependencies = { repository, ledger, verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, dependencies)).rejects.toThrow("apply_preview_invalidated");
    expect(await ledger.findByIdempotencyKey({ businessId: "shop-a", idempotencyKey: "missing", expectedFingerprint: "missing" })).toBeNull();
  });

  it("conflicts when a retry changes the correction bound into the operation fingerprint", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const dependencies = { repository: createLocalRepository(storage), ledger: createLocalAggregateLedger(storage), verifier: async () => [chunk()], source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } };
    await applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [{ rowId: "row-1", targetProductId: "product-2" }] }, dependencies);
    await expect(applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [{ rowId: "row-1", targetProductId: "product-3" }] }, dependencies)).rejects.toThrow("apply_idempotency_conflict");
  });

  it("never counts invalid, non-product, or unresolved rows in physical mode", async () => {
    const h = harness(); const terminal = ["invalid", "non_product", "abstain"] as const;
    for (const kind of terminal) {
      const decision = { ...chunk().decisions[0]!, kind };
      delete decision.targetProductId;
      h.verifier.mockResolvedValueOnce([{ ...chunk(), decisions: [decision] }]);
      await applyIdentityImport({ signedPayloads: ["token"], mode: "physical_count", corrections: [] }, { ...h, source: freshSource, clock: () => "2026-07-31T00:01:00.000Z", actor: { actorId: "owner-a", businessId: "shop-a", role: "owner" as const } });
    }
    expect(h.ledger.applyOnce).not.toHaveBeenCalled();
  });
});
