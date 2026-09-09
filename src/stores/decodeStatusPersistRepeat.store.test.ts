import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { PendingSyncItem, ScanEvent } from "@/types";

// Codex final verdict (2026-08-04), finding 2 (Medium): scanStore.ts:3971 settles EVERY scanFeed row
// matching the barcode when a decode lands, but the cloud-persistence helper `syncDecodedState`
// (scanStore.ts:1334) used `.find()` to locate "the" ScanEvent for a review's (sessionId, cleanCode)
// pair, so only ONE of the events sharing that code ever received an updated SAVE_SCAN_EVENT sync op.
//
// Repro: an unknown code is scanned twice while its FIRST scan's decode is still in flight. Per
// scanStore.ts:2902-2912, the SECOND scan reuses the still-open review (no second decode call) and
// just mints its own ScanEvent copying the in-flight "decoding" status. When the review's decode
// settles, the local scanFeed.map() at scanStore.ts:3971 flips BOTH events to the settled status (the
// count/local UI was always honest), but the OLD `.find()` persistence only wrote SAVE_SCAN_EVENT for
// one of the two - so a reload/rehydrate from the backend (e.g. the session timeline pulling fresh
// ScanEvents via getScanEventsBySession) restored the un-synced sibling with its stale "decoding"
// status and the false "Looking up product..." badge, even though counts were always correct.
class RecordingTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
};
const emptyLoader = async () => ({ products: [], aliases: [], sessions: [], counts: [] });

describe("scanStore - repeat-scan decode-status persistence (Codex final verdict finding 2)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("persists the settled decodeStatus for EVERY scanFeed row sharing the code, not just the first one found", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "any" });
    store.getState().setBusinessContext("biz1", "user1");
    await flush();

    const CODE = "029142712886"; // valid UPC-A check digit, unknown to the store

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providerNames: ["mock"],
        results: [],
        decision: { status: "needs_review", confidence: 0, reason: "no evidence found", evidenceStrength: "none" },
      }),
    })) as unknown as typeof fetch;

    // First physical scan: opens the review and fires the (mocked) live decode.
    const e1 = store.getState().processScan(CODE);
    expect(e1).toBeTruthy();
    expect(e1!.decodeStatus).toBe("decoding");

    // Second physical scan of the SAME code while the first decode is still in flight: reuses the
    // still-open review (no second decode call), mints its own sibling ScanEvent.
    const e2 = store.getState().processScan(CODE);
    expect(e2).toBeTruthy();
    expect(e2!.id).not.toBe(e1!.id);
    expect(e2!.decodeStatus).toBe("decoding");

    // Wait for the mocked decode to settle and flip BOTH local rows off "decoding".
    await vi.waitFor(() => {
      const row = store.getState().scanFeed.find((e) => e.id === e1!.id);
      expect(row?.decodeStatus).not.toBe("decoding");
    }, { timeout: 5000, interval: 25 });
    await flush();
    await flush();

    const row1 = store.getState().scanFeed.find((e) => e.id === e1!.id);
    const row2 = store.getState().scanFeed.find((e) => e.id === e2!.id);
    // Sanity: the local UI/count truth was always honest for both rows (never the bug).
    expect(row1?.decodeStatus).not.toBe("decoding");
    expect(row2?.decodeStatus).not.toBe("decoding");
    expect(row1?.decodeStatus).toBe(row2?.decodeStatus);

    // The actual regression: BOTH physical scans' settled status must be PERSISTED via SAVE_SCAN_EVENT,
    // not just one - otherwise rehydrating from the backend resurrects the un-synced sibling's stale
    // "decoding" badge.
    const savedStatusFor = (id: string) =>
      target.applied
        .filter((item) => item.entityType === "ScanEvent" && item.entityId === id && item.operation === "SAVE_SCAN_EVENT")
        .map((item) => (item.payload as ScanEvent).decodeStatus);

    const savedForE1 = savedStatusFor(e1!.id);
    const savedForE2 = savedStatusFor(e2!.id);

    expect(savedForE1.length, "e1's settled status must have been synced at least once").toBeGreaterThan(0);
    expect(savedForE2.length, "e2's settled status must ALSO have been synced, not just e1's").toBeGreaterThan(0);
    expect(savedForE1[savedForE1.length - 1]).toBe(row1?.decodeStatus);
    expect(savedForE2[savedForE2.length - 1]).toBe(row2?.decodeStatus);
  });
});
