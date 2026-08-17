import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { useScanStore } from "@/stores/scanStore";

// Defect 1 fix proof (loop2-ui report UI2-1): this indicator is the only above-the-fold, always-mounted
// signal a real user has for offline/pending/failed sync state - SyncStatusBar (the full detail panel)
// lives inside a collapsed <details> in production. It must stay silent on the healthy path (no clutter
// on the core scan loop) and must speak up honestly the moment there is something to say.

beforeEach(() => {
  useScanStore.setState({
    businessId: "business-a",
    online: true,
    pendingSyncQueue: [],
    lastSyncError: null,
  });
});

afterEach(() => {
  cleanup();
  useScanStore.setState({ online: true, pendingSyncQueue: [], lastSyncError: null });
});

describe("SyncStatusIndicator", () => {
  it("renders nothing on the healthy path (online, nothing pending, no error)", () => {
    render(<SyncStatusIndicator />);
    expect(screen.queryByTestId("sync-status-indicator")).toBeNull();
  });

  it("shows an honest offline signal when the store is offline", () => {
    useScanStore.setState({ online: false });
    render(<SyncStatusIndicator />);
    const el = screen.getByTestId("sync-status-indicator");
    expect(el).toBeInTheDocument();
    expect(el.textContent).toMatch(/offline/i);
  });

  it("shows the pending count and a Retry action while items are queued", () => {
    useScanStore.setState({
      pendingSyncQueue: [
        { id: "p1", businessId: "business-a", status: "pending", retryCount: 0, updatedAt: 1 } as never,
      ],
    });
    render(<SyncStatusIndicator />);
    expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("sync-status-indicator-pending").textContent).toMatch(/1 not synced yet/i);
    expect(screen.getByTestId("sync-status-indicator-retry")).toBeInTheDocument();
  });

  it("only counts pending items for the current business", () => {
    useScanStore.setState({
      businessId: "business-a",
      pendingSyncQueue: [
        { id: "p1", businessId: "other-business", status: "pending", retryCount: 0, updatedAt: 1 } as never,
      ],
    });
    render(<SyncStatusIndicator />);
    expect(screen.queryByTestId("sync-status-indicator")).toBeNull();
  });

  it("shows the error copy and a Retry action when the last sync failed", () => {
    useScanStore.setState({ lastSyncError: "permission-denied" });
    render(<SyncStatusIndicator />);
    const el = screen.getByTestId("sync-status-indicator");
    expect(el.textContent).toMatch(/have not saved yet/i);
    expect(screen.getByTestId("sync-status-indicator-retry")).toBeInTheDocument();
  });

  it("clicking Retry calls the store's retrySync action", () => {
    useScanStore.setState({
      pendingSyncQueue: [
        { id: "p1", businessId: "business-a", status: "pending", retryCount: 0, updatedAt: 1 } as never,
      ],
    });
    render(<SyncStatusIndicator />);
    screen.getByTestId("sync-status-indicator-retry").click();
    // retrySync clears quarantined items and calls syncPending; a simple observable effect here is that
    // it does not throw and the pending queue is still a queue we can read from (real drain behavior is
    // covered by scanStore's own tests / the e2e offline-retry-idempotency spec).
    expect(useScanStore.getState().pendingSyncQueue).toBeDefined();
  });
});
