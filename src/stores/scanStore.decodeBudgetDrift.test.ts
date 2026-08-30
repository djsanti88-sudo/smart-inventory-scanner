import { describe, it, expect, vi } from "vitest";
import { createTestScanStore, DEFAULT_SETTINGS } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// T17/AM-9 (2026-07-15, settings drift fix): the server has always clamped decode budget to
// [5000, 8000] (owner cost rule 2026-06-28), but the store's persisted default was 13000 - the
// server silently clamped it down on every request. Fixed: the persisted default now matches
// reality (8000), and every client read site clamps a possibly-stale persisted value (e.g. an
// old install's 13000) into [5000, 8000] before using it, so a live decode fetch NEVER sends an
// out-of-range budgetMs even for a browser that persisted the old default.

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

describe("T17/AM-9 decode budget drift fix", () => {
  it("the store's default decodeBudgetMs is 8000, matching the real server clamp", () => {
    expect(DEFAULT_SETTINGS.decodeBudgetMs).toBe(8000);
    const store = aiOnStore();
    expect(store.getState().settings.decodeBudgetMs).toBe(8000);
  });

  it("a stale persisted decodeBudgetMs of 13000 is clamped to 8000 before being sent to the server", async () => {
    const store = aiOnStore();
    // Simulate an old install that still has the pre-fix persisted value.
    store.getState().updateSettings({ decodeBudgetMs: 13000 });
    const review = openReview(store, "086699998599");

    let sentBody: { budgetMs?: number } | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          providerNames: ["mock"],
          results: [],
          decision: {
            status: "needs_review",
            confidence: 0,
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            reason: "",
            crossCheck: {
              decision: "single_provider",
              confidence: 0,
              reason: "",
              brandSimilarity: 0,
              nameSimilarity: 0,
              contradictions: [],
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    expect(sentBody).not.toBeNull();
    expect(sentBody!.budgetMs).toBe(8000);
    expect(sentBody!.budgetMs).toBeGreaterThanOrEqual(5000);
    expect(sentBody!.budgetMs).toBeLessThanOrEqual(8000);
  });

  it("a persisted decodeBudgetMs below the floor (e.g. 1000) is clamped up to 5000, never sent raw", async () => {
    const store = aiOnStore();
    store.getState().updateSettings({ decodeBudgetMs: 1000 });
    const review = openReview(store, "086699998598");

    let sentBody: { budgetMs?: number } | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          providerNames: ["mock"],
          results: [],
          decision: {
            status: "needs_review",
            confidence: 0,
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            reason: "",
            crossCheck: {
              decision: "single_provider",
              confidence: 0,
              reason: "",
              brandSimilarity: 0,
              nameSimilarity: 0,
              contradictions: [],
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    expect(sentBody).not.toBeNull();
    expect(sentBody!.budgetMs).toBe(5000);
  });
});
