import { describe, expect, it, vi } from "vitest";

import { lookupAllLocalBarcodes, lookupAllLocalPartNumbers, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import { createReadOnlyCandidateSource, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { decideIdentity } from "@/services/identity/engine";
import { genericIdentityPlugin } from "@/services/identity/plugins";
import type { IdentityCandidate, IdentityInput, ScopedIdentifier } from "@/services/identity/types";

const identifier = (overrides: Partial<ScopedIdentifier> = {}): ScopedIdentifier => ({
  type: "upc",
  raw: "012345678905",
  normalized: "012345678905",
  source: "import",
  evidenceAuthority: "vendor_import",
  evidenceId: "input-code",
  evidenceVersion: "v1",
  ...overrides,
});

const input = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "business-1",
  sourceSystem: "vendor-export",
  sourceSignature: "schema-v1",
  vendorId: "vendor-a",
  sourceFileFingerprint: "file-1",
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 2,
  identifiers: [identifier()],
  attributes: {},
  quantity: 1,
  unitOfMeasure: "each",
  rawRecordFingerprint: "row-1",
  ...overrides,
});

const candidate = (productId: string, identifierOverrides: Partial<ScopedIdentifier> = {}): IdentityCandidate => ({
  productId,
  category: "tire",
  businessScope: "master",
  verificationTier: "human_verified",
  automaticEligible: true,
  evidenceId: `evidence-${productId}`,
  evidenceVersion: "v1",
  exactCodeEvidence: true,
  identifiers: [identifier({ source: "local-snapshot", evidenceAuthority: "human_verified_master", ...identifierOverrides })],
  attributes: {},
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-1",
});

const snapshot = (): LocalIdentitySnapshot => ({
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-1",
  barcodeCandidates: new Map([["012345678905", [candidate("product-a"), candidate("product-b")]]]),
  partNumberCandidates: new Map([["PN-100", [candidate("product-c", { type: "manufacturer_part_number", raw: "PN-100", normalized: "PN-100" })]]]),
});

const approvedLink = (targetProductId: string, overrides: Partial<ApprovedLinkLookupResult> = {}): ApprovedLinkLookupResult => ({
  businessId: "business-1",
  sourceSystem: "vendor-export",
  sourceSignature: "schema-v1",
  vendorId: "vendor-a",
  identifierType: "upc",
  namespace: "",
  normalizedValue: "012345678905",
  status: "approved",
  version: 1,
  evidenceId: `link-${targetProductId}`,
  evidenceVersion: "v1",
  automaticEligible: true,
  revokedAt: undefined,
  targetProductId,
  currentTarget: candidate(targetProductId),
  ...overrides,
});

