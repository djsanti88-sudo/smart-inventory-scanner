import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createIdentityPreview } from "@/services/identity/preview";
import type { IdentityCandidateSource } from "@/services/identity/types";
import { setLocalIdentityApplyCompositionForTest } from "./applyComposition";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalPreviewSigner } from "./previewSigner";
import { POST as applyPost } from "@/app/api/identity/apply/route";
import { POST as previewPost } from "@/app/api/identity/preview/route";

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
  it("routes a configured vetted snapshot through signed preview and one durable physical count", async () => {
    const run = `route-proof-${Date.now()}`;
    const catalogSnapshotHash = "a".repeat(64);
    const owner = { actorId: "local-owner", businessId: "demo-shop", role: "owner" } as const;
    const product = {
      productId: "vetted-tire-1", category: "tire", businessScope: "master", verificationTier: "human_verified", automaticEligible: true,
      evidenceId: "catalog-vetted-1", evidenceVersion: "v1", exactCodeEvidence: true,
      identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "vetted-snapshot", evidenceAuthority: "human_verified_master", evidenceId: "catalog-vetted-1", evidenceVersion: "v1" }],
      attributes: {}, catalogVersion: "local-v1", catalogSnapshotHash,
    };
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", signingKey);
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([owner]));
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify({ catalogVersion: "local-v1", catalogSnapshotHash, barcodeCandidates: [["012345678905", [product]]], partNumberCandidates: [], approvedLinks: [] }));
    vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", owner.actorId);
    const previewRequest = {
      rows: [{ businessId: owner.businessId, sourceSystem: "csv", sourceSignature: "vetted-headers-v1", vendorId: "vetted-vendor", sourceFileFingerprint: `file-${run}`, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, identifiers: [{ type: "upc", raw: "012345678905", normalized: "012345678905", source: "csv", evidenceAuthority: "vendor_import", evidenceId: `row-${run}`, evidenceVersion: "1" }], attributes: {}, quantity: 3, rawRecordFingerprint: run }],
      orderedMappings: [{ sheetName: "Stock", mapping: { barcode: "UPC", quantity: "Qty" } }], sourceFileHashes: [`file-${run}`], importerVersion: "v1",
    };

    const previewResponse = await previewPost(new Request("http://localhost/api/identity/preview", { method: "POST", headers: { "x-scanbin-local-actor": "forged-viewer" }, body: JSON.stringify(previewRequest) }));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { signedPayloads: string[] };
    const payload = JSON.parse(preview.signedPayloads[0]!);
    expect(payload.actorId).toBe(owner.actorId);
    expect(payload.versions).toMatchObject({ catalogVersion: "local-v1", catalogSnapshotHash });

    const applyRequest = { signedPayloads: preview.signedPayloads, mode: "physical_count", corrections: [] } as const;
    const firstApply = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", headers: { "x-scanbin-local-actor": "forged-viewer" }, body: JSON.stringify(applyRequest) }));
    expect(firstApply.status).toBe(200);
    expect(await firstApply.json()).toMatchObject({ mode: "physical_count", countedRows: 1, countQuantity: 3, rows: [{ status: "counted", audit: { targetProductId: product.productId } }] });
    const repeatApply = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify(applyRequest) }));
    expect(repeatApply.status).toBe(200);
    expect(await repeatApply.json()).toMatchObject({ countedRows: 1, countQuantity: 3 });
    const durable = JSON.parse(await readFile(path.join(process.cwd(), ".tmp", "identity-import", "local-apply-v1", "identity-local-storage.json"), "utf8")) as { values: { "aggregate-ledger": Record<string, { event: { importId: string; quantity: number } }> } };
    const events = Object.values(durable.values["aggregate-ledger"]).filter((entry) => entry.event.importId === payload.importId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.quantity).toBe(3);

    const invalidCorrection = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ ...applyRequest, corrections: [{ rowId: payload.rowIds[0], targetProductId: "arbitrary-not-in-vetted-snapshot" }] }) }));
    expect(invalidCorrection.status).toBe(409);
    expect(await invalidCorrection.json()).toEqual({ error: "Identity apply was rejected.", code: "apply_correction_target_invalid" });

    const changedProduct = { ...product, catalogVersion: "local-v2", catalogSnapshotHash: "b".repeat(64) };
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify({ catalogVersion: "local-v2", catalogSnapshotHash: "b".repeat(64), barcodeCandidates: [["012345678905", [changedProduct]]], partNumberCandidates: [], approvedLinks: [] }));
    const staleVersion = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify(applyRequest) }));
    expect(staleVersion.status).toBe(400);
    expect(await staleVersion.json()).toEqual({ error: "Identity apply was rejected.", code: "apply_internal_error" });
  });

  it("uses server-owned owner membership and one injected atomic storage for exported POST", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, now: () => new Date("2026-07-31T00:01:00.000Z"), authenticate: async () => ({ actorId: "owner-a", businessId: "shop-a", role: "owner" }) });
    const response = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "reconcile" });
  });

  it("fails closed with 503 when local server auth/configuration is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    const response = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["bad"], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(503);
  });

  it.each(["counter", "viewer"] as const)("does not let a server-authenticated %s apply", async (role) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, now: () => new Date("2026-07-31T00:01:00.000Z"), authenticate: async () => ({ actorId: "limited", businessId: "shop-a", role }) });
    const response = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", headers: { "x-scanbin-local-actor": "owner-a" }, body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }));
    expect(response.status).toBe(403);
  });

  it("distinguishes no session from a configured nonmember without trusting a forged actor header", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, authenticate: async () => undefined });
    expect((await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }))).status).toBe(401);
    setLocalIdentityApplyCompositionForTest({ storage: createMemoryAtomicLocalStorage(), signingKey: () => signingKey, versions, authenticate: async () => { throw new Error("apply_nonmember"); } });
    expect((await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", headers: { "x-scanbin-local-actor": "owner-a" }, body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }))).status).toBe(403);
  });

  it("returns 403 for a configured local actor without membership", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1"); vi.stubEnv("IDENTITY_PREVIEW_SIGNING_KEY", signingKey);
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify({ catalogVersion: "local-v1", catalogSnapshotHash: "a".repeat(64), barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [] }));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "member", businessId: "shop-a", role: "owner" }])); vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "not-a-member");
    expect((await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }))).status).toBe(403);
  });
});
