import { describe, it, expect } from "vitest";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import { createTestScanStore } from "@/stores/scanStore";

describe("resetForSignOut", () => {
  it("wipes tenant state back to the anon baseline", () => {
    const store = createTestScanStore();
    store.setState({
      businessId: "biz-A",
      userId: "user-A",
      scanFeed: [{ id: "e1" } as never],
      needsReviewQueue: [{ id: "r1" } as never],
      pendingSyncQueue: [{ id: "q1" } as never],
      finalCounts: [{ productId: "p1" } as never],
    });
    store.getState().resetForSignOut();
    const s = store.getState();
    expect(s.businessId).toBe(DEMO_BUSINESS_ID);
    expect(s.userId).toBeNull();
    expect(s.scanFeed).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.pendingSyncQueue).toEqual([]);
    expect(s.finalCounts).toEqual([]);
  });
});
