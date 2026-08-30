import { describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

function openReviews(store: ReturnType<typeof createTestScanStore>, codes: string[]) {
  store.getState().setOnline(false);
  for (const code of codes) store.getState().processScan(code);
  store.getState().setOnline(true);
  store.getState().updateSettings({ aiLookupEnabled: true });
  return codes.map((code) => store.getState().needsReviewQueue.find((review) => review.cleanCode === code && review.status === "open")!.id);
}

describe("deterministic exact decode queue", () => {
  it("runs four deterministic-only exact requests alongside, while ordinary decode remains independently capped at two", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ordinaryIds = openReviews(store, ["ORD-Q-1", "ORD-Q-2", "ORD-Q-3"]);
    const exactIds = openReviews(store, ["EXACT-Q-1", "EXACT-Q-2", "EXACT-Q-3", "EXACT-Q-4", "EXACT-Q-5"]);
    const original = globalThis.fetch;
    const pending: Array<{ deterministicOnly: boolean; settle: () => void }> = [];
    let ordinaryConcurrent = 0; let exactConcurrent = 0; let started = 0;
    let ordinaryMax = 0; let exactMax = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      started++;
      const deterministicOnly = JSON.parse(String(init?.body ?? "{}")).deterministicOnly === true;
      if (deterministicOnly) exactMax = Math.max(exactMax, ++exactConcurrent);
      else ordinaryMax = Math.max(ordinaryMax, ++ordinaryConcurrent);
      await new Promise<void>((resolve) => pending.push({ deterministicOnly, settle: resolve }));
      if (deterministicOnly) exactConcurrent--;
      else ordinaryConcurrent--;
      return { ok: true, json: async () => ({ providerNames: ["mock"], results: [], decision: { status: "needs_review", confidence: 0, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, reason: "", crossCheck: { decision: "single_provider" } } }) };
    }) as unknown as typeof fetch;

    try {
      const ordinary = ordinaryIds.map((id) => store.getState().liveDecode(id));
      const exact = exactIds.map((id) => store.getState().liveDecode(id, { deterministicOnly: true }));
      await vi.waitFor(() => expect(pending).toHaveLength(6));
      expect(exactMax).toBe(4);
      expect(ordinaryMax).toBe(2);
      expect(pending.filter((entry) => entry.deterministicOnly)).toHaveLength(4);
      expect(pending.filter((entry) => !entry.deterministicOnly)).toHaveLength(2);

      while (started < ordinaryIds.length + exactIds.length || pending.length > 0) {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!.settle();
      }
      await Promise.all([...ordinary, ...exact]);
      expect(exactMax).toBeLessThanOrEqual(4);
      expect(ordinaryMax).toBeLessThanOrEqual(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
