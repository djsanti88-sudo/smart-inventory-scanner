import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { applyIdentityImport } from "./applyService";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { createLocalAtomicCountedApply } from "./localAtomicCountedApply";
import { createLocalRepository } from "./localRepository";
import { createIdentityReviewRoute } from "./reviewRoute";
import { createIdentityPreview, verifySignedPreviewChunks } from "@/services/identity/preview";
import type { IdentityCandidate, IdentityCandidateSource, IdentityInput } from "@/services/identity/types";
import { setLocalIdentityApplyCompositionForTest } from "./applyComposition";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalPreviewSigner } from "./previewSigner";
import { deriveConfiguredSnapshotHashes } from "./localIdentityReadModel";
import { POST as applyPost } from "@/app/api/identity/apply/route";
import { POST as previewPost } from "@/app/api/identity/preview/route";

beforeEach(() => { vi.stubEnv("IDENTITY_LOCAL_RUN_ID", `vitest-run-${randomUUID()}`); });

const versions = { engineVersion: "identity-engine-v2", pluginVersions: ["identity-generic-v1"], catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", linkVersion: "links-v1", linkSnapshotHash: "links-snapshot-v1" };
const signingKey = Buffer.alloc(32, 9).toString("base64url");

async function token(): Promise<string> {
  const signer = await createLocalPreviewSigner(signingKey);
  const source: IdentityCandidateSource = { readonlyOnly: true, async lookupBatch(inputs) { return { catalogVersion: "catalog-v1", catalogSnapshotHash: "snapshot-v1", candidatesByRecord: new Map(inputs.map((row) => [row.rawRecordFingerprint, []])) }; } };
  const preview = await createIdentityPreview({ actorId: "owner-a", versions, rows: [{ businessId: "shop-a", sourceSystem: "csv", sourceSignature: "headers-v1", vendorId: "vendor-a", sourceFileFingerprint: "file-a", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, identifiers: [], attributes: {}, quantity: 1, rawRecordFingerprint: "raw-1" }], orderedMappings: [{ sheetName: "Stock", mapping: { quantity: "Qty" } }], sourceFileHashes: ["file-a"], importerVersion: "v1", issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-07-31T00:10:00.000Z" }, { source, signer });
  return preview.signedPayloads[0]!;
}

afterEach(() => { setLocalIdentityApplyCompositionForTest(undefined); vi.unstubAllEnvs(); });

describe("local signed apply composition", () => {
  it("counts an engine-derived master MPN review exactly once when concurrent approvals observe the same unresolved row", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const repository = createLocalRepository(storage);
    const signer = await createLocalPreviewSigner(signingKey);
    const owner = { actorId: "owner-a", businessId: "shop-a", role: "owner" as const };
    const signedAt = "2026-08-02T12:00:00.000Z";
    const mpnVersions = { ...versions, pluginVersions: ["identity-tire-v1"] };
    const mpn = { type: "manufacturer_part_number" as const, raw: "PN-802", normalized: "PN-802", namespace: "vendor-a", source: "csv", evidenceAuthority: "vendor_import" as const, evidenceId: "row-mpn", evidenceVersion: "1" };
    const master: IdentityCandidate = {
      productId: "master-mpn-802", category: "tire", businessScope: "master", verificationTier: "human_verified", automaticEligible: true,
      evidenceId: "catalog-mpn-802", evidenceVersion: "1", exactCodeEvidence: true,
      identifiers: [{ ...mpn, source: "master-catalog", evidenceAuthority: "human_verified_master", evidenceId: "catalog-mpn-802" }],
      attributes: {}, catalogVersion: mpnVersions.catalogVersion, catalogSnapshotHash: mpnVersions.catalogSnapshotHash,
    };
    const row: IdentityInput = {
      businessId: owner.businessId, sourceSystem: "csv", sourceSignature: "mpn-v1", vendorId: "vendor-a", sourceFileFingerprint: "mpn-file", sourceFileOrdinal: 0,
      sheetName: "Stock", sourceRowNumber: 8, categoryHint: "tire", identifiers: [mpn], attributes: {}, quantity: 4, unitOfMeasure: "each", rawRecordFingerprint: "mpn-row-802",
    };
    const source: IdentityCandidateSource = {
      readonlyOnly: true,
      async lookupBatch(inputs) {
        return { catalogVersion: mpnVersions.catalogVersion, catalogSnapshotHash: mpnVersions.catalogSnapshotHash, candidatesByRecord: new Map(inputs.map((input) => [input.rawRecordFingerprint, [master]])) };
      },
    };
    const preview = await createIdentityPreview({
      actorId: owner.actorId, versions: mpnVersions, rows: [row], orderedMappings: [{ sheetName: "Stock", mapping: { partNumber: "MPN", quantity: "Qty" } }], sourceFileHashes: ["mpn-file"], importerVersion: "v1", issuedAt: signedAt, expiresAt: "2026-08-02T12:10:00.000Z",
    }, { source, signer });
    const verified = await verifySignedPreviewChunks(preview.signedPayloads, signer, signedAt, { actorId: owner.actorId, businessId: owner.businessId, versions: mpnVersions });
    expect(verified[0]?.decisions[0]).toMatchObject({ kind: "review", candidates: [expect.objectContaining({ productId: master.productId })] });

    const initial = await applyIdentityImport({ signedPayloads: preview.signedPayloads, mode: "physical_count", corrections: [] }, {
      repository, ledger: createLocalAggregateLedger(storage), verifier: (payloads, now, expected) => verifySignedPreviewChunks(payloads, signer, now, expected), source: { versions: mpnVersions, revalidateCountableTarget: async () => true }, clock: () => signedAt, actor: owner,
    });
    expect(initial).toMatchObject({ countedRows: 0, countQuantity: 0, rows: [{ status: "not_counted", audit: { decisionKind: "review" } }] });
    const [unresolved] = await repository.listIdentityReviews(owner.businessId);
    expect(unresolved).toMatchObject({ decision: { kind: "review" }, signedRowContext: { mode: "physical_count", quantity: 4, eventCreatedAt: signedAt, identifiers: [expect.objectContaining({ normalized: "PN-802" })] } });

    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothAtLookup = new Promise<void>((resolve) => { release = resolve; });
    const reviewRoute = createIdentityReviewRoute({
      enabled: () => true,
      authorize: async () => owner,
      repository: {
        ...repository,
        listIdentityReviews: async (businessId) => {
          const reviews = await repository.listIdentityReviews(businessId);
          arrivals += 1;
          if (arrivals === 1) await bothAtLookup;
          else release?.();
          return reviews;
        },
      },
      currentVersions: async () => ({ catalogVersion: mpnVersions.catalogVersion, linkVersion: mpnVersions.linkVersion }),
      currentModel: async () => ({
        snapshot: { catalogVersion: mpnVersions.catalogVersion, catalogSnapshotHash: mpnVersions.catalogSnapshotHash, barcodeCandidates: new Map(), partNumberCandidates: new Map() },
        linkSnapshotHash: mpnVersions.linkSnapshotHash,
        lookupApprovedLinks: async () => [],
        hasCurrentTarget: async ({ targetProductId }) => targetProductId === master.productId,
      }),
      atomicCountedRow: createLocalAtomicCountedApply(storage, async (validation) => validation.targetProductId === master.productId, { allowedRunStates: ["completed"] }),
    });
    const confirm = () => reviewRoute(new Request("http://local/api/identity/reviews", {
      method: "POST", headers: { "Idempotency-Key": "confirm-mpn-802" }, body: JSON.stringify({ businessId: owner.businessId, action: "confirm_candidate", reviewId: unresolved!.reviewId, targetProductId: master.productId }),
    }));
    const [first, second] = await Promise.all([confirm(), confirm()]);
    expect(await first.json()).toMatchObject({ laterCount: { quantity: 4 } });
    expect(await second.json()).toMatchObject({ laterCount: { quantity: 4 } });
    const links = await repository.listCurrentIdentityLinks(owner.businessId);
    expect(links).toContainEqual(expect.objectContaining({ status: "approved", targetProductId: master.productId, normalizedValue: "PN-802" }));
    const ledger = await storage.transaction((transaction) => transaction.get<Record<string, { event: { productId: string; quantity: number; createdAt: string } }>>("aggregate-ledger"));
    expect(Object.values(ledger ?? {}).filter((entry) => entry.event.productId === master.productId)).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ quantity: 4, createdAt: signedAt }) }),
    ]);
  });

  it("routes a configured vetted snapshot through signed preview and one durable physical count", async () => {
    const run = `route-proof-${Date.now()}`;
    const catalogSnapshotHash = "";
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
    const wire = { catalogVersion: "local-v1", catalogSnapshotHash, barcodeCandidates: [["012345678905", [product]]], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
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
    expect(payload.versions).toMatchObject({ catalogVersion: "local-v1", catalogSnapshotHash: wire.catalogSnapshotHash });

    const applyRequest = { signedPayloads: preview.signedPayloads, mode: "physical_count", corrections: [] } as const;
    const firstApply = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", headers: { "x-scanbin-local-actor": "forged-viewer" }, body: JSON.stringify(applyRequest) }));
    expect(firstApply.status).toBe(200);
    expect(await firstApply.json()).toMatchObject({ mode: "physical_count", countedRows: 1, countQuantity: 3, rows: [{ status: "counted", audit: { targetProductId: product.productId } }] });
    const repeatApply = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify(applyRequest) }));
    const repeatBody = await repeatApply.json();
    expect({ status: repeatApply.status, body: repeatBody }).toMatchObject({ status: 200, body: { countedRows: 1, countQuantity: 3 } });
    const durable = await createFileAtomicLocalStorage({ root: path.join(process.cwd(), ".tmp", "identity-import", process.env.IDENTITY_LOCAL_RUN_ID!) }).transaction((transaction) => transaction.get<Record<string, { event: { importId: string; quantity: number } }>>("aggregate-ledger"));
    const events = Object.values(durable ?? {}).filter((entry) => entry.event.importId === payload.importId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.quantity).toBe(3);

    const invalidCorrection = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ ...applyRequest, corrections: [{ rowId: payload.rowIds[0], targetProductId: "arbitrary-not-in-vetted-snapshot" }] }) }));
    expect(invalidCorrection.status).toBe(409);
    expect(await invalidCorrection.json()).toEqual({ error: "Identity apply was rejected.", code: "apply_idempotency_conflict" });

    const changedProduct = { ...product, catalogVersion: "local-v2", catalogSnapshotHash: "" };
    const changedWire = { catalogVersion: "local-v2", catalogSnapshotHash: "", barcodeCandidates: [["012345678905", [changedProduct]]], partNumberCandidates: [], approvedLinks: [] };
    changedWire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(changedWire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(changedWire));
    const staleVersion = await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify(applyRequest) }));
    expect(staleVersion.status).toBe(409);
    expect(await staleVersion.json()).toEqual({ error: "Identity apply was rejected.", code: "preview_versions_stale" });
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
    const wire = { catalogVersion: "local-v1", catalogSnapshotHash: "", barcodeCandidates: [], partNumberCandidates: [], approvedLinks: [] };
    wire.catalogSnapshotHash = (await deriveConfiguredSnapshotHashes(wire)).catalogSnapshotHash;
    vi.stubEnv("IDENTITY_LOCAL_SNAPSHOT_JSON", JSON.stringify(wire));
    vi.stubEnv("IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON", JSON.stringify([{ actorId: "member", businessId: "shop-a", role: "owner" }])); vi.stubEnv("SCANBIN_LOCAL_ACTOR_ID", "not-a-member");
    expect((await applyPost(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: [await token()], mode: "reconcile", corrections: [] }) }))).status).toBe(403);
  });
});
