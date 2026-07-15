import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// AM-1(a) (owner-reported 36-70s browser blocks): the decode fetch previously had no
// AbortController/timeout at all - a slow/hung server response could block the scan row (and the
// browser connection) indefinitely. The fix: an AbortController with timeout = decodeBudgetMs +
// 7000ms margin. On abort the row must NOT be lost - it stays needs_review with an honest
// "still working in the background" reason, and the existing 429/daily-cap retry logic must be
// completely unaffected (an abort is never treated as a retry case).

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

describe("decodeOnce client-side abort (AM-1a)", () => {
  it("a fetch that never resolves is aborted after decodeBudgetMs + 7000ms; row stays needs_review with the honest background-still-working reason", async () => {
    const store = aiOnStore();
    // T17/AM-9: decodeBudgetMs is clamped into [5000, 8000] before use, so the floor (5000) is the
    // smallest value that survives clamping unchanged -> timeout = 5000 + 7000 = 12000ms.
    store.getState().updateSettings({ decodeBudgetMs: 5000 });
    const review = openReview(store, "086699998540");

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      calls.push(String(url));
      // Never resolves on its own; only rejects when our AbortController fires.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    try {
      const p = store.getState().liveDecode(review.id);
      // Before the timeout: nothing has settled yet.
      await vi.advanceTimersByTimeAsync(11_900);
      // After the timeout (12000ms): the abort must have fired.
      await vi.advanceTimersByTimeAsync(200);
      await p;
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.decodeStatus ?? "needs_review").toBe("needs_review");
    expect(r?.reason).toBe(
      "Decode is taking longer than expected - it keeps working in the background; check Needs Review shortly",
    );
    // No retry storm: exactly one fetch call, never a second attempt after an abort.
    expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(1);

    const feed = store.getState().scanFeed.find((ev) => ev.cleanCode === "086699998540");
    expect(feed?.decodeStatus).not.toBe("verified");
  });

  it("a fast-resolving fetch is completely unaffected by the abort timeout", async () => {
    const store = aiOnStore();
    store.getState().updateSettings({ decodeBudgetMs: 5000 });
    const review = openReview(store, "086699998541");

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
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
      ),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    // Not the abort's honest reason - the fast path completed normally.
    expect(r?.reason ?? "").not.toContain("Decode is taking longer than expected");
  });

  it("a daily_cap 429 is still handled exactly as before (abort logic never interferes with existing retry rules)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998542");

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "Daily AI lookup cap reached (200/200). No AI call made.", reasonCode: "daily_cap" }),
        { status: 429 },
      ),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.reason).toContain("Daily AI lookup cap reached");
    expect(r?.reason).not.toContain("Decode is taking longer than expected");
  });
});
