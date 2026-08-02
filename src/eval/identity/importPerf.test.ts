import fixture from "./fixtures/frozen-5000.v1.json";
import baseline from "./reports/import-perf-baseline.v1.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmacPreviewSigner, createIdentityPreview, verifySignedPreviewChunks } from "@/services/identity/preview";
import { decideIdentity } from "@/services/identity/engine";
import { identityPluginVersions, pluginFor } from "@/services/identity/plugins";
import type { IdentityCandidate, IdentityInput } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";
import { createReadOnlyCandidateSource } from "@/server/identity/readOnlyCandidateSource";
import type { LocalIdentitySnapshot } from "@/server/identity/localSnapshotIndex";

const now = "2026-07-31T00:00:00.000Z";
const rows = fixture.rows as IdentityInput[];
const snapshot: LocalIdentitySnapshot = {
  catalogVersion: fixture.snapshot.catalogVersion,
  catalogSnapshotHash: fixture.snapshot.catalogSnapshotHash,
  barcodeCandidates: new Map(fixture.snapshot.barcodeCandidates as unknown as Array<[string, IdentityCandidate[]]>),
  partNumberCandidates: new Map(fixture.snapshot.partNumberCandidates as unknown as Array<[string, IdentityCandidate[]]>),
};
const versions = { engineVersion: "identity-engine-v2", pluginVersions: [...identityPluginVersions], catalogVersion: snapshot.catalogVersion, catalogSnapshotHash: snapshot.catalogSnapshotHash, linkVersion: "frozen-links-v1", linkSnapshotHash: "frozen-links-hash-v1" };
const approvedLinkReads = vi.fn(async () => []);
const source = createReadOnlyCandidateSource({ snapshot, lookupApprovedLinks: approvedLinkReads });

function nearestRankP95(values: number[]): number { return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!; }

describe("frozen local 5,000-row identity preview", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("benchmark_external_fetch_forbidden"); })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses one batch retrieval, sequential decisions, real signed chunks, and exact accounting within local gates", async () => {
    expect(fixture).toMatchObject({ fixtureVersion: "identity-frozen-5000-v1", syntheticOnly: true, rowCount: 5_000, expectedQuantity: 15_000 });
    expect(fixture.rows).toHaveLength(5_000);
    expect(fixture.snapshot).toMatchObject({ catalogVersion: versions.catalogVersion, catalogSnapshotHash: baseline.snapshotHash });
    expect(fixture.snapshot.barcodeCandidates).toHaveLength(2_000);
    expect(await canonicalSha256({ rows: fixture.rows, snapshot: fixture.snapshot })).toBe(fixture.contentSha256);
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
      decisions.push(await decideIdentity(row, { catalogVersion: lookup.catalogVersion, catalogSnapshotHash: lookup.catalogSnapshotHash, candidates: lookup.candidatesByRecord.get(row.rawRecordFingerprint) ?? [] }, pluginFor(row)));
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
    const verifiedPairs = verified.flatMap((chunk) => chunk.rows.map((row, index) => ({ row, decision: chunk.decisions[index]! })));
    expect(fixture.buckets.map((bucket) => ({ kind: bucket.kind, rows: verifiedPairs.filter((pair) => pair.decision.kind === bucket.kind).length, quantity: verifiedPairs.filter((pair) => pair.decision.kind === bucket.kind).reduce((total, pair) => total + Number(pair.row.quantity), 0) }))).toEqual(fixture.buckets);
    expect(decisions).toHaveLength(fixture.rowCount);
    const warmMedianMs = [...runs].sort((left, right) => left - right)[1]!;
    const decisionP95Ms = nearestRankP95(decisionDurations);
    console.info("identity_import_performance", JSON.stringify({ coldDiagnosticMs: coldMs, warmRunsMs: runs, warmMedianMs, decisionP95Ms, chunkCount: preview.signedPayloads.length, maxChunkBytes: Math.max(...bytes), aggregateChunkBytes: bytes.reduce((total, value) => total + value, 0) }));
    if (process.env.IDENTITY_CAPTURE_PERF === "1") throw new Error(`IDENTITY_PERF_METRICS=${JSON.stringify({ coldDiagnosticMs: coldMs, warmRunsMs: runs, warmMedianMs, decisionP95Ms, chunkCount: preview.signedPayloads.length, maxChunkBytes: Math.max(...bytes), aggregateChunkBytes: bytes.reduce((total, value) => total + value, 0) })}`);
    expect(Math.max(...runs)).toBeLessThanOrEqual(10_000);
    expect(decisionP95Ms).toBeLessThanOrEqual(2);
    expect(coldMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
