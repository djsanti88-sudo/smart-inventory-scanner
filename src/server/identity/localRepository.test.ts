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

  it("returns a proposed exact link as review and honors only the latest non-revoked version", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveIdentityLink({ ...approvedLink, status: "proposed", version: 1 });
    await expect(repository.resolveLink(approvedLink)).resolves.toMatchObject({ kind: "review" });
    await repository.saveIdentityLink({ ...approvedLink, version: 2 });
    await repository.saveIdentityLink({ ...approvedLink, status: "revoked", version: 3 });
    await expect(repository.resolveLink(approvedLink)).resolves.toEqual({ kind: "abstain" });
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

    await expect(repository.saveIdentityLink({ ...approvedLink, targetProductId: "tire-b", version: 2 })).rejects.toThrow(
      /already belongs to tire-a/,
    );
  });

  it("makes one concurrent import operation lease claim and reports the other as in progress", async () => {
    const now = 100;
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => now });
    await startRun(repository, "shop-a", "import-a");
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "import-a:row-1", payloadFingerprint: "payload-1" };
    const claims = await Promise.all([repository.claimImportOperation(input, 30), repository.claimImportOperation(input, 30)]);

    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "in_progress")).toHaveLength(1);
  });

  it("returns a completed operation result on a safe retry", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => 100 });
    await startRun(repository, "shop-a", "import-a");
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "import-a:row-1", payloadFingerprint: "payload-1" };
    const claim = await repository.claimImportOperation(input, 30);
    if (claim.kind !== "claimed") throw new Error("expected lease claim");
    await repository.completeImportOperation(claim.operation, claim.leaseId, { eventId: "event-1" });

    await expect(repository.claimImportOperation(input, 30)).resolves.toMatchObject({
      kind: "completed",
      result: { eventId: "event-1" },
    });
  });

  it("rejects completion after the same tenant invalidates its applying run", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => 100 });
    await startRun(repository, "shop-a", "import-a");
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "import-a:row-1", payloadFingerprint: "payload-1" };
    const claim = await repository.claimImportOperation(input, 30);
    if (claim.kind !== "claimed") throw new Error("expected lease claim");

    await repository.transitionImportRun("shop-a", "import-a", "invalidated");
    await expect(repository.completeImportOperation(claim.operation, claim.leaseId, { eventId: "event-1" })).rejects.toThrow(/run.*applying/i);
    await expect(repository.failImportOperation(claim.operation, claim.leaseId, "failed_retryable", { reason: "retry" })).rejects.toThrow(/run.*applying/i);
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
    await expect(repository.transitionImportRun("shop-a", run.importId, "applying")).resolves.toMatchObject({ state: "applying" });
    await expect(repository.transitionImportRun("shop-a", run.importId, "completed")).resolves.toMatchObject({ state: "completed" });
    await expect(repository.transitionImportRun("shop-a", run.importId, "applying")).rejects.toThrow(/cannot transition/);
  });

  it("rejects a different immutable import run payload with the same tenant import ID", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const input = { importId: "import-a", businessId: "shop-a", sourceFingerprint: "source", mappingFingerprint: "mapping", previewFingerprint: "preview", actorId: "manager", engineVersion: "engine", pluginVersion: "plugin", catalogVersion: "catalog", createdAt: "now" };
    await repository.createImportRun(input);
    await expect(repository.createImportRun({ ...input, previewFingerprint: "tampered-preview" })).rejects.toThrow(/idempotency.*conflict/i);
  });

  it("treats a changed caller creation timestamp as a safe import-run retry", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const input = { importId: "import-a", businessId: "shop-a", sourceFingerprint: "source", mappingFingerprint: "mapping", previewFingerprint: "preview", actorId: "manager", engineVersion: "engine", pluginVersion: "plugin", catalogVersion: "catalog", createdAt: "first-time" };
    const created = await repository.createImportRun(input);

    await expect(repository.createImportRun({ ...input, createdAt: "retry-time" })).resolves.toEqual(created);
  });

  it("does not overwrite a different immutable identity review with the same scoped ID", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const review = { reviewId: "review-a", businessId: "shop-a", importId: "import-a", rowId: "row-a", decision: { kind: "abstain" as const, candidates: [], decisionBasis: [], normalizedKeys: [], constraintOutcomes: [], candidateSnapshotHash: "snapshot", engineVersion: "engine", pluginVersion: "plugin", sourceRecordFingerprint: "source", decisionFingerprint: "decision" } };
    await repository.saveIdentityReview(review);
    await expect(repository.saveIdentityReview({ ...review, rowId: "row-b" })).rejects.toThrow(/idempotency.*conflict/i);
  });

  it("allows one terminal review resolution and rejects a conflicting rewrite", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => Date.parse("2026-08-01T12:00:00.000Z") });
    const review = { reviewId: "review-a", businessId: "shop-a", importId: "import-a", rowId: "row-a", decision: { kind: "abstain" as const, candidates: [], decisionBasis: [], normalizedKeys: [], constraintOutcomes: [], candidateSnapshotHash: "snapshot", engineVersion: "engine", pluginVersion: "plugin", sourceRecordFingerprint: "source", decisionFingerprint: "decision" } };
    await repository.saveIdentityReview(review);
    const resolved = await repository.resolveIdentityReview("shop-a", "review-a", "confirmed", "manager-a", "client-first-timestamp");
    expect(resolved.resolvedAt).toBe("2026-08-01T12:00:00.000Z");

    await expect(repository.resolveIdentityReview("shop-a", "review-a", "confirmed", "manager-a", "client-retry-timestamp")).resolves.toEqual(resolved);
    await expect(repository.resolveIdentityReview("shop-a", "review-a", "rejected", "manager-a", "2026-07-31T00:00:00.000Z")).rejects.toThrow(/terminal|conflict/i);
  });

  it("atomically refuses to repoint a current approved link and returns a complete idempotent action result", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const review = { reviewId: "review-action", businessId: "shop-a", importId: "import-a", rowId: "row-a", decision: { kind: "review" as const, candidates: [], decisionBasis: [], normalizedKeys: [], constraintOutcomes: [], candidateSnapshotHash: "snapshot", engineVersion: "engine", pluginVersion: "plugin", sourceRecordFingerprint: "source", decisionFingerprint: "decision" } };
    const link = { ...approvedLink, targetProductId: "old-target", version: 1, status: "approved" as const, evidence: ["evidence"], createdBy: "manager", createdAt: "now" };
    await repository.saveIdentityReview(review);
    await repository.saveIdentityLink(link);
    await expect(repository.applyReviewAction({ businessId: "shop-a", reviewId: review.reviewId, actionId: "confirm", payloadFingerprint: "fingerprint", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "manager", link: { ...link, targetProductId: "new-target", version: 0 } })).rejects.toThrow(/target_conflict/i);
    const rejected = await repository.applyReviewAction({ businessId: "shop-a", reviewId: review.reviewId, actionId: "reject", payloadFingerprint: "reject-fingerprint", action: "reject", resolution: "rejected", resolvedBy: "manager" });
    const replay = await repository.applyReviewAction({ businessId: "shop-a", reviewId: review.reviewId, actionId: "reject", payloadFingerprint: "reject-fingerprint", action: "reject", resolution: "rejected", resolvedBy: "manager" });
    expect(replay).toEqual(rejected);
    expect(replay.action).toMatchObject({ action: "reject", outcome: "rejected", resolvedBy: "manager" });
  });

  it("returns every latest approved vendor-wide rule as review-only candidates", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    const base = { businessId: "shop-a", sourceSystem: "vendor-feed", vendorId: "vendor-a", sourceSignature: "*", examples: ["example"], status: "approved" as const, approvedBy: "manager-a", approvedAt: "2026-07-31T00:00:00.000Z", collisionTestIds: ["collision"], version: 1 };
    await repository.saveTransformation({ ...base, ruleKind: "strip-prefix" });
    await repository.saveTransformation({ ...base, ruleKind: "normalize-punctuation" });
    await repository.saveTransformation({ ...base, ruleKind: "strip-prefix", status: "revoked", version: 2 });

    await expect(repository.resolveLink({ ...approvedLink, sourceSignature: "new-export" })).resolves.toMatchObject({
      kind: "review",
      transformations: [expect.objectContaining({ ruleKind: "normalize-punctuation", status: "approved" })],
    });
  });

  it("returns a proposed vendor-wide rule only as a deterministic review candidate", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveTransformation({ businessId: "shop-a", sourceSystem: "vendor-feed", vendorId: "vendor-a", sourceSignature: "*", ruleKind: "proposed-normalization", examples: ["example"], status: "proposed", collisionTestIds: ["collision"], version: 1 });

    await expect(repository.resolveLink({ ...approvedLink, sourceSignature: "new-export" })).resolves.toMatchObject({
      kind: "review",
      transformations: [expect.objectContaining({ ruleKind: "proposed-normalization", status: "proposed" })],
    });
  });

  it("scopes same import IDs and collision-proof operation tuples by tenant", async () => {
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => 100 });
    await startRun(repository, "a", "x:y");
    await startRun(repository, "a:x", "y");
    await expect(repository.transitionImportRun("b", "same", "applying")).rejects.toThrow(/Unknown/);
    const first = await repository.claimImportOperation({ businessId: "a", importId: "x:y", rowId: "z", idempotencyKey: "one", payloadFingerprint: "first" }, 30);
    const second = await repository.claimImportOperation({ businessId: "a:x", importId: "y", rowId: "z", idempotencyKey: "two", payloadFingerprint: "second" }, 30);
    expect(first.kind).toBe("claimed");
    expect(second.kind).toBe("claimed");
  });

  it("rejects an idempotency conflict, non-applying runs, invalid leases, and expired completion", async () => {
    let now = 100;
    const repository = createLocalRepository(createMemoryAtomicLocalStorage(), { now: () => now });
    const input = { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "idempotency", payloadFingerprint: "payload-a" };
    await expect(repository.claimImportOperation(input, 30)).rejects.toThrow(/run.*applying/i);
    await startRun(repository, "shop-a", "import-a");
    await expect(repository.claimImportOperation(input, 0)).rejects.toThrow(/lease/i);
    const claim = await repository.claimImportOperation(input, 30);
    await expect(repository.claimImportOperation({ ...input, idempotencyKey: "different" }, 30)).resolves.toMatchObject({ kind: "idempotency_conflict" });
    await expect(repository.claimImportOperation({ ...input, payloadFingerprint: "payload-b" }, 30)).resolves.toMatchObject({ kind: "idempotency_conflict" });
    if (claim.kind !== "claimed") throw new Error("expected claim");
    now = 131;
    await expect(repository.completeImportOperation(claim.operation, claim.leaseId, { eventId: "event" })).rejects.toThrow(/expired/);
  });
});

async function startRun(repository: ReturnType<typeof createLocalRepository>, businessId: string, importId: string): Promise<void> {
  await repository.createImportRun({ importId, businessId, sourceFingerprint: "source", mappingFingerprint: "mapping", previewFingerprint: "preview", actorId: "manager", engineVersion: "engine", pluginVersion: "plugin", catalogVersion: "catalog", createdAt: "now" });
  await repository.transitionImportRun(businessId, importId, "applying");
}
