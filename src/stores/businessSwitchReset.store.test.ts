import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("setBusinessContext isolation", () => {
  it("clears the previous tenant's needsReviewQueue on a context switch", () => {
    const store = createTestScanStore();
    store.setState({ needsReviewQueue: [{ id: "stale-A" } as never] });
    store.getState().setBusinessContext("business-B", "user-B");
    expect(store.getState().needsReviewQueue).toEqual([]);
    expect(store.getState().businessId).toBe("business-B");
  });

  it("fully REPLACES tenant state when ONE user switches between two businesses", () => {
    const store = createTestScanStore();
    store.setState({
      businessId: "biz-A",
      userId: "user-1",
      scanFeed: [{ id: "feedA" } as never],
      finalCounts: [{ productId: "pA" } as never],
      needsReviewQueue: [{ id: "revA" } as never],
    });
    store.getState().setBusinessContext("biz-B", "user-1");
    const s = store.getState();
    expect(s.scanFeed).toEqual([]); // not merged, not retained
    expect(s.finalCounts).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.businessId).toBe("biz-B");
    expect(s.userId).toBe("user-1");
  });
});
