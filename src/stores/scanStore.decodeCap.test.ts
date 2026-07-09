import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Task 2: a daily_cap 429 from /api/ai-lookup must NOT retry (there is no automatic
// decode-on-cap-reset queue anywhere in the app - verified by grep: only the sync retry queue
// and the manual "Retry live decode" button exist) and must show an honest, non-generic reason
// instead of the "network / rate-limit / provider error" catch-all. A genuine self-inflicted
// rate limit (429 without reasonCode "daily_cap") must keep its existing single Retry-After retry.

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

describe("decodeOnce 429 handling (daily cap vs real rate limit)", () => {
  it("daily_cap 429: no retry, honest reason, exactly one fetch call", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998538");

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ error: "Daily AI lookup cap reached (200/200). No AI call made.", reasonCode: "daily_cap" }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.reason).toContain("Daily AI lookup cap reached");
    expect(r?.reason).toContain("Retry after the cap resets");
    expect(r?.reason).not.toContain("provider error");
    expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(1); // no retry on daily_cap
  });

  it("real rate limit (429, no daily_cap reasonCode): keeps the single Retry-After retry exactly as today", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998539");

    const calls: string[] = [];
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "0" }, // keep the test fast
        });
      }
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
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(2); // single retry preserved
    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    // Genuine rate-limit retry succeeded (200 on retry) - this must NOT surface the daily-cap copy.
    expect(r?.reason ?? "").not.toContain("Daily AI lookup cap reached");
  });
});
