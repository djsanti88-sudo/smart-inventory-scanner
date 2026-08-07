import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestScanStore, __resetGeneralDecodePacerForTest } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// BULK PACER (owner-approved 2026-08-07, impl-boss-god-rate.md #4): a 500-2000 code paste must
// self-throttle the decode POST *rate* (not just concurrency) so it stays comfortably under
// AI_LOOKUP_RATE_LIMIT (20000/60s as of 2026-08-07; the historical/legacy default was 600/60s) even
// when every code free-misses the corpus and round-trips fast. This proves a burst of 1000 queued
// decodes gets paced - never all fired in one instant - AND that every one of the 1000 eventually
// fires (none silently dropped) once the fake clock is advanced far enough.

const MISS = { providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } };

function makeStoreWithOpenReviews(n: number): { store: ReturnType<typeof createTestScanStore>; ids: string[] } {
  const store = createTestScanStore({ db: new MockDb() });
  // Create the reviews with AI off so no decode fires during setup - only OUR direct liveDecode calls
  // below drive the queue, so the pacing measurement starts from a clean, known state.
  store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "any" });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    store.getState().processScan(`BULKPACER-CODE-${i}`);
    ids.push(store.getState().needsReviewQueue.at(-1)!.id);
  }
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  // Raise the daily cap well above n: this test isolates the RATE pacer, not the (separately tested)
  // daily-cap gate - a default 200/day limit would otherwise block most of a 1000-code burst outright.
  store.getState().updateSettings({ aiLookupEnabled: true, dailyLookupLimit: n + 500, dailyLookupCount: 0 });
  return { store, ids };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BULK PACER: the general decode queue self-throttles request rate", () => {
  it("a burst of 1000 queued decodes is paced, not fired all at once, and none are dropped", async () => {
    const { store, ids } = makeStoreWithOpenReviews(1000);

    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => MISS })) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;

    vi.useFakeTimers();
    __resetGeneralDecodePacerForTest(Date.now()); // deterministic starting bucket, independent of prior tests

    try {
      // Fire the whole burst "at once" - this is exactly the shape of a fast bulk paste: every review's
      // liveDecode is requested in the same synchronous tick.
      const promises = ids.map((id) => store.getState().liveDecode(id));

      // Immediately after enqueueing (before any timer/microtask has run): dispatch is bounded by
      // concurrency (MAX_CONCURRENT_DECODES = 2) and the runLiveDecodeOnce async prelude (settings/gate
      // work happens before the actual fetch), so far fewer than 1000 fetches have actually started.
      const immediateCalls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      expect(immediateCalls).toBeLessThan(20);

      // Flush pure microtask cascades (no real time passes) - the burst allowance lets a handful more
      // through, but the pacer must stop dispatching once the token bucket is spent, long before 1000.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const afterMicrotaskFlush = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      expect(afterMicrotaskFlush).toBeGreaterThan(0);
      expect(afterMicrotaskFlush).toBeLessThan(50); // nowhere near 1000 - proves it did not all fire at once

      // Advance the fake clock by 1 real second: throughput should be roughly burst + rate*1s, a small
      // fraction of 1000 - still proving the pacing, not just the initial burst allowance.
      await vi.advanceTimersByTimeAsync(1000);
      const after1s = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      expect(after1s).toBeGreaterThan(afterMicrotaskFlush);
      expect(after1s).toBeLessThan(200); // well under 1000 after only 1 simulated second

      // Advance far enough for the ENTIRE burst to drain (1000 codes at the paced rate, generous margin).
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all(promises); // none of the 1000 decode calls is ever dropped/lost/rejected

      const finalCalls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      expect(finalCalls).toBe(1000); // every queued review eventually got its decode request - none dropped

      // TOP LAW: pacing the decode POST cadence never touches counting/feed visibility - every code was
      // already counted at scan time (before liveDecode was ever called), independent of the pacer.
      expect(store.getState().needsReviewQueue.length).toBe(1000);
      expect(store.getState().scanFeed.length).toBe(1000);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  }, 20000);
});
