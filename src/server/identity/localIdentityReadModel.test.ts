import { describe, expect, it, vi } from "vitest";
import { deriveConfiguredSnapshotHashes, loadAuthoritativeLocalIdentityReadModel, loadConfiguredLocalIdentityReadModel } from "./localIdentityReadModel";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalRepository } from "./localRepository";

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
});
