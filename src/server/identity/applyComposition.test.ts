import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityPreview } from "@/services/identity/preview";
import type { IdentityCandidateSource } from "@/services/identity/types";
import { setLocalIdentityApplyCompositionForTest } from "./applyComposition";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalPreviewSigner } from "./previewSigner";
import { POST } from "@/app/api/identity/apply/route";

const versions = { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" };
const signingKey = Buffer.alloc(32, 9).toString("base64url");

async function token(): Promise<string> {
  const signer = await createLocalPreviewSigner(signingKey);
  const source: IdentityCandidateSource = { readonlyOnly: true, async lookupBatch(inputs) { return { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidatesByRecord: new Map(inputs.map((row) => [row.rawRecordFingerprint, []])) }; } };
  const preview = await createIdentityPreview({ actorId: "owner-a", versions, rows: [{ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a", sourceFileFingerprint: "file-a", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, identifiers: [], attributes: {}, quantity: 1, rawRecordFingerprint: "raw-1" }], orderedMappings: [{ sheetName: "Stock", mapping: { quantity: "Qty" } }], sourceFileHashes: ["file-a"], importerVersion: "v1", issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z" }, { source, signer });
  return preview.signedPayloads[0]!;
}

afterEach(() => { setLocalIdentityApplyCompositionForTest(undefined); vi.unstubAllEnvs(); });

describe("local signed apply composition", () => {
  it("uses server-owned owner membership and one injected atomic storage for exported POST", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, now: () => new Date("2026-07-31T00:01:00.000Z"), authenticate: async () => ({ actorId: "owner-a", businessId: "shop-a", role: "owner" }) });
    const response = await POST(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "reconcile" });
  });

  it("fails closed with 503 when local server auth/configuration is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    const response = await POST(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["bad"], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(503);
  });

  it.each(["counter", "viewer"] as const)("does not let a server-authenticated %s apply", async (role) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, now: () => new Date("2026-07-31T00:01:00.000Z"), authenticate: async () => ({ actorId: "limited", businessId: "shop-a", role }) });
    const response = await POST(new Request("http://localhost/api/identity/apply", { method: "POST", headers: { "x-scanbin-local-actor": "owner-a" }, body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(403);
  });
});
