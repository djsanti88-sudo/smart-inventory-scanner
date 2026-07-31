import { describe, expect, it, vi } from "vitest";

import { lookupAllLocalBarcodes, lookupAllLocalPartNumbers, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import { createReadOnlyCandidateSource } from "./readOnlyCandidateSource";
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
    const lookupApprovedLinks = vi.fn().mockResolvedValue([candidate("tenant-product")]);
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
    expect(result.candidatesByRecord.get(scoped.rawRecordFingerprint)).toContainEqual(candidate("tenant-product"));
  });

  it("fails closed when no local snapshot is injected", () => {
    expect(() => createReadOnlyCandidateSource({ snapshot: undefined, lookupApprovedLinks: vi.fn() })).toThrow("local_snapshot_unavailable");
  });
});
