// src/components/BusinessContextGate.bootstrapError.test.tsx
// Bug #33b: an unhandled rejection (or unbounded wait) anywhere in the bootstrap chain
// (getSession -> listMemberships -> rehydrateForUid) left `status` stuck at "resolving"
// forever, with no error surfaced and no way to recover short of a full page reload.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listMemberships: vi.fn(),
  setBusinessContext: vi.fn(),
  rehydrateForUid: vi.fn(),
}));

vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => "biz-1",
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasMeaningfulLegacyBlobAsync: async () => false,
  hasPersistedBlobAsync: async () => false,
  persistKeyForUid: () => "sis-scan-user",
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) =>
      select({
        businessContextReady: false,
        businessDataLoaded: false,
        setBusinessContext: mocks.setBusinessContext,
      }),
    {
      getState: () => ({
        rehydrateForUid: mocks.rehydrateForUid,
        adoptLegacyLocalData: vi.fn(),
      }),
    },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.getSession.mockReset();
  mocks.listMemberships.mockReset();
  mocks.setBusinessContext.mockReset();
  mocks.rehydrateForUid.mockReset();
});

describe("BusinessContextGate bootstrap failure surfacing", () => {
  it("shows an error state with a Retry affordance when getSession rejects, instead of hanging on the loading banner forever", async () => {
    mocks.getSession.mockRejectedValue(new Error("auth restore failed"));
    mocks.listMemberships.mockResolvedValue([]);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    // Before the fix this never resolves off "business-loading": no error, no retry, no children.
    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(screen.getByTestId("retry-bootstrap")).toBeInTheDocument();
    expect(screen.queryByTestId("business-loading")).toBeNull();
    expect(screen.queryByTestId("child")).toBeNull();
  });

  it("shows an error state with a Retry affordance when listMemberships rejects", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockRejectedValue(new Error("network"));

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(screen.getByTestId("retry-bootstrap")).toBeInTheDocument();
  });

  it("clicking Retry re-runs the bootstrap chain and can recover to ready", async () => {
    mocks.getSession
      .mockRejectedValueOnce(new Error("auth restore failed"))
      .mockResolvedValueOnce({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{
      id: "active_user-1",
      businessId: "biz-1",
      businessName: "Retry Shop",
      userId: "user-1",
      role: "owner",
    }]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("retry-bootstrap"));

    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1"));
  });

  it("times out and surfaces an error instead of hanging forever when getSession never settles", async () => {
    vi.useFakeTimers();
    mocks.getSession.mockReturnValue(new Promise(() => {})); // never resolves, matches the onAuthStateChanged-never-fires failure mode
    mocks.listMemberships.mockResolvedValue([]);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    // Still stuck on loading right before the timeout window elapses.
    expect(screen.getByTestId("business-loading")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.getByTestId("business-context-error")).toBeInTheDocument();
  });
});
