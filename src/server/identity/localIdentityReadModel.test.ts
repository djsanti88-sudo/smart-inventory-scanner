import { describe, expect, it, vi } from "vitest";
import { loadConfiguredLocalIdentityReadModel } from "./localIdentityReadModel";

const candidate = { productId: "p-1", category: "tire", businessScope: "master", verificationTier: "human_verified", automaticEligible: true, evidenceId: "e-1", evidenceVersion: "v1", exactCodeEvidence: true, identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "fixture", evidenceAuthority: "human_verified_master", evidenceId: "e-1", evidenceVersion: "v1" }], attributes: {}, catalogVersion: "catalog-v1", catalogSnapshotHash: "hash-v1" };

describe("configured local identity read model", () => {
  it("loads only a complete scoped local snapshot and rejects arbitrary targets", () => {
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify({ catalogVersion: "catalog-v1", catalogSnapshotHash: "hash-v1", barcodeCandidates: [["012345678905", [candidate]]], partNumberCandidates: [], approvedLinks: [] }));
    const model = loadConfiguredLocalIdentityReadModel();
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "p-1" })).toBe(true);
    expect(model?.hasCurrentTarget({ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "v1", vendorId: "vendor-a", targetProductId: "arbitrary" })).toBe(false);
  });
});
