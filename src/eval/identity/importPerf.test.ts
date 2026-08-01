import fixture from "./fixtures/frozen-5000.v1.json";
import { describe, expect, it } from "vitest";
import { createHmacPreviewSigner, createIdentityPreview, verifySignedPreviewChunks } from "@/services/identity/preview";
import { decideIdentity } from "@/services/identity/engine";
import { genericIdentityPlugin } from "@/services/identity/plugins";
import type { IdentityCandidateSource, IdentityInput } from "@/services/identity/types";

const now = "2026-07-31T00:00:00.000Z";
const versions = { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "frozen-local-v1", catalogSnapshotHash: "frozen-local-hash-v1", linkVersion: "frozen-links-v1", linkSnapshotHash: "frozen-links-hash-v1" };
const rows = Array.from({ length: fixture.rowCount }, (_, index): IdentityInput => ({
  businessId: "local-perf-shop", sourceSystem: "synthetic", sourceSignature: fixture.seed, vendorId: "synthetic-vendor",
  sourceFileFingerprint: fixture.sourceHash, sourceFileOrdinal: 1, sheetName: "Frozen", sourceRowNumber: index + 2,
  identifiers: [{ type: "manufacturer_part_number", raw: `SYN-${index}`, normalized: `SYN-${index}`, namespace: "synthetic-vendor", source: "fixture", evidenceAuthority: "vendor_import", evidenceId: `fixture-${index}`, evidenceVersion: "v1" }],
  attributes: {}, quantity: 1, unitOfMeasure: "each", rawRecordFingerprint: `frozen-${index}`,
}));

const source: IdentityCandidateSource = { readonlyOnly: true, async lookupBatch(inputs) {
  return { catalogVersion: versions.catalogVersion, catalogSnapshotHash: versions.catalogSnapshotHash, candidatesByRecord: new Map(inputs.map((input) => [input.rawRecordFingerprint, []])) };
} };

function nearestRankP95(values: number[]): number { return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!; }

describe("frozen local 5,000-row identity preview", () => {
  it("uses one batch retrieval, sequential decisions, real signed chunks, and exact accounting within local gates", async () => {
    expect(fixture).toMatchObject({ fixtureVersion: "identity-frozen-5000-v1", syntheticOnly: true, rowCount: 5_000, expectedQuantity: 5_000 });
    const signer = await createHmacPreviewSigner("frozen-perf-key");
    // Cold diagnostic is deliberately excluded from gates. Then warm crypto/parser/engine/signer.
    const coldStart = performance.now();
    await createIdentityPreview({ actorId: "perf-owner", rows: rows.slice(0, 1), orderedMappings: [{ sheetName: "Frozen", mapping: { partNumber: "PN" } }], sourceFileHashes: [fixture.sourceHash], importerVersion: "frozen-v1", issuedAt: now, expiresAt: "2026-07-31T00:10:00.000Z", versions }, { source, signer });
    const coldMs = performance.now() - coldStart;
    await source.lookupBatch(rows.slice(0, 1));
    const runs: number[] = [];
    let finalPreview: Awaited<ReturnType<typeof createIdentityPreview>> | undefined;
    for (let run = 0; run < 4; run += 1) {
      const started = performance.now();
      const preview = await createIdentityPreview({ actorId: "perf-owner", rows, orderedMappings: [{ sheetName: "Frozen", mapping: { partNumber: "PN" } }], sourceFileHashes: [fixture.sourceHash], importerVersion: "frozen-v1", issuedAt: now, expiresAt: "2026-07-31T00:10:00.000Z", versions }, { source, signer });
      if (run > 0) runs.push(performance.now() - started);
      finalPreview = preview;
    }
    const preview = finalPreview!;
    const lookup = await source.lookupBatch(rows); // exactly one batch for the decision measurement.
    const decisionDurations: number[] = [];
    const decisions = [];
    for (const row of rows) {
      const started = performance.now();
      decisions.push(await decideIdentity(row, { catalogVersion: lookup.catalogVersion, catalogSnapshotHash: lookup.catalogSnapshotHash, candidates: lookup.candidatesByRecord.get(row.rawRecordFingerprint) ?? [] }, genericIdentityPlugin));
      decisionDurations.push(performance.now() - started);
    }
    const verified = await verifySignedPreviewChunks(preview.signedPayloads, signer, "2026-07-31T00:01:00.000Z");
    const bytes = preview.signedPayloads.map((payload) => new TextEncoder().encode(payload).byteLength);
    expect(preview.signedPayloads.length).toBeGreaterThan(1);
    expect(bytes.every((value) => value <= 512 * 1024)).toBe(true);
    expect(bytes.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(verified.flatMap((chunk) => chunk.rows)).toHaveLength(fixture.rowCount);
    expect(verified.flatMap((chunk) => chunk.decisions)).toHaveLength(fixture.rowCount);
    expect(verified.flatMap((chunk) => chunk.rowIds)).toHaveLength(fixture.rowCount);
    expect(preview.preview.decisions).toHaveLength(fixture.rowCount);
    expect(rows.reduce((total, row) => total + row.quantity, 0)).toBe(fixture.expectedQuantity);
    expect(decisions).toHaveLength(fixture.rowCount);
    expect(Math.max(...runs)).toBeLessThanOrEqual(10_000);
    expect(nearestRankP95(decisionDurations)).toBeLessThanOrEqual(2);
    expect(coldMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
