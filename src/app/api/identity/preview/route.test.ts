import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityPreviewRoute, POST } from "./route";
import { setLocalIdentityPreviewCompositionForTest } from "@/server/identity/previewComposition";
import { deriveConfiguredSnapshotHashes } from "@/server/identity/localIdentityReadModel";

const actualBody = {
  rows: [{ businessId: "demo-shop", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a", sourceFileFingerprint: "file-a", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, identifiers: [{ type: "manufacturer_part_number", namespace: "vendor-a", raw: "PN-1", normalized: "PN-1", source: "csv", evidenceAuthority: "vendor_import", evidenceId: "row-1", evidenceVersion: "1" }], attributes: {}, quantity: 1, rawRecordFingerprint: "row-1" }],
  orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "PN" } }], sourceFileHashes: ["file-a"], importerVersion: "v1",
};

afterEach(() => {
  setLocalIdentityPreviewCompositionForTest(undefined);
  vi.unstubAllEnvs();
});

async function configuredEmptySnapshot(): Promise<string> {
  const wire = { catalogVersion: "local-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [] };
  wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
  return JSON.stringify(wire);
}

describe("POST /api/identity/preview", () => {
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

  it("does not accept a caller-controlled actor header", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", Buffer.alloc(32, 3).toString("base64url"));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "local-owner", businessId: "demo-shop", role: "owner" }]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", await configuredEmptySnapshot());
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "local-owner");
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
