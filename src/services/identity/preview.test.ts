import { describe, expect, it } from "vitest";
import { createHmacPreviewSigner, createIdentityPreview, verifySignedPreviewChunks } from "./preview";
import type { IdentityCandidateSource, IdentityInput } from "./types";

const row = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "demo-shop", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a",
  sourceFileFingerprint: "file-a", sourceFileOrdinal: 1, sheetName: "Stock", sourceRowNumber: 2,
  identifiers: [{ type: "manufacturer_part_number", namespace: "vendor-a", raw: "PN-1", normalized: "PN-1", source: "csv", evidenceAuthority: "vendor_import", evidenceId: "row-1", evidenceVersion: "1" }],
  attributes: {}, quantity: 2, rawRecordFingerprint: "row-1", ...overrides,
});

const source: IdentityCandidateSource = {
  readonlyOnly: true,
  async lookupBatch(inputs) {
    return { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidatesByRecord: new Map(inputs.map((input) => [input.rawRecordFingerprint, []])) };
  },
};

const create = async (overrides: Partial<Parameters<typeof createIdentityPreview>[0]> = {}) => {
  const baseline: Parameters<typeof createIdentityPreview>[0] = {
    rows: [row()], orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "PN", quantity: "Qty" } }],
    sourceFileHashes: ["file-a"], importerVersion: "v1", issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z",
  };
  return createIdentityPreview({ ...baseline, ...overrides }, { source, signer: await createHmacPreviewSigner("local-test-key") });
};

describe("signed identity preview", () => {
  it("keeps content identity stable across file-hash and time changes while signatures bind them", async () => {
    const first = await create();
    const changed = await create({ sourceFileHashes: ["file-b"], issuedAt: "2026-07-31T01:00:00.000Z", expiresAt: "2026-08-01T01:00:00.000Z" });
    expect(changed.preview.sanitizedContentRootHash).toBe(first.preview.sanitizedContentRootHash);
    expect(changed.preview.importId).toBe(first.preview.importId);
    expect(changed.signedPayloads).not.toEqual(first.signedPayloads);
  });

  it("changes content identity when a sanitized row or mapping changes", async () => {
    const first = await create();
    const rowChanged = await create({ rows: [row({ quantity: 3 })] });
    const mappingChanged = await create({ orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "Part", quantity: "Qty" } }] });
    expect(rowChanged.preview.sanitizedContentRootHash).not.toBe(first.preview.sanitizedContentRootHash);
    expect(rowChanged.preview.importId).not.toBe(first.preview.importId);
    expect(mappingChanged.preview.sanitizedContentRootHash).not.toBe(first.preview.sanitizedContentRootHash);
    expect(mappingChanged.preview.importId).not.toBe(first.preview.importId);
  });

  it("fails closed for reordered, missing, and mixed-root chunks", async () => {
    const signer = await createHmacPreviewSigner("local-test-key");
    const preview = await createIdentityPreview({
      rows: [row(), row({ sourceRowNumber: 3, rawRecordFingerprint: "row-2" })],
      orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "PN" } }], sourceFileHashes: ["file-a"], importerVersion: "v1",
      issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z", maxChunkBytes: 1,
    }, { source, signer });
    expect(preview.signedPayloads).toHaveLength(2);
    await expect(verifySignedPreviewChunks([...preview.signedPayloads].reverse(), signer)).rejects.toThrow("preview_chunks_out_of_order");
    await expect(verifySignedPreviewChunks(preview.signedPayloads.slice(1), signer)).rejects.toThrow("preview_chunks_incomplete");
    const other = await create();
    await expect(verifySignedPreviewChunks([preview.signedPayloads[0]!, other.signedPayloads[0]!], signer)).rejects.toThrow("preview_chunks_mixed_root");
  });

  it("rejects an otherwise valid expired signed preview", async () => {
    const preview = await create();
    await expect(verifySignedPreviewChunks(preview.signedPayloads, await createHmacPreviewSigner("local-test-key"), "2026-08-02T00:00:00.000Z"))
      .rejects.toThrow("preview_expired");
  });
});
