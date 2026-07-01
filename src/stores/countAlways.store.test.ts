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
    // Two direct invocations of the primitive must yield EXACTLY ONE count, never two.
    // (Asserted as an absolute value so this test is self-contained in Task 1 — it does not
    // depend on processScan counting synchronously, which is Task 2's job. Still holds after
    // Task 2: processScan would count it to 1, then both calls below are idempotent no-ops.)
    store.getState().ensureProvisionalCount("111111111116", "test");
    store.getState().ensureProvisionalCount("111111111116", "test");
    expect(totalCount(store)).toBe(1);
  });
});
