import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestScanStore, scanStoreMigrate } from "@/stores/scanStore";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { MockDb } from "@/services/mockDb";
import type { ScanEvent, UnknownCodeReview } from "@/types";

// HARD RULE 0 (count-first durability): the scan event persists and its feed row + Needs Review entry are
// visible BEFORE any decode lookup; a TOTAL rung failure (every decode API rejects) still leaves the raw
// feed row + the Needs Review entry, and both survive a persist/rehydrate cycle. Decode only ever upgrades
// identity asynchronously - it can never be the reason a completed scan is lost.

const REVIEW_STATUS = (r: UnknownCodeReview) => r.status;

/** Simulate a real localStorage persist + rehydrate: partialize (platform view) -> migrate (v6) -> apply. */
function rehydrate(store: ReturnType<typeof createTestScanStore>): ReturnType<typeof createTestScanStore> {
  const persisted = buildPersistedScanState(
    store.getState() as unknown as PersistableScanState,
    "platform", // platform level keeps scanFeed + needsReviewQueue (the customer view sanitizes them but
                //  still keeps the user's own rows - platform is the faithful round-trip for this proof)
  );
  const migrated = scanStoreMigrate(persisted, 6) as Record<string, unknown>;
  const fresh = createTestScanStore({ db: new MockDb() });
  fresh.setState((s) => ({ ...s, ...migrated }));
  return fresh;
}

describe("scanStore count-first durability (HARD RULE 0)", () => {
  beforeEach(() => {
    // Configure AI so the auto-decode gate ALLOWS a live decode (which we then make fail), forcing the
    // total-rung-failure path - not the "AI off, straight to Needs Review" path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        // The status GET must succeed so keys read as configured; the decode POST always REJECTS.
        if (method === "GET") {
          return new Response(
            JSON.stringify({ liveEnabled: true, autoDecodeOnScan: true, geminiConfigured: true, openaiConfigured: true, missingKeys: [], mode: "aggressive", dailyLimit: 100, emergencyStop: false }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error("network down: every decode rung rejected");
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a scan whose EVERY decode rung rejects still leaves a raw feed row + Needs Review entry", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Turn the auto-decode gate ON (keys configured), so the scan attempts a live decode and it FAILS.
    store.getState().setAiStatus({ liveEnabled: true, autoDecodeOnScan: true, geminiConfigured: true, openaiConfigured: true, missingKeys: [] });

    const ev = store.getState().processScan("999888777666");
    expect(ev, "processScan returns the raw scan event synchronously (count-first)").not.toBeNull();

    // Let any queued async decode settle (and reject).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The raw feed row exists regardless of the decode outcome.
    const feedRow = store.getState().scanFeed.find((e: ScanEvent) => e.cleanCode === "999888777666");
    expect(feedRow, "raw feed row present after total decode failure").toBeDefined();

    // The Needs Review entry exists and is still open (decode never resolved it).
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "999888777666");
    expect(review, "Needs Review entry present after total decode failure").toBeDefined();
    expect(REVIEW_STATUS(review!), "review stays open - a failed decode never resolves it").toBe("open");
  });

  it("the raw feed row + Needs Review entry SURVIVE a persist/rehydrate cycle", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ liveEnabled: true, autoDecodeOnScan: true, geminiConfigured: true, openaiConfigured: true, missingKeys: [] });

    store.getState().processScan("555444333222");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Sanity: present before the cycle.
    expect(store.getState().scanFeed.some((e) => e.cleanCode === "555444333222")).toBe(true);
    expect(store.getState().needsReviewQueue.some((r) => r.cleanCode === "555444333222")).toBe(true);

    // Persist -> rehydrate.
    const rehydrated = rehydrate(store);

    expect(rehydrated.getState().scanFeed.some((e) => e.cleanCode === "555444333222"), "feed row survives rehydrate").toBe(true);
    const review = rehydrated.getState().needsReviewQueue.find((r) => r.cleanCode === "555444333222");
    expect(review, "Needs Review entry survives rehydrate").toBeDefined();
    expect(review!.status, "review is still open after rehydrate").toBe("open");
  });
});
