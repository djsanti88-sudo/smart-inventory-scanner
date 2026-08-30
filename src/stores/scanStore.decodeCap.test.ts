import { describe, it, expect, vi, beforeEach } from "vitest";

const { postTelemetry } = vi.hoisted(() => ({ postTelemetry: vi.fn() }));
vi.mock("@/shared/telemetry/telemetry", () => ({ postTelemetry }));

import { createTestScanStore, __resetGeneralDecodePacerForTest } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// S6 follow-up (2026-08-09): the general decode queue's bulk pacer is a MODULE-level token bucket
// shared by every store instance (production truth: the server rate limit is per browser/account, not
// per store). Within this file the 12-decode breaker case above drains it, leaving later cases waiting
// on refill. Reset before every test so each case starts from a full, deterministic bucket.
beforeEach(() => {
  __resetGeneralDecodePacerForTest();
});

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
  it("emits one sanitized telemetry event when repeated failures open the circuit breaker", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998537");
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 12; i++) await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    expect(store.getState().breaker.state).toBe("open");
    expect(postTelemetry).toHaveBeenCalledTimes(1);
    expect(postTelemetry).toHaveBeenCalledWith("breaker_open", "decode_failure_threshold_reached");
  });

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

  it("account_daily_cap 429 (F4): no retry, honest ACCOUNT-scoped reason, exactly one fetch call", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998540");

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ error: "Your daily AI lookup cap is reached (500/500).", reasonCode: "account_daily_cap" }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    // Account-scoped honest copy - NOT a generic retry-promising "provider error", NOT the global cap copy.
    expect(r?.reason).toContain("Your account's daily AI lookup cap is reached");
    expect(r?.reason).toContain("Retry after the cap resets");
    expect(r?.reason).not.toContain("provider error");
    expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(1); // no retry on account cap
  });

  it("daily_cap 429 WITH a known prefix: the row is named by the prefix floor, reason stays the honest cap copy (P2)", async () => {
    const store = aiOnStore();
    // Prefix 5603344 has a real prefixIndex dominant ("general", a Continental-family member), so the
    // floor names it "General (Continental family) / product unconfirmed". The cap block must keep that
    // brand-confident name on the row/review AND keep the honest, non-retry-promising cap reason.
    const code = "5603344000016"; // valid GS1 check digit (a real scanned code from this prefix would have one)
    const review = openReview(store, code);

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "Daily AI lookup cap reached (200/200). No AI call made.",
          reasonCode: "daily_cap",
          floor: { name: "General (Continental family) / product unconfirmed", brand: "General", familyLabel: "Continental family" },
        }),
        { status: 429 }
      )
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    // Honest cap reason is unchanged.
    expect(r?.reason).toContain("Daily AI lookup cap reached");
    expect(r?.reason).toContain("Retry after the cap resets");
    // The row is NOT a bare "Unidentified item" - it carries the floor's brand-confident name.
    expect(r?.suggestedProductName).toBe("General (Continental family) / product unconfirmed");
    // The counted provisional product carries the floor name too (never a fabricated identity).
    const feed = store.getState().scanFeed.find((ev) => ev.cleanCode === code);
    const prod = store.getState().products.find((p) => p.id === feed?.matchedProductId);
    expect(prod?.name).toBe("General (Continental family) / product unconfirmed");
    expect(prod?.verified).toBe(false); // floor is a naming aid, NEVER a verified identity
  });

  it("real rate limit (429, no daily_cap reasonCode): keeps the single Retry-After retry exactly as today", async () => {
    const store = aiOnStore();
    const review = openReview(store, "086699998539");

    const calls: string[] = [];
    const original = globalThis.fetch;
    let decodeCall = 0;
    // URL-AWARE (2026-08-09): the 429 must be aimed at the DECODE endpoint specifically. `processScan`
    // also fires an unpaced, fire-and-forget /api/prefix-floor enrichment request for this bare numeric
    // code, and the old call-INDEX mock ("first call gets the 429") handed the 429 to whichever request
    // happened to arrive first. That was always a race; the S6 pacer default (burst 10 @ 10/s) made the
    // decode POST lose it, so the decode got a clean 200 on attempt 1 and correctly never retried.
    // Keying on the URL asserts exactly what this test always meant: the FIRST /api/ai-lookup attempt
    // is rate limited, and the single Retry-After retry still fires.
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/api/prefix-floor")) {
        return new Response(JSON.stringify({ floor: null }), { status: 200 });
      }
      decodeCall++;
      if (decodeCall === 1) {
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

  // P4 (#28): bug #28 tests - the shared fetchWithBackoff helper. Regression guards that the OLD
  // "capped at 30s + exactly one retry, no jitter" logic never comes back, and that no 429 path can
  // ever violate the TOP-LEVEL LAW (every scan appears and counts).

  it("real rate limit that 429s on EVERY attempt: retries stop at the bounded max-attempt limit (never an infinite loop), and the honest reason surfaces", async () => {
    const store = aiOnStore();
    const code = "086699998543";
    const review = openReview(store, code);

    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      // Retry-After: 1 keeps the test fast (well within the abort-timeout ceiling) while still
      // proving the wait/retry cycle runs and then stops - it never loops forever.
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "Retry-After": "1" } });
    }) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    // Bounded: exactly maxAttempts (2) fetch calls, never a third/unbounded attempt.
    expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(2);

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    // Honest reason - not the daily-cap copy (this was never a cap block), not a raw provider string.
    expect(r?.reason).toContain("Live decode failed (network / rate-limit / provider error)");
    expect(r?.reason).not.toContain("Daily AI lookup cap reached");
  });

  it("TOP-LEVEL LAW: a 429 that exhausts every retry NEVER suppresses the scanned row or its count", async () => {
    const store = aiOnStore();
    const code = "086699998544";
    const review = openReview(store, code);

    // Prove the row/count already existed BEFORE decode even runs (ensureProvisionalCount at scan
    // time, synchronous, before any network call) - decode enrichment failing must never remove it.
    const feedBefore = store.getState().scanFeed.find((ev) => ev.cleanCode === code);
    expect(feedBefore).toBeTruthy();
    const productIdBefore = feedBefore?.matchedProductId;
    const countBefore = store.getState().finalCounts.find((c) => c.productId === productIdBefore);
    expect(countBefore?.quantity).toBeGreaterThanOrEqual(1);

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "Retry-After": "1" } }),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    // Row still on the feed, still counted, after every retry attempt was exhausted with a 429.
    const feedAfter = store.getState().scanFeed.find((ev) => ev.cleanCode === code);
    expect(feedAfter).toBeTruthy();
    const productIdAfter = feedAfter?.matchedProductId;
    const countAfter = store.getState().finalCounts.find((c) => c.productId === productIdAfter);
    expect(countAfter?.quantity).toBeGreaterThanOrEqual(1);
    // The review stays open/reviewable (a failed decode never fabricates or auto-verifies identity).
    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.status).toBe("open");
  });
});
