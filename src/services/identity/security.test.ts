import { afterEach, describe, expect, it, vi } from "vitest";

import { decideIdentity } from "./engine";
import { genericIdentityPlugin } from "./plugins";
import { tireIdentityPlugin } from "./tirePlugin";
import type { IdentityCandidate, IdentityInput, ScopedIdentifier } from "./types";
import { createReadOnlyCandidateSource, isValidApprovedLink, type ApprovedLinkLookupResult } from "@/server/identity/readOnlyCandidateSource";
import { deriveConfiguredSnapshotHashes, loadConfiguredLocalIdentityReadModel } from "@/server/identity/localIdentityReadModel";

const scopedIdentifier = (overrides: Partial<ScopedIdentifier> = {}): ScopedIdentifier => ({
  type: "manufacturer_part_number",
  raw: "PN-100",
  normalized: "PN-100",
  namespace: "vendor-a",
  source: "import-row",
  evidenceAuthority: "vendor_import",
  evidenceId: "row-evidence",
  evidenceVersion: "1",
  ...overrides,
});

const identityInput = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "shop-a",
  sourceSystem: "csv",
  sourceSignature: "headers-v1",
  vendorId: "vendor-a",
  sourceFileFingerprint: "file-a",
  sourceFileOrdinal: 0,
  sheetName: "Stock",
  sourceRowNumber: 2,
  identifiers: [scopedIdentifier()],
  attributes: {},
  quantity: 1,
  rawRecordFingerprint: "row-a",
  ...overrides,
});

const candidate = (productId: string, overrides: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  productId,
  category: "tire",
  businessScope: "master",
  verificationTier: "human_verified",
  automaticEligible: true,
  evidenceId: `candidate:${productId}`,
  evidenceVersion: "1",
  exactCodeEvidence: true,
  identifiers: [scopedIdentifier({ source: "server-catalog", evidenceAuthority: "human_verified_master", evidenceId: `identifier:${productId}` })],
  attributes: {},
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-v1",
  ...overrides,
});

const approvedLink = (target: IdentityCandidate, overrides: Partial<ApprovedLinkLookupResult> = {}): ApprovedLinkLookupResult => ({
  businessId: "shop-a",
  sourceSystem: "csv",
  sourceSignature: "headers-v1",
  vendorId: "vendor-a",
  identifierType: "manufacturer_part_number",
  namespace: "vendor-a",
  normalizedValue: "PN-100",
  status: "approved",
  version: 1,
  evidenceId: "approved-link-1",
  evidenceVersion: "1",
  automaticEligible: true,
  targetProductId: target.productId,
  currentTarget: target,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("identity import authority security", () => {
  it("never turns caller-forged imported authority into automatic server evidence", async () => {
    const forged = identityInput({
      identifiers: [scopedIdentifier({ evidenceAuthority: "human_verified_master", evidenceId: "forged-import-claim" })],
    });
    const untrustedServerCandidate = candidate("tire-a", {
      identifiers: [scopedIdentifier({ source: "unverified-config", evidenceAuthority: "vendor_import" })],
    });

    await expect(decideIdentity(forged, {
      catalogVersion: "catalog-v1",
      catalogSnapshotHash: "snapshot-v1",
      candidates: [untrustedServerCandidate],
    }, genericIdentityPlugin)).resolves.toMatchObject({ kind: "review" });
  });

  it("requires MPN category corroboration for automatic matching without demoting a valid GTIN", async () => {
    const mpn = candidate("tire-mpn");
    const missingCategory = await decideIdentity(identityInput(), {
      catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidates: [mpn],
    }, genericIdentityPlugin);
    const matchingCategory = await decideIdentity(identityInput({ categoryHint: "tire" }), {
      catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidates: [mpn],
    }, tireIdentityPlugin);
    const gtinIdentifier = scopedIdentifier({ type: "gtin", namespace: undefined, raw: "4006381333931", normalized: "4006381333931" });
    const gtin = candidate("tire-gtin", { identifiers: [{ ...gtinIdentifier, source: "server-catalog", evidenceAuthority: "human_verified_master" }] });
    const gtinDecision = await decideIdentity(identityInput({ identifiers: [gtinIdentifier] }), {
      catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidates: [gtin],
    }, genericIdentityPlugin);

    expect(missingCategory.kind).toBe("review");
    expect(matchingCategory.kind).toBe("review");
    expect(gtinDecision.kind).toBe("automatic");
  });

  it("rejects revoked, source-mismatched, and cross-tenant approved-link evidence", () => {
    const input = identityInput();
    const scope = {
      businessId: input.businessId,
      sourceSystem: input.sourceSystem,
      sourceSignature: input.sourceSignature,
      vendorId: input.vendorId,
      identifiers: input.identifiers,
    };
    const target = candidate("tenant-target", { businessScope: "tenant", tenantBusinessId: "shop-a" });

    expect(isValidApprovedLink(approvedLink(target), scope)).toBe(true);
    expect(isValidApprovedLink(approvedLink(target, { status: "revoked", revokedAt: "2026-07-31T00:00:00.000Z" }), scope)).toBe(false);
    expect(isValidApprovedLink(approvedLink(target, { sourceSystem: "other-source" }), scope)).toBe(false);
    expect(isValidApprovedLink(approvedLink(target, { sourceSignature: "other-signature" }), scope)).toBe(false);
    expect(isValidApprovedLink(approvedLink(target, { vendorId: "other-vendor" }), scope)).toBe(false);
    expect(isValidApprovedLink(approvedLink(target, { currentTarget: { ...target, tenantBusinessId: "shop-b" } }), scope)).toBe(false);
  });

  it("keeps master configured targets valid while excluding a configured target owned by another tenant", async () => {
    const crossTenant = candidate("tenant-b-product", { businessScope: "tenant", tenantBusinessId: "shop-b" });
    const master = candidate("master-product");
    const snapshot = {
      catalogVersion: "catalog-v1",
      catalogSnapshotHash: "snapshot-v1",
      barcodeCandidates: new Map<string, IdentityCandidate[]>(),
      partNumberCandidates: new Map<string, IdentityCandidate[]>(),
    };
    const source = createReadOnlyCandidateSource({
      snapshot,
      lookupApprovedLinks: async () => [approvedLink(crossTenant), approvedLink(master, { targetProductId: master.productId, evidenceId: "master-link" })],
    });

    const lookup = await source.lookupBatch([identityInput()]);

    expect(lookup.candidatesByRecord.get("row-a")?.map((entry) => entry.productId)).toEqual(["master-product"]);
  });

  it("merges duplicate configured index keys so a real collision remains review in deterministic order", async () => {
    const first = candidate("product-b");
    const second = candidate("product-a");
    const wire = {
      catalogVersion: "catalog-v1",
      catalogSnapshotHash: "",
      barcodeCandidates: [],
      partNumberCandidates: [["PN-100", [first]], ["PN-100", [second]]],
      approvedLinks: [],
    };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));

    const model = await loadConfiguredLocalIdentityReadModel();
    const source = createReadOnlyCandidateSource({ snapshot: model?.snapshot, lookupApprovedLinks: async () => [] });
    const candidates = (await source.lookupBatch([identityInput()])).candidatesByRecord.get("row-a") ?? [];
    const decision = await decideIdentity(identityInput(), {
      catalogVersion: "catalog-v1", catalogSnapshotHash: wire.catalogSnapshotHash, candidates,
    }, genericIdentityPlugin);

    expect(candidates.map((entry) => entry.productId)).toEqual(["product-a", "product-b"]);
    expect(decision.kind).toBe("review");
  });
});
