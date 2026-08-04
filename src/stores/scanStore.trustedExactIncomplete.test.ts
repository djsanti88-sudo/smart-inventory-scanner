import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore, scanStoreMigrate } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { validatePendingSyncItem } from "@/services/db/firebase/firebaseSyncSafety";

const UPC_A = "012345678905";
const EAN_13 = "0012345678905";
const GTIN_14 = "00012345678905";
const CANONICAL_ID = "trusted-exact:00012345678905";

function exactResponse(path: "boss_trusted_exact_barcode" | "corpus_exact_barcode" | undefined, fingerprint = path === "boss_trusted_exact_barcode"): Response {
  return {
    ok: true,
    json: async () => ({
      providerNames: ["tire-corpus"],
      results: [{ productName: `Known tire - ${UPC_A}`, brand: "", category: "Tire", specsShort: "", aliases: [], sourceUrls: [] }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Trusted exact index match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheck: { decision: "single_provider" },
        corroborationPath: path,
        trustedExactCanonicalProductId: CANONICAL_ID,
      },
      ...(fingerprint ? { debug: { trustedExactIndex: { schemaVersion: "1.0.0", contentDigest: "A".repeat(64) } } } : {}),
    }),
  } as unknown as Response;
}

function rehydrate(store: ReturnType<typeof createTestScanStore>): ReturnType<typeof createTestScanStore> {
  const persisted = buildPersistedScanState(store.getState() as unknown as PersistableScanState, "platform");
  const fresh = createTestScanStore({ db: new MockDb() });
  fresh.setState((state) => ({ ...state, ...(scanStoreMigrate(persisted, 6) as Record<string, unknown>) }));
  return fresh;
}

