import { describe, expect, it, vi } from "vitest";
import { deriveAuthoritativeLinkSnapshotHash, deriveConfiguredSnapshotHashes, loadAuthoritativeLocalIdentityReadModel, loadConfiguredLocalIdentityReadModel } from "./localIdentityReadModel";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalRepository } from "./localRepository";
import { createReadOnlyCandidateSource } from "./readOnlyCandidateSource";

const candidate = { productId: "p-1", category: "tire", businessScope: "master", verificationTier: "human_verified", automaticEligible: true, evidenceId: "e-1", evidenceVersion: "v1", exactCodeEvidence: true, identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "fixture", evidenceAuthority: "human_verified_master", evidenceId: "e-1", evidenceVersion: "v1" }], attributes: {}, catalogVersion: "catalog-v1", catalogSnapshotHash: "hash-v1" };

describe("configured local identity read model", () => {
  it("derives content hashes and rejects a reused declared hash after catalog content changes", async () => {
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [["012345678905", [candidate]]], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const model = await loadConfiguredLocalIdentityReadModel();
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "p-1" })).toBe(true);
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "arbitrary" })).toBe(false);
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify({ ...wire, barcodeCandidates: [["012345678905", [{ ...candidate, title: "changed" }]]] }));
    expect(await loadConfiguredLocalIdentityReadModel()).toBeUndefined();
  });

  it("requires an explicit tenant owner and never lets another tenant use its candidate", async () => {
    const tenant = { ...candidate, productId: "tenant-p", businessScope: "tenant", tenantBusinessId: "shop-a" };
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [["012345678905", [tenant]]], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const model = await loadConfiguredLocalIdentityReadModel();
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "tenant-p" })).toBe(true);
    expect(model?.hasCurrentTarget({ businessId: "shop-b", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "tenant-p" })).toBe(false);
  });

  it("revalidates an approved tenant link in its exact source scope when its target is absent from the catalog", async () => {
    const target = { ...candidate, productId: "link-only-target" };
    const link = { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifierType: "upc" as const, namespace: "", normalizedValue: "012345678905", status: "approved" as const, version: 1, evidenceId: "link-e-1", evidenceVersion: "v1", automaticEligible: true, targetProductId: target.productId, currentTarget: target };
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [link] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const model = await loadConfiguredLocalIdentityReadModel();
    const identifiers = [{ type: "upc" as const, raw: "012345678905", normalized: "012345678905", source: "csv", evidenceAuthority: "vendor_import" as const, evidenceId: "row", evidenceVersion: "v1" }];
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: target.productId, identifiers })).toBe(true);
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "other", vendorId: "vendor-a", targetProductId: target.productId, identifiers })).toBe(false);
  });

  it("lets the latest durable tombstone override a configured approved link in lookup and target validation", async () => {
    const target = { ...candidate, productId: "configured-link-target" };
    const link = { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifierType: "upc" as const, namespace: "vendor-a", rawValue: "012345678905", normalizedValue: "012345678905", targetProductId: target.productId, status: "approved" as const, version: 1, evidenceId: "link-e-1", evidenceVersion: "v1", automaticEligible: true, currentTarget: target };
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [link] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveIdentityLink({ ...link, evidence: ["review"], createdBy: "manager", createdAt: "now", status: "revoked", version: 2 });

    const model = await loadAuthoritativeLocalIdentityReadModel(repository);
    const input = { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifiers: [{ type: "upc" as const, raw: link.rawValue, normalized: link.normalizedValue, source: "review", evidenceAuthority: "vendor_import" as const, evidenceId: "review", evidenceVersion: "v1" }] };
    await expect(model?.lookupApprovedLinks(input)).resolves.toEqual([]);
    await expect(model?.hasCurrentTarget({ ...input, targetProductId: target.productId })).resolves.toBe(false);
  });

  it("pages 500 configured and durable links without a full durable read while preserving tombstones", async () => {
    const configuredLinks = Array.from({ length: 500 }, (_, index) => {
      const value = String(index).padStart(3, "0");
      return { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifierType: "upc" as const, namespace: "", rawValue: value, normalizedValue: value, targetProductId: `configured-${value}`, status: "approved" as const, version: 1, evidenceId: `configured-${value}`, evidenceVersion: "v1", automaticEligible: true, currentTarget: { ...candidate, productId: `configured-${value}` }, createdBy: "snapshot-builder" };
    });
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: configuredLinks };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const repository = createLocalRepository(createMemoryAtomicLocalStorage());
    await repository.saveIdentityLink({ ...configuredLinks[0]!, evidence: ["review"], createdBy: "admin", createdAt: "now", status: "revoked", version: 2 });
    await repository.saveIdentityLink({ ...configuredLinks[0]!, rawValue: "000a", normalizedValue: "000a", targetProductId: "durable-new", evidence: ["review"], createdBy: "admin", createdAt: "now", status: "approved", version: 1 });
    repository.listCurrentIdentityLinks = vi.fn().mockRejectedValue(new Error("unbounded durable read"));

    const model = await loadAuthoritativeLocalIdentityReadModel(repository);
    const page = await model?.pageCurrentApprovedLinks?.("shop-a", { page: 1, pageSize: 25 });

    expect(repository.listCurrentIdentityLinks).not.toHaveBeenCalled();
    expect(page?.items).toHaveLength(25);
    expect(page?.total).toBe(500);
    expect(page?.items.some((link) => link.normalizedValue === "000")).toBe(false);
    expect(page?.items).toContainEqual(expect.objectContaining({ normalizedValue: "000a", targetProductId: "durable-new", predecessorSource: "durable" }));
    expect(page?.items).toContainEqual(expect.objectContaining({ normalizedValue: "001", predecessorSource: "configured" }));
  });

  it("derives the authoritative snapshot hash from the committed current-link fingerprint without loading links", async () => {
    const repository = {
      currentIdentityLinksFingerprint: vi.fn().mockResolvedValue("committed-link-fingerprint"),
      listCurrentIdentityLinks: vi.fn().mockRejectedValue(new Error("unbounded durable read")),
    };

    const hash = await deriveAuthoritativeLinkSnapshotHash({ linkSnapshotHash: "configured-hash" }, repository, "shop-a");

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.currentIdentityLinksFingerprint).toHaveBeenCalledWith("shop-a");
    expect(repository.listCurrentIdentityLinks).not.toHaveBeenCalled();
  });

  it("loads tenant products and current links once for concurrent preview lookups", async () => {
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [["012345678905", [candidate]]], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const repository = {
      listCurrentIdentityLinks: vi.fn().mockResolvedValue([]),
      findCurrentIdentityLinks: vi.fn().mockResolvedValue([]),
      listTenantProducts: vi.fn().mockResolvedValue([]),
    };
    const model = await loadAuthoritativeLocalIdentityReadModel(repository as never);
    const lookup = (sourceRow: string) => model!.lookupApprovedLinks({
      businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a",
      identifiers: [{ type: "upc", raw: sourceRow, normalized: sourceRow, source: "csv", evidenceAuthority: "vendor_import", evidenceId: sourceRow, evidenceVersion: "v1" }],
    });

    await Promise.all([lookup("012345678905"), lookup("036000291452"), lookup("012345678905")]);

    expect(repository.listCurrentIdentityLinks).not.toHaveBeenCalled();
    expect(repository.findCurrentIdentityLinks).toHaveBeenCalledTimes(3);
    expect(repository.listTenantProducts).toHaveBeenCalledTimes(1);
  });

  it("uses bounded exact-family reads and lets a durable tombstone suppress only its configured family", async () => {
    const configuredLinks = Array.from({ length: 26 }, (_, index) => {
      const value = String(index).padStart(2, "0");
      return { businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifierType: "upc" as const, namespace: "", normalizedValue: value, status: "approved" as const, version: 1, evidenceId: `configured-${value}`, evidenceVersion: "v1", automaticEligible: true, targetProductId: `target-${value}`, currentTarget: { ...candidate, productId: `target-${value}` } };
    });
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: configuredLinks };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const revoked = { businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc" as const, namespace: "", rawValue: "00", normalizedValue: "00", targetProductId: "target-00", status: "revoked" as const, version: 2, evidence: ["review"], createdBy: "manager", createdAt: "now" };
    const repository = {
      listCurrentIdentityLinks: vi.fn().mockRejectedValue(new Error("unbounded durable read")),
      findCurrentIdentityLinks: vi.fn().mockResolvedValue([revoked]),
      listTenantProducts: vi.fn().mockResolvedValue([]),
    };
    const model = await loadAuthoritativeLocalIdentityReadModel(repository as never);
    const identifiers = Array.from({ length: 25 }, (_, index) => {
      const value = String(index).padStart(2, "0");
      return { type: "upc" as const, raw: value, normalized: value, source: "csv", evidenceAuthority: "vendor_import" as const, evidenceId: value, evidenceVersion: "v1" };
    });

    const links = await model!.lookupApprovedLinks({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", identifiers });

    expect(repository.listCurrentIdentityLinks).not.toHaveBeenCalled();
    expect(repository.findCurrentIdentityLinks).toHaveBeenCalledTimes(1);
    expect(repository.findCurrentIdentityLinks.mock.calls[0]![1]).toEqual(identifiers.map((identifier) => ({
      businessId: "shop-a",
      sourceSystem: "csv",
      vendorId: "vendor-a",
      sourceSignature: "v1",
      identifierType: identifier.type,
      namespace: "",
      normalizedValue: identifier.normalized,
    })));
    expect(links.map((link) => link.normalizedValue)).toEqual(Array.from({ length: 24 }, (_, index) => String(index + 1).padStart(2, "0")));
    expect(links).not.toContainEqual(expect.objectContaining({ normalizedValue: "25" }));
  });

  it("uses 200 exact-family repository reads for a deterministic 5,000-row candidate batch", async () => {
    const wire = { catalogVersion: "catalog-v1", catalogSnapshotHash: "", barcodeCandidates: [["012345678905", [candidate]]], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    const repository = {
      listCurrentIdentityLinks: vi.fn().mockRejectedValue(new Error("unbounded durable read")),
      listTenantProducts: vi.fn().mockResolvedValue(Array.from({ length: 5_000 }, (_, index) => ({ businessId: "shop-a", productId: `p-${index}`, name: `Product ${index}`, createdBy: "manager", createdAt: "now" }))),
      findCurrentIdentityLinks: vi.fn(async (_businessId, lookups) => lookups.map((lookup: { normalizedValue: string }) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc" as const, namespace: "", rawValue: lookup.normalizedValue, normalizedValue: lookup.normalizedValue, targetProductId: `p-${lookup.normalizedValue}`, status: "approved" as const, version: 1, evidence: ["review"], createdBy: "manager", createdAt: "now" }))),
    };
    const model = await loadAuthoritativeLocalIdentityReadModel(repository as never);
    const source = createReadOnlyCandidateSource({ snapshot: model!.snapshot, lookupApprovedLinks: model!.lookupApprovedLinks });
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", rawRecordFingerprint: `row-${index}`,
      identifiers: [{ type: "upc" as const, raw: String(index), normalized: String(index), source: "csv", evidenceAuthority: "vendor_import" as const, evidenceId: String(index), evidenceVersion: "v1" }],
    }));
    rows.push({ ...rows[1]!, rawRecordFingerprint: "same-scope-duplicate" });

    const result = await source.lookupBatch(rows as never);

    expect(repository.findCurrentIdentityLinks).toHaveBeenCalledTimes(200);
    expect(repository.findCurrentIdentityLinks.mock.calls.every(([, lookups]) => lookups.length <= 25)).toBe(true);
    expect(repository.findCurrentIdentityLinks.mock.calls.flatMap(([, lookups]) => lookups)).toEqual(Array.from({ length: 5_000 }, (_, index) => ({ businessId: "shop-a", sourceSystem: "csv", vendorId: "vendor-a", sourceSignature: "v1", identifierType: "upc", namespace: "", normalizedValue: String(index) })));
    expect(repository.listCurrentIdentityLinks).not.toHaveBeenCalled();
    expect(repository.listTenantProducts).toHaveBeenCalledTimes(1);
    expect([...result.candidatesByRecord.keys()]).toEqual([...Array.from({ length: 5_000 }, (_, index) => `row-${index}`), "same-scope-duplicate"]);
    expect([...result.candidatesByRecord.values()].map((entries) => entries.map((entry) => entry.productId))).toEqual([...Array.from({ length: 5_000 }, (_, index) => [`p-${index}`]), ["p-1"]]);
  });
});
