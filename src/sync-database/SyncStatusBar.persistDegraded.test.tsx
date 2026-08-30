import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncStatusBar } from "@/sync-database/SyncStatusBar";
import { useScanStore } from "@/stores/scanStore";

// Task 2 (persist-failure surface, 2026-08-09): the persistDegraded flag (set by the wired
// onPersistFailure callback, see scanStore.persistDegraded.test.ts for the wiring proof) must render a
// visible, honest warning so a device with genuinely failing storage is not silently trusted the same
// as a healthy one - and must NOT render when there is no degradation (the common case).

vi.mock("@/users-businesses/roles/useAccessLevel", () => ({
  useAccessLevel: () => "business",
  useIsPlatformOwner: () => false,
}));

beforeEach(() => {
  useScanStore.setState({
    businessId: "business-a",
    pendingSyncQueue: [],
    lastSyncError: null,
    persistDegraded: null,
  });
});

afterEach(() => {
  cleanup();
  useScanStore.setState({ persistDegraded: null });
});

describe("SyncStatusBar persist-degraded warning", () => {
  it("shows no warning by default (persistDegraded null)", () => {
    render(<SyncStatusBar />);
    expect(screen.queryByTestId("persist-degraded-warning")).toBeNull();
  });

  it("shows the warning once persistDegraded is set", () => {
    useScanStore.setState({ persistDegraded: { kind: "write" } });
    render(<SyncStatusBar />);
    expect(screen.getByTestId("persist-degraded-warning")).toBeInTheDocument();
    expect(screen.getByTestId("persist-degraded-warning").textContent).toMatch(/device storage is failing/i);
  });

  it("shows the alarming warning for a failed migrate too", () => {
    useScanStore.setState({ persistDegraded: { kind: "migrate" } });
    render(<SyncStatusBar />);
    expect(screen.getByTestId("persist-degraded-warning")).toBeInTheDocument();
  });

  // F4 (tier-3 review round 3, 2026-08-09): "demoted" is not a data-loss event. It fires when the
  // startup probe says IndexedDB is blocked (Chrome block-site-data, enterprise policy, Safari
  // lockdown) or when the perf latch trips - in every one of those cases the localStorage fallback IS
  // the design and writes keep landing. Showing "Device storage is failing" there is a false alarm.
  it("shows a calm, accurate notice (not the failure alarm) when the kind is 'demoted'", () => {
    useScanStore.setState({ persistDegraded: { kind: "demoted" } });
    render(<SyncStatusBar />);
    expect(screen.queryByTestId("persist-degraded-warning")).toBeNull();
    const notice = screen.getByTestId("persist-fallback-notice");
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/this browser limits local storage/i);
    expect(notice.textContent).not.toMatch(/failing/i);
  });
});
