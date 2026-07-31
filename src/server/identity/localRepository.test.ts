import { describe, expect, it } from "vitest";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalRepository } from "./localRepository";

const approvedLink = {
  businessId: "shop-a",
  sourceSystem: "vendor-feed",
  vendorId: "vendor-a",
  sourceSignature: "daily-catalog",
  identifierType: "vendor_sku" as const,
  namespace: "vendor-a",
  rawValue: "A-1",
  normalizedValue: "A-1",
  targetProductId: "tire-a",
  status: "approved" as const,
  evidence: ["export-row-1"],
  createdBy: "manager-a",
  createdAt: "2026-07-31T00:00:00.000Z",
  approvedBy: "manager-a",
  approvedAt: "2026-07-31T00:00:00.000Z",
  version: 1,
};

describe("local identity repository", () => {
  it("uses only an approved exact-source link for automatic resolution", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveIdentityLink(approvedLink);

    await expect(repository.resolveLink({ ...approvedLink, sourceSignature: "daily-catalog" })).resolves.toMatchObject({
      kind: "automatic",
      link: { targetProductId: "tire-a" },
    });
    await expect(repository.resolveLink({ ...approvedLink, sourceSignature: "another-export" })).resolves.toEqual({
      kind: "abstain",
    });
  });

  it("never broadens a vendor-wide transformation into an automatic link", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveTransformation({
      businessId: "shop-a",
      sourceSystem: "vendor-feed",
      vendorId: "vendor-a",
      sourceSignature: "*",
      ruleKind: "remove-approved-prefix",
      examples: ["V-A-1 -> A-1"],
      status: "approved",
      approvedBy: "manager-a",
      approvedAt: "2026-07-31T00:00:00.000Z",
      collisionTestIds: ["collision-v1"],
      version: 1,
    });

    await expect(repository.resolveLink({ ...approvedLink, sourceSignature: "weekly-catalog" })).resolves.toMatchObject({
      kind: "review",
      transformation: { ruleKind: "remove-approved-prefix" },
    });
  });

  it("prevents two approved products from claiming the same scoped identifier", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveIdentityLink(approvedLink);

    await expect(repository.saveIdentityLink({ ...approvedLink, targetProductId: "tire-b" })).rejects.toThrow(
      /already belongs to tire-a/,
    );
  });

  it("makes one concurrent import operation lease claim and reports the other as in progress", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "import-a:row-1" };
    const claims = await Promise.all([repository.claimImportOperation(input, 100, 30), repository.claimImportOperation(input, 100, 30)]);

    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "in_progress")).toHaveLength(1);
  });

  it("returns a completed operation result on a safe retry", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "import-a:row-1" };
    const claim = await repository.claimImportOperation(input, 100, 30);
    if (claim.kind !== "claimed") throw new Error("expected lease claim");
    await repository.completeImportOperation(claim.operation, claim.leaseId, { eventId: "event-1" });

    await expect(repository.claimImportOperation(input, 101, 30)).resolves.toMatchObject({
      kind: "completed",
      result: { eventId: "event-1" },
    });
  });

  it("enforces the import-run lifecycle", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const run = await repository.createImportRun({
      importId: "import-a",
      businessId: "shop-a",
      sourceFingerprint: "source-fingerprint",
      mappingFingerprint: "mapping-fingerprint",
      previewFingerprint: "preview-fingerprint",
      actorId: "manager-a",
      engineVersion: "engine-v1",
      pluginVersion: "plugin-v1",
      catalogVersion: "catalog-v1",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await expect(repository.transitionImportRun(run.importId, "applying")).resolves.toMatchObject({ state: "applying" });
    await expect(repository.transitionImportRun(run.importId, "completed")).resolves.toMatchObject({ state: "completed" });
    await expect(repository.transitionImportRun(run.importId, "applying")).rejects.toThrow(/cannot transition/);
  });
});
