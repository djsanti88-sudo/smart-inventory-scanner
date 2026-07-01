import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function totalCount(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

describe("ensureProvisionalCount is idempotent", () => {
  it("counts an unresolved code exactly once even if invoked twice", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // A scan feed row must exist for the code (processScan normally makes it).
    store.getState().processScan("111111111116");
    const before = totalCount(store);
    // Direct double-invoke of the primitive must not add a second count.
    store.getState().ensureProvisionalCount("111111111116", "test");
    store.getState().ensureProvisionalCount("111111111116", "test");
    expect(totalCount(store)).toBe(before);
  });
});
