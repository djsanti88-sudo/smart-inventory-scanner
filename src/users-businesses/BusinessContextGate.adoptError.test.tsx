// src/users-businesses/BusinessContextGate.adoptError.test.tsx
// Defect: the "Adopt it into my account" click handler awaited adoptLegacyLocalData with no
// try/catch. migrateLegacyBlobOnceAsync deliberately propagates IDB copy failures (quota,
// blocked, lockdown), so a rejection left the user stuck on the adopt banner forever: no error,
// no retry, setBusinessContext/setStatus("ready") never ran. The anon blob is untouched by
// design on a failed copy, so adoption must be retryable without losing local data.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listMemberships: vi.fn(),
  setBusinessContext: vi.fn(),
  rehydrateForUid: vi.fn(),
  adoptLegacyLocalData: vi.fn(),
}));

vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/users-businesses/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => "biz-1",
  isFirebaseBackend: () => true,
}));
vi.mock("@/authentication/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasMeaningfulLegacyBlobAsync: async () => true,
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
        adoptLegacyLocalData: mocks.adoptLegacyLocalData,
      }),
    },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

afterEach(() => {
  cleanup();
  mocks.getSession.mockReset();
  mocks.listMemberships.mockReset();
  mocks.setBusinessContext.mockReset();
  mocks.rehydrateForUid.mockReset();
  mocks.adoptLegacyLocalData.mockReset();
});

describe("BusinessContextGate adopt-legacy-data failure surfacing", () => {
  it("shows an error with a retry affordance when adoptLegacyLocalData rejects, then completes adoption on retry", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{
      id: "active_user-1",
      businessId: "biz-1",
      businessName: "Adopt Shop",
      userId: "user-1",
      role: "owner",
    }]);
    mocks.adoptLegacyLocalData
      .mockRejectedValueOnce(new Error("IDB copy failed"))
      .mockResolvedValueOnce(undefined);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("adopt-data"));

    // Never stuck: an honest error appears, banner and children are not left in limbo.
    expect(await screen.findByTestId("adopt-error")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).toBeNull();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();

    // Retry succeeds and completes adoption.
    fireEvent.click(screen.getByTestId("retry-adopt"));

    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1"));
    expect(mocks.adoptLegacyLocalData).toHaveBeenCalledTimes(2);
  });

  it("start fresh still works after an adopt failure, without discarding the anon blob", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{
      id: "active_user-1",
      businessId: "biz-1",
      businessName: "Adopt Shop",
      userId: "user-1",
      role: "owner",
    }]);
    mocks.adoptLegacyLocalData.mockRejectedValue(new Error("IDB copy failed"));
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("adopt-data"));
    expect(await screen.findByTestId("adopt-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("skip-adopt"));

    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1"));
    expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1");
  });
});
