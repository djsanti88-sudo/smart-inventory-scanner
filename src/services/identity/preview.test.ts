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
    sourceFileHashes: ["file-a"], importerVersion: "v1", issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z",
    actorId: "actor-1", versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" },
  };
  return createIdentityPreview({ ...baseline, ...overrides }, { source, signer: await createHmacPreviewSigner("local-test-key") });
};

describe("signed identity preview", () => {
  it("keeps content identity stable across file-hash and time changes while signatures bind them", async () => {
    const first = await create();
    const changed = await create({ sourceFileHashes: ["file-b"], issuedAt: "2026-07-31T00:01:00.000Z", expiresAt: "2026-07-31T00:11:00.000Z" });
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
      issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z", maxChunkBytes: 2_000, actorId: "actor-1",
      versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" },
    }, { source, signer });
    expect(preview.signedPayloads).toHaveLength(2);
    await expect(verifySignedPreviewChunks([...preview.signedPayloads].reverse(), signer)).rejects.toThrow("preview_chunks_out_of_order");
    await expect(verifySignedPreviewChunks(preview.signedPayloads.slice(1), signer)).rejects.toThrow("preview_chunks_incomplete");
    const other = await create();
    await expect(verifySignedPreviewChunks([preview.signedPayloads[0]!, other.signedPayloads[0]!], signer)).rejects.toThrow("preview_chunks_mixed_root");
  });

  it("rejects an otherwise valid expired signed preview", async () => {
    const preview = await create();
    await expect(verifySignedPreviewChunks(preview.signedPayloads, await createHmacPreviewSigner("local-test-key"), "2026-07-31T00:11:00.000Z"))
      .rejects.toThrow("preview_expired");
  });

  it("rejects a preview TTL over fifteen minutes and a future issue time", async () => {
    await expect(create({ issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:16:00.000Z" }))
      .rejects.toThrow("preview_ttl_invalid");
    const preview = await create({ issuedAt: "2026-07-31T00:02:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z" });
    await expect(verifySignedPreviewChunks(preview.signedPayloads, await createHmacPreviewSigner("local-test-key"), "2026-07-31T00:00:00.000Z"))
      .rejects.toThrow("preview_issued_in_future");
  });

  it("rejects a single row that cannot fit into the signed chunk ceiling", async () => {
    await expect(create({ rows: [row({ title: "x".repeat(2_000) })], maxChunkBytes: 32 }))
      .rejects.toThrow("preview_row_too_large");
  });

  it("binds actor and a homogeneous explicit versions envelope while stable versions affect identity", async () => {
    const first = await create();
    const changedActor = await create({ actorId: "actor-2" });
    const changedVersions = await create({ versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v2", linkSnapshotHash: "links-snapshot-v2" } });
    expect(changedActor.preview).toMatchObject(first.preview);
    expect(changedActor.signedPayloads).not.toEqual(first.signedPayloads);
    expect(changedVersions.preview.importId).not.toBe(first.preview.importId);
    expect(JSON.parse(first.signedPayloads[0]!).versions).toEqual({ engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" });
    expect(JSON.parse(first.signedPayloads[0]!).actorId).toBe("actor-1");
  });

  it("checks the current actor, business, and read-model versions when requested", async () => {
    const signer = await createHmacPreviewSigner("local-test-key");
    const preview = await create();
    const expected = { actorId: "actor-1", businessId: "demo-shop", versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" } };
    await expect(verifySignedPreviewChunks(preview.signedPayloads, signer, "2026-07-31T00:01:00.000Z", expected)).resolves.toHaveLength(1);
    await expect(verifySignedPreviewChunks(preview.signedPayloads, signer, "2026-07-31T00:01:00.000Z", { ...expected, actorId: "other" })).rejects.toThrow("preview_actor_mismatch");
    await expect(verifySignedPreviewChunks(preview.signedPayloads, signer, "2026-07-31T00:01:00.000Z", { ...expected, businessId: "other-shop" })).rejects.toThrow("preview_business_mismatch");
    await expect(verifySignedPreviewChunks(preview.signedPayloads, signer, "2026-07-31T00:01:00.000Z", { ...expected, versions: { ...expected.versions, linkSnapshotHash: "changed" } })).rejects.toThrow("preview_versions_stale");
  });

  it("rejects re-signed row-id and decision-fingerprint mismatches", async () => {
    const signer = await createHmacPreviewSigner("local-test-key");
    const preview = await create();
    const tamper = async (mutate: (chunk: Record<string, unknown>) => void) => {
      const chunk = JSON.parse(preview.signedPayloads[0]!) as Record<string, unknown>;
      mutate(chunk);
      const unsigned = { ...chunk };
      delete unsigned.signature;
      return JSON.stringify({ ...unsigned, signature: await signer.sign(JSON.stringify(unsigned)) });
    };
    await expect(verifySignedPreviewChunks([await tamper((chunk) => { (chunk.rowIds as string[])[0] = "wrong"; })], signer, "2026-07-31T00:01:00.000Z"))
      .rejects.toThrow("preview_row_id_invalid");
    await expect(verifySignedPreviewChunks([await tamper((chunk) => { ((chunk.decisions as Array<Record<string, unknown>>)[0]!).decisionFingerprint = "wrong"; })], signer, "2026-07-31T00:01:00.000Z"))
      .rejects.toThrow("preview_decision_invalid");
  });
});