describe("read-only local identity candidate source", () => {
  it("retains every collision hit for exact barcode and part-number keys", () => {
    const local = snapshot();

    expect(lookupAllLocalBarcodes(local, ["012345678905"])).toEqual([candidate("product-a"), candidate("product-b")]);
    expect(lookupAllLocalPartNumbers(local, ["PN-100"])).toEqual([candidate("product-c", { type: "manufacturer_part_number", raw: "PN-100", normalized: "PN-100" })]);
  });

  it("deduplicates repeated lookup keys before the injected approved-link lookup", async () => {
    const lookupApprovedLinks = vi.fn().mockResolvedValue([]);
    const repeated = input({
      identifiers: [identifier(), identifier({ raw: "012345678905", normalized: "012345678905" })],
    });
    const source = createReadOnlyCandidateSource({ snapshot: snapshot(), lookupApprovedLinks });

    const result = await source.lookupBatch([repeated]);

    expect(result.candidatesByRecord.get("row-1")).toEqual([candidate("product-a"), candidate("product-b")]);
    expect(lookupApprovedLinks).toHaveBeenCalledOnce();
    expect(lookupApprovedLinks).toHaveBeenCalledWith({
      businessId: "business-1",
      sourceSystem: "vendor-export",
      sourceSignature: "schema-v1",
      vendorId: "vendor-a",
      identifiers: [identifier()],
    });
  });

  it("passes full tenant and source scope to the approved-link lookup", async () => {
    const lookupApprovedLinks = vi.fn().mockResolvedValue([approvedLink("tenant-product")]);
    const scoped = input();
    const source = createReadOnlyCandidateSource({ snapshot: snapshot(), lookupApprovedLinks });

    const result = await source.lookupBatch([scoped]);

    expect(lookupApprovedLinks).toHaveBeenCalledWith({
      businessId: scoped.businessId,
      sourceSystem: scoped.sourceSystem,
      sourceSignature: scoped.sourceSignature,
      vendorId: scoped.vendorId,
      identifiers: scoped.identifiers,
    });
    expect(result.candidatesByRecord.get(scoped.rawRecordFingerprint)).toContainEqual(expect.objectContaining({ productId: "tenant-product" }));
  });

  it("keeps same-product barcode, part-number, and link evidence atomic in deterministic order", async () => {
    const barcodeHit = candidate("product-a", { evidenceId: "barcode-evidence" });
    const partNumberHit = candidate("product-a", {
      type: "manufacturer_part_number", raw: "PN-100", normalized: "PN-100", evidenceId: "part-number-evidence",
    });
    const local: LocalIdentitySnapshot = {
      ...snapshot(),
      barcodeCandidates: new Map([["012345678905", [candidate("product-b"), barcodeHit]]]),
      partNumberCandidates: new Map([["PN-100", [partNumberHit]]]),
    };
    const source = createReadOnlyCandidateSource({
      snapshot: local,
      lookupApprovedLinks: vi.fn().mockResolvedValue([
        approvedLink("product-a", { evidenceId: "link-evidence", currentTarget: candidate("product-a", { evidenceId: "link-evidence" }) }),
      ]),
    });
    const forward = await source.lookupBatch([input({ identifiers: [identifier(), identifier({ type: "manufacturer_part_number", raw: "PN-100", normalized: "PN-100" })] })]);
    const reverse = await source.lookupBatch([input({ identifiers: [identifier({ type: "manufacturer_part_number", raw: "PN-100", normalized: "PN-100" }), identifier()] })]);

    const forwardCandidates = forward.candidatesByRecord.get("row-1")!;
    expect(forwardCandidates.map((entry) => entry.productId)).toEqual(["product-a", "product-a", "product-a", "product-b"]);
    expect(reverse.candidatesByRecord.get("row-1")).toEqual(forwardCandidates);
    expect(forwardCandidates.filter((entry) => entry.productId === "product-a").flatMap((entry) => entry.identifiers).map((entry) => entry.evidenceId).sort()).toEqual([
      "barcode-evidence", "link-evidence", "part-number-evidence",
    ]);
  });

  it("does not synthesize automatic authority by combining eligibility and immutable evidence from different records", async () => {
    const eligibleButUnverified = {
      ...candidate("product-a"),
      identifiers: [identifier({ evidenceAuthority: "vendor_import" })],
    };
    const immutableButIneligible = {
      ...candidate("product-a"),
      automaticEligible: false,
      identifiers: [identifier({ evidenceAuthority: "human_verified_master" })],
    };
    const local: LocalIdentitySnapshot = {
      ...snapshot(),
      barcodeCandidates: new Map([["012345678905", [eligibleButUnverified, immutableButIneligible]]]),
    };
    const source = createReadOnlyCandidateSource({ snapshot: local, lookupApprovedLinks: vi.fn().mockResolvedValue([]) });

    const candidates = (await source.lookupBatch([input()])).candidatesByRecord.get("row-1")!;
    const decision = await decideIdentity(input(), { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-1", candidates }, genericIdentityPlugin);

    expect(candidates).toHaveLength(2);
    expect(decision.kind).toBe("review");
  });

  it("materializes an approved alias as atomic tenant-link evidence even when the target catalog lacks that alias", async () => {
    const targetWithoutAlias = candidate("tenant-product", { raw: "OTHER-ALIAS", normalized: "OTHER-ALIAS" });
    const source = createReadOnlyCandidateSource({
      snapshot: snapshot(),
      lookupApprovedLinks: vi.fn().mockResolvedValue([
        approvedLink("tenant-product", { evidenceId: "approved-link-1", evidenceVersion: "link-v3", currentTarget: targetWithoutAlias }),
      ]),
    });

    const candidates = (await source.lookupBatch([input()])).candidatesByRecord.get("row-1")!;
    const linkCandidate = candidates.find((entry) => entry.productId === "tenant-product")!;

    expect(linkCandidate).toMatchObject({
      businessScope: "tenant",
      verificationTier: "approved",
      automaticEligible: true,
      exactCodeEvidence: true,
      evidenceId: "approved-link-1",
      evidenceVersion: "link-v3",
      identifiers: [expect.objectContaining({
        normalized: "012345678905",
        evidenceAuthority: "approved_tenant_link",
        evidenceId: "approved-link-1",
        evidenceVersion: "link-v3",
      })],
    });
  });

  it("excludes malformed, non-approved, revoked, cross-scoped, deleted, and conflicting approved links", async () => {
    const source = createReadOnlyCandidateSource({
      snapshot: snapshot(),
      lookupApprovedLinks: vi.fn().mockResolvedValue([
        approvedLink("proposed", { status: "proposed" }),
        approvedLink("revoked", { revokedAt: "2026-07-31T00:00:00.000Z" }),
        approvedLink("cross-tenant", { businessId: "other-business" }),
        approvedLink("deleted", { currentTarget: null }),
        approvedLink("conflict-a"),
        approvedLink("conflict-b"),
        { status: "approved" },
      ]),
    });

    const result = await source.lookupBatch([input()]);

    expect(result.candidatesByRecord.get("row-1")?.map((entry) => entry.productId)).toEqual(["product-a", "product-b"]);
  });

  it("fails closed for an incomplete or version-inconsistent local snapshot", () => {
    const inconsistent = snapshot();
    inconsistent.barcodeCandidates = new Map([["012345678905", [{ ...candidate("product-a"), catalogVersion: "catalog-v2" }]]]);
    expect(() => createReadOnlyCandidateSource({ snapshot: inconsistent, lookupApprovedLinks: vi.fn() })).toThrow("local_snapshot_unavailable");

    const malformed = { ...snapshot(), barcodeCandidates: new Map([["012345678905", [{}]]]) } as unknown as LocalIdentitySnapshot;
    expect(() => createReadOnlyCandidateSource({ snapshot: malformed, lookupApprovedLinks: vi.fn() })).toThrow("local_snapshot_unavailable");
  });

  it("fails closed when no local snapshot is injected", () => {
    expect(() => createReadOnlyCandidateSource({ snapshot: undefined, lookupApprovedLinks: vi.fn() })).toThrow("local_snapshot_unavailable");
  });
});
