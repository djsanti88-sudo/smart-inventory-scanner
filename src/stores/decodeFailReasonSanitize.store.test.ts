import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// DEFECT 2 (untrusted string leak): when a scan's decode fetch fails offline, the raw browser error
// ("Failed to fetch") must NOT leak into the user-facing Reason column on the scan feed / review row.
// A network-ish failure must map to honest human copy, keeping the technical detail out of the UI.

function failWith(err: Error) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("failed-decode reason never leaks the raw browser error (DEFECT 2)", () => {
  it("maps a 'Failed to fetch' TypeError to honest human copy on both the feed row and the review", async () => {
    const store = aggressiveStore();
    const code = "878106003504"; // valid UPC-A, no known GS1 prefix mapping
    const { restore } = failWith(new TypeError("Failed to fetch"));
    try {
      store.getState().processScan(code);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"),
      );
    } finally {
      restore();
    }

    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === code);
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === code);
    expect(review, "the failed-decode review exists").toBeDefined();
    expect(feedRow, "the failed-decode feed row exists (TOP-LEVEL LAW: every scan appears)").toBeDefined();

    // The raw browser message must never surface to the user.
    expect(review!.reason).not.toMatch(/Failed to fetch/i);
    expect(feedRow!.reason ?? "").not.toMatch(/Failed to fetch/i);

    // It must be replaced with honest, human copy in the file's existing style.
    expect(review!.reason.toLowerCase()).toMatch(/saved|counted|unverified|retry|offline|lookup/);

    // TOP-LEVEL LAW: the scan is still counted despite the failure.
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
  });
});