describe("Task 5 trusted exact identity with incomplete optional tire metadata", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("settles an authenticated boss exact hit once, without catalog or aliases, and coalesces GTIN spellings", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const aliasesBefore = store.getState().aliases.length;
    const catalogBefore = store.getState().catalog.length;
    const fetchSpy = vi.fn(async () => exactResponse("boss_trusted_exact_barcode"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });

    const events = [UPC_A, EAN_13, GTIN_14].map((code) => store.getState().processScan(code)!);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue.every((review) => review.status === "resolved")).toBe(true));

    const state = store.getState();
    expect(state.products.filter((product) => state.finalCounts.some((count) => count.productId === product.id))).toHaveLength(1);
    expect(state.finalCounts).toHaveLength(1);
    expect(state.finalCounts[0]?.quantity).toBe(3);
    expect(state.products.find((product) => product.id === state.finalCounts[0]?.productId)?.name).toBe(`Known tire - ${UPC_A}`);
    expect(state.aliases).toHaveLength(aliasesBefore);
    expect(state.catalog).toHaveLength(catalogBefore);
    expect([...state.scanFeed].map((event) => ({ id: event.id, rawCode: event.rawCode, createdAt: event.createdAt })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      events.map((event) => ({ id: event.id, rawCode: event.rawCode, createdAt: event.createdAt })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(replayLedgerCounts(state.scanFeed, state.sessionId).map((row) => ({ productId: row.productId, quantity: row.quantity }))).toEqual(
      state.finalCounts.map((row) => ({ productId: row.productId, quantity: row.quantity })),
    );
    const rehydrated = rehydrate(store).getState();
    expect(rehydrated.aliases).toHaveLength(aliasesBefore);
    expect(rehydrated.catalog).toHaveLength(catalogBefore);
    expect(rehydrated.products.find((product) => product.id === rehydrated.finalCounts[0]?.productId)?.trustedExactCanonicalId).toBe(CANONICAL_ID);
  });

  it.each(["corpus_exact_barcode", undefined] as const)("keeps incomplete exact data reviewable unless the server marks the boss path (%s)", async (path) => {
    const store = createTestScanStore({ db: new MockDb() });
    globalThis.fetch = vi.fn(async () => exactResponse(path)) as unknown as typeof fetch;
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });

    store.getState().processScan(UPC_A);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("verified"));

    expect(store.getState().needsReviewQueue[0]?.status).toBe("open");
    expect(store.getState().needsReviewQueue[0]?.hasSuggestion).toBe(true);
  });

  it("does not mark an empty deterministic miss as having a suggestion", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providerNames: [], results: [],
        decision: { status: "needs_review", confidence: 0, reason: "No exact match.", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak" } },
      }),
    })) as unknown as typeof fetch;
    store.getState().updateSettings({ aiLookupEnabled: false });

    store.getState().processScan(UPC_A);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));

    expect(store.getState().needsReviewQueue[0]?.hasSuggestion).toBe(false);
  });

  it("keeps a self-claimed Boss tuple without the authenticated route fingerprint reviewable", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    globalThis.fetch = vi.fn(async () => exactResponse("boss_trusted_exact_barcode", false)) as unknown as typeof fetch;
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });

    store.getState().processScan(UPC_A);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("verified"));

    expect(store.getState().needsReviewQueue[0]?.status).toBe("open");
  });

  it("queues terminal trusted-exact settlement writes with fresh target-bound keys", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setOnline(false);
    const event = store.getState().processScan(UPC_A)!;
    const review = store.getState().needsReviewQueue[0]!;

    store.getState().settleTrustedExactIdentity(review.id, CANONICAL_ID, { name: `Known tire - ${UPC_A}`, category: "Tire" }, "Trusted exact index match.");

    const state = store.getState();
    const terminal = state.pendingSyncQueue.filter((item) => item.operation === "SETTLE_TRUSTED_EXACT");
    expect(terminal).toHaveLength(1);
    const settlement = terminal[0]!;
    const payload = settlement.payload as {
      product: { id: string; verified?: boolean };
      review: { resolutionAction?: string; idempotencyKey?: string };
      terminalEvents: Array<{ id: string; matchedProductId?: string; decodeStatus?: string }>;
      countTransfers?: unknown[];
    };
    expect(payload.product).toMatchObject({ id: review.provisionalProductId, verified: true });
    expect(payload.review.resolutionAction).toBe("trusted_exact");
    expect(payload.terminalEvents).toEqual([expect.objectContaining({ id: event.id, matchedProductId: review.provisionalProductId, decodeStatus: "verified" })]);
    expect(payload.countTransfers).toEqual([]);
    expect(payload.review.idempotencyKey).not.toBe(review.idempotencyKey);
    expect(validatePendingSyncItem(settlement)).toBeNull();
    expect(new Set(terminal.map((item) => item.idempotencyKey)).size).toBe(terminal.length);
  });

  it("persists terminal trusted-exact state for every spelling after canonical transfers", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().setOnline(false);

    const events = [UPC_A, EAN_13, GTIN_14].map((code) => store.getState().processScan(code)!);
    expect(store.getState().needsReviewQueue).toHaveLength(1);
    const review = store.getState().needsReviewQueue[0]!;
    store.getState().settleTrustedExactIdentity(
      review.id,
      CANONICAL_ID,
      { name: `Known tire - ${UPC_A}`, category: "Tire" },
      "Trusted exact index match.",
    );

    store.getState().setOnline(true);

    const snapshot = db.snapshot();
    expect(Object.values(snapshot.scanEvents).map((event) => ({
      id: event.id,
      rawCode: event.rawCode,
      createdAt: event.createdAt,
      matchedProductId: event.matchedProductId,
      decodeStatus: event.decodeStatus,
      status: event.status,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(
      events.map((event) => ({
        id: event.id,
        rawCode: event.rawCode,
        createdAt: event.createdAt,
        matchedProductId: store.getState().finalCounts[0]?.productId,
        decodeStatus: "verified",
        status: "known",
      })).sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(Object.values(snapshot.counts).filter((count) => count.quantity > 0)).toEqual([
      expect.objectContaining({ productId: store.getState().finalCounts[0]?.productId, quantity: 3 }),
    ]);
  });

  it("settles a fingerprinted Boss deep response once while preserving zero-spelling event identity", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const aliasesBefore = store.getState().aliases.length;
    const catalogBefore = store.getState().catalog.length;
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
    store.getState().setOnline(false);
    const events = [UPC_A, EAN_13, GTIN_14].map((code) => store.getState().processScan(code)!);
    const review = store.getState().needsReviewQueue[0]!;
    const fetchSpy = vi.fn(async () => exactResponse("boss_trusted_exact_barcode"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().setOnline(true);
    await Promise.all([
      store.getState().backgroundVerifyDeep(review.id),
      store.getState().backgroundVerifyDeep(review.id),
    ]);
    await store.getState().backgroundVerifyDeep(review.id);

    const state = store.getState();
    expect(state.needsReviewQueue[0]).toMatchObject({ status: "resolved", resolutionAction: "trusted_exact" });
    expect(state.aliases).toHaveLength(aliasesBefore);
    expect(state.catalog).toHaveLength(catalogBefore);
    expect(state.finalCounts).toEqual([expect.objectContaining({ quantity: 3 })]);
    expect(replayLedgerCounts(state.scanFeed, state.sessionId).map((row) => ({ productId: row.productId, quantity: row.quantity }))).toEqual(
      state.finalCounts.map((row) => ({ productId: row.productId, quantity: row.quantity })),
    );
    expect(Object.values(db.snapshot().scanEvents).map((event) => ({
      id: event.id,
      rawCode: event.rawCode,
      createdAt: event.createdAt,
      decodeStatus: event.decodeStatus,
      status: event.status,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(
      events.map((event) => ({ id: event.id, rawCode: event.rawCode, createdAt: event.createdAt, decodeStatus: "verified", status: "known" }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(Object.values(db.snapshot().counts).filter((count) => count.quantity > 0)).toEqual([
      expect.objectContaining({ productId: state.finalCounts[0]?.productId, quantity: 3 }),
    ]);
  });
});
