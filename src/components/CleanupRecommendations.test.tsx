import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { CleanupRecommendations } from "@/components/CleanupRecommendations";
import type { InventoryCount } from "@/types";

// M2 regression (Phase 3 follow-up): same leak class as F2 (FinalCountTable). refreshFromCloud
// intentionally does an ADDITIVE cross-session merge into the store's finalCounts (a tested
// cross-device sync path - see refreshFromCloud.store.test.ts). CleanupRecommendations must only
// build recommendations from the CURRENT session's counts, not every session's counts merged in.

// An "orphaned_junk_product" count row: productId has no matching product record, so it is always
// flagged (high confidence) - the simplest deterministic way to prove a row is/isn't included.
const currentSessionOrphan: InventoryCount = {
  id: "cCurrentOrphan", businessId: "b", sessionId: "session-1", productId: "missing-current",
  quantity: 1, lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
};
const otherSessionOrphan: InventoryCount = {
  ...currentSessionOrphan,
  id: "cOtherOrphan",
  sessionId: "other-session-id", // merged in from another device's session by refreshFromCloud
  productId: "missing-other",
};

afterEach(() => cleanup());

describe("CleanupRecommendations session scoping (M2, same leak class as F2)", () => {
  it("recommends cleanup only for the current session's counts after a simulated cross-session merge", () => {
    useScanStore.setState({
      products: [],
      finalCounts: [currentSessionOrphan, otherSessionOrphan],
      aliases: [],
      currentSession: {
        id: "session-1",
        businessId: "b",
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: "",
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
    });

    render(<CleanupRecommendations />);
    fireEvent.click(screen.getByTestId("cleanup-review"));

    expect(screen.queryByTestId(`cleanup-item-${currentSessionOrphan.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`cleanup-item-${otherSessionOrphan.id}`)).toBeNull();
  });
});
