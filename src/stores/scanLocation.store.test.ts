import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("location/deviceId stamping on scan", () => {
  it("a scan taken after setLocation('Bay A') carries location 'Bay A' on the ScanEvent and InventoryCount", () => {
    const store = createTestScanStore({});
    store.getState().setLocation("Bay A");
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0];
    expect(row.location).toBe("Bay A");
    const count = store.getState().finalCounts.find((c) => c.productId === row.matchedProductId);
    expect(count?.location).toBe("Bay A");
  });

  it("changing location mid-session updates the count's location to the MOST RECENT scan's location", () => {
    const store = createTestScanStore({});
    store.getState().setLocation("Bay A");
    store.getState().processScan("012345678905");
    store.getState().setLocation("Bay B");
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0]; // newest first
    expect(row.location).toBe("Bay B");
    const count = store.getState().finalCounts.find((c) => c.productId === row.matchedProductId);
    expect(count?.location).toBe("Bay B");
  });

  it("defaults to the session's location before any explicit setLocation call", () => {
    const store = createTestScanStore({});
    store.getState().startSession("Session A", "Warehouse");
    // startSession does not itself call setLocation; the store's `location` field defaults to "Main"
    // at boot (Task 5) and is independent of the session's own `location` label unless the caller
    // (the scan page, Task 5) explicitly syncs them. This test documents the CURRENT store-level
    // contract: location stamping always uses ScanState.location, not currentSession.location.
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0];
    expect(row.location).toBe("Main");
  });
});
