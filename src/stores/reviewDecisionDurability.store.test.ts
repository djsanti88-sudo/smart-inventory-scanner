import { afterEach, describe, expect, it, vi } from "vitest";
import { MockDb } from "@/sync-database/mock/mockDb";
import { createTestScanStore } from "@/stores/scanStore";
import type { UnknownCodeReview } from "@/types";

const BUSINESS_ID = "business-review-durability";
const SESSION_ID = "session-review-durability";
const CODE = "111222333446";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unknown-review decision durability", () => {
  it("versions ignore, reopen, and human-resolution writes and rejects stale cloud resurrection without changing counts", async () => {
    let staleRemote: UnknownCodeReview[] = [];
    const store = createTestScanStore({
      db: new MockDb(),
      cloudBackend: true,
      trustedExactProbeEnabled: false,
      loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [], reviews: staleRemote }),
    });
    store.setState({
      businessId: BUSINESS_ID,
      userId: "user-review-durability",
      businessContextReady: true,
      businessDataLoaded: true,
      sessionId: SESSION_ID,
      online: false,
    });
    store.getState().updateSettings({ aiLookupEnabled: false });

    const event = store.getState().processScan(CODE);
    expect(event).toBeTruthy();
    const openReview = structuredClone(store.getState().needsReviewQueue.at(-1)!);
    staleRemote = [openReview];
    const initialReviewWrite = store.getState().pendingSyncQueue.filter(
      (item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === openReview.id,
    ).at(-1)!;
    const totalBefore = store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0);
    expect(totalBefore).toBe(1);

    store.getState().resolveUnknown(openReview.id, "ignore", {});
    const ignored = store.getState().needsReviewQueue.find((review) => review.id === openReview.id)!;
    const ignoredWrite = store.getState().pendingSyncQueue.filter(
      (item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === openReview.id,
    ).at(-1)!;
    expect(ignored).toMatchObject({ status: "ignored", resolutionAction: "ignore" });
    expect(ignoredWrite.payload).toMatchObject({ status: "ignored", idempotencyKey: ignoredWrite.idempotencyKey });
    expect(ignoredWrite.idempotencyKey).not.toBe(initialReviewWrite.idempotencyKey);

    // Simulate a fully drained local decision racing a stale one-shot cloud read. No pending-write
    // protection remains, so decision version ordering itself must keep the terminal local truth.
    store.setState({ pendingSyncQueue: [] });
    await store.getState().refreshFromCloud();
    expect(store.getState().needsReviewQueue.find((review) => review.id === openReview.id)?.status).toBe("ignored");
    expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(totalBefore);

    const reopenedId = store.getState().reopenNeedsReview(CODE, "human explicitly reopened");
    expect(reopenedId).toBe(openReview.id);
    const reopenWrite = store.getState().pendingSyncQueue.filter(
      (item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === openReview.id,
    ).at(-1)!;
    expect(reopenWrite.payload).toMatchObject({ status: "open", reopenedFromWrong: true, idempotencyKey: reopenWrite.idempotencyKey });
    expect(reopenWrite.idempotencyKey).not.toBe(ignoredWrite.idempotencyKey);

    store.getState().resolveUnknown(openReview.id, "create_new", {
      newProduct: { name: "Human reviewed widget", primaryBarcode: CODE },
      applyToCount: true,
    });
    const resolvedWrite = store.getState().pendingSyncQueue.filter(
      (item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === openReview.id,
    ).at(-1)!;
    expect(resolvedWrite.payload).toMatchObject({ status: "resolved", resolvedBy: "human", idempotencyKey: resolvedWrite.idempotencyKey });
    expect(resolvedWrite.idempotencyKey).not.toBe(reopenWrite.idempotencyKey);
    expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(totalBefore);
  });

  it("persists an auto-settled review instead of leaving the backend open", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providerNames: ["mock"],
        results: [{
          productName: "Auto durable widget",
          brand: "Acme",
          category: "General",
          primaryBarcode: CODE,
          upc: CODE,
          sourceUrls: [`https://example.test/${CODE}`],
          verifiedFacts: [],
          guesses: [],
          aliases: [],
          confidence: 0.95,
        }],
        decision: {
          status: "verified",
          confidence: 0.95,
          reason: "Verified fixture",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          crossCheck: { decision: "single_provider" },
        },
      }),
    })) as unknown as typeof fetch);

    store.getState().processScan(CODE);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.status).toBe("resolved"));
    const review = store.getState().needsReviewQueue.at(-1)!;
    await vi.waitFor(() => expect(db.snapshot().reviews[review.id]?.status).toBe("resolved"));
    expect(db.snapshot().reviews[review.id]?.idempotencyKey).toBe(review.idempotencyKey);
  });
});
