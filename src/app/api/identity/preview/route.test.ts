import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityPreviewRoute, POST } from "./route";
import { setLocalIdentityPreviewCompositionForTest } from "@/server/identity/previewComposition";
import { deriveConfiguredSnapshotHashes } from "@/server/identity/localIdentityReadModel";
import { buildLocalIdentityPreviewRequest } from "@/components/UniversalImportPanelContainer";
import { createFileAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";

const ownedRoots: string[] = [];

const actualBody = {
  rows: [{ businessId: "demo-shop", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a", sourceFileFingerprint: "file-a", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, identifiers: [{ type: "manufacturer_part_number", namespace: "vendor-a", raw: "PN-1", normalized: "PN-1", source: "csv", evidenceAuthority: "vendor_import", evidenceId: "row-1", evidenceVersion: "1" }], attributes: {}, quantity: 1, rawRecordFingerprint: "row-1" }],
  orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "PN" } }], sourceFileHashes: ["file-a"], importerVersion: "v1",
};

afterEach(async () => {
  setLocalIdentityPreviewCompositionForTest(undefined);
  vi.unstubAllEnvs();
  await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuredEmptySnapshot(): Promise<string> {
  const wire = { catalogVersion: "local-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [] };
  wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
  return JSON.stringify(wire);
}

describe("POST /api/identity/preview", () => {
  it("accepts a bounded 32 MiB local preview input and rejects declared or streamed overflow before delegation", async () => {
    const createPreview = vi.fn().mockResolvedValue({ preview: {}, signedPayloads: [] });
    const handler = createIdentityPreviewRoute({ enabled: () => true, createPreview });
    const within = JSON.stringify({ ...actualBody, rows: Array.from({ length: 5_000 }, (_, index) => ({ ...actualBody.rows[0], rawRecordFingerprint: `row-${index}` })) });
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: within }));
    expect(response.status).toBe(200);
    expect(createPreview).toHaveBeenCalledTimes(1);
    const declared = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", headers: { "content-length": String(32 * 1024 * 1024 + 1) }, body: within }));
    expect(declared.status).toBe(413);
    expect(createPreview).toHaveBeenCalledTimes(1);
  });

  it("rejects a no-length streamed body above 32 MiB without delegation", async () => {
    const createPreview = vi.fn();
    const handler = createIdentityPreviewRoute({ enabled: () => true, createPreview });
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (emitted++ < 33) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    } });
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
    expect(createPreview).not.toHaveBeenCalled();
  });
  it("accepts held and adapter-invalid physical rows and returns one terminal decision for each", async () => {
    const requestBody = buildLocalIdentityPreviewRequest({
      businessId: "demo-shop", file: { name: "held.csv", size: 42 }, sheets: [{
        fileName: "held.csv", kind: "csv", headers: ["Name", "Quantity", "Unit"],
        rows: [["Held", "3", "box"], ["Bad", "", "each"]], headerRowIndex: 0,
        sourceSignature: "headers-held", sourceRowNumbers: [2, 5],
      }],
    });
    const createPreview = vi.fn().mockImplementation(async (input: typeof requestBody) => ({
      preview: { decisions: input.rows.map((row) => ({ kind: row.attributes.adapterStatus === "held" ? "review" : "invalid" })) },
      signedPayloads: ["signed"],
    }));
    const handler = createIdentityPreviewRoute({ enabled: () => true, authorize: async (_request, businessId) => businessId === "demo-shop" ? { actorId: "viewer-1", role: "viewer" } : undefined, createPreview });
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(requestBody) }));
    expect(response.status).toBe(200);
    expect((await response.json()).preview.decisions).toEqual([{ kind: "review" }, { kind: "invalid" }]);
    expect(createPreview).toHaveBeenCalledWith(expect.objectContaining({ rows: expect.arrayContaining([
      expect.objectContaining({ sourceRowNumber: 2 }), expect.objectContaining({ sourceRowNumber: 5 }),
    ]) }), { actorId: "viewer-1", role: "viewer" });
  });

  it("routes a canonically invalid non-scope row through the real engine invalid bucket", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", Buffer.alloc(32, 9).toString("base64url"));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "local-owner", businessId: "demo-shop", role: "owner" }]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", await configuredEmptySnapshot());
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "local-owner");
    vi.stubEnv("IDENTITY_LOCAL_RUN_ID", "route-preview-invalid-test");
    const malformed = {
      ...actualBody,
      rows: [{ ...actualBody.rows[0], quantity: "not-a-number" }],
    };

    const response = await POST(new Request("http://localhost/api/identity/preview", {
      method: "POST",
      body: JSON.stringify(malformed),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview.decisions).toEqual([expect.objectContaining({ kind: "invalid", sourceRecordFingerprint: "row-1" })]);
    expect(JSON.parse(body.signedPayloads[0]).decisions).toEqual([expect.objectContaining({ kind: "invalid" })]);
  });

  it("is unavailable unless the local mock feature flag is enabled", async () => {
    const handler = createIdentityPreviewRoute({ enabled: () => false, createPreview: vi.fn() });
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Identity preview is unavailable." });
  });

  it("accepts only a bounded JSON preview request and delegates through injected local dependencies", async () => {
    const createPreview = vi.fn().mockResolvedValue({ preview: { importId: "import-1" }, signedPayloads: ["signed"] });
    const handler = createIdentityPreviewRoute({ enabled: () => true, createPreview });
    const body = actualBody;
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(createPreview).toHaveBeenCalledWith(body, undefined);
  });

  it("exported POST requires injected membership authorization and signs the server actor", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    const signingKey = Buffer.alloc(32, 1).toString("base64url");
    setLocalIdentityPreviewCompositionForTest({
      snapshot: { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", barcodeCandidates: new Map(), partNumberCandidates: new Map() },
      lookupApprovedLinks: async () => [], signingKey: () => signingKey,
      versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" },
      authenticate: async () => undefined,
    });
    expect((await POST(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(actualBody) }))).status).toBe(403);
    setLocalIdentityPreviewCompositionForTest({
      snapshot: { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", barcodeCandidates: new Map(), partNumberCandidates: new Map() },
      lookupApprovedLinks: async () => [], signingKey: () => signingKey,
      versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" },
      authenticate: async () => ({ actorId: "member-1", role: "viewer" }),
    });
    const response = await POST(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(actualBody) }));
    expect(response.status).toBe(200);
    expect(JSON.parse((await response.json()).signedPayloads[0]).actorId).toBe("member-1");
  });

  it("uses the configured local read-only composition without test injection", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", Buffer.alloc(32, 2).toString("base64url"));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "local-owner", businessId: "demo-shop", role: "owner" }]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", await configuredEmptySnapshot());
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "local-owner");
    vi.stubEnv("IDENTITY_LOCAL_RUN_ID", "route-preview-configured-test");
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await POST(new Request("http://localhost/api/identity/preview", {
      method: "POST", body: JSON.stringify(actualBody),
    }));
    expect(response.status).toBe(200);
    const payload = JSON.parse((await response.json()).signedPayloads[0]);
    expect(payload.actorId).toBe("local-owner");
    expect(payload.versions.catalogSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.versions.linkSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves an initialized file store byte-for-byte untouched during an exported preview", async () => {
    const runId = `route-preview-pure-${randomUUID()}`;
    const root = path.resolve(process.cwd(), ".tmp", "identity-import", runId); ownedRoots.push(root);
    await createFileAtomicLocalStorage({ root }).transaction((transaction) => transaction.set("identity-links", []));
    const before = await readdir(root);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", Buffer.alloc(32, 7).toString("base64url"));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "local-owner", businessId: "demo-shop", role: "owner" }]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", await configuredEmptySnapshot());
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "local-owner");
    vi.stubEnv("IDENTITY_LOCAL_RUN_ID", runId);

    const response = await POST(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(actualBody) }));

    expect(response.status).toBe(200);
    expect(await readdir(root)).toEqual(before);
    expect(before).not.toContain("identity-local-storage.lock");
  });

  it("does not accept a caller-controlled actor header", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", Buffer.alloc(32, 3).toString("base64url"));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "local-owner", businessId: "demo-shop", role: "owner" }]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", await configuredEmptySnapshot());
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "local-owner");
    vi.stubEnv("IDENTITY_LOCAL_RUN_ID", "route-preview-forged-header-test");
    const response = await POST(new Request("http://localhost/api/identity/preview", {
      method: "POST", headers: { "x-scanbin-local-actor": "forged-viewer" }, body: JSON.stringify(actualBody),
    }));
    expect(response.status).toBe(200);
    expect(JSON.parse((await response.json()).signedPayloads[0]).actorId).toBe("local-owner");
  });

  it("does not touch fetch or a writer when an actual exported POST is rejected before composition", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await POST(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(actualBody) }));
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
