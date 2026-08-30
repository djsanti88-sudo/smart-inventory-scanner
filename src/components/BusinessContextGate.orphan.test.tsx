import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listMemberships: vi.fn(),
  setBusinessContext: vi.fn(),
  rehydrateForUid: vi.fn(),
}));

vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => "orphan",
  isFirebaseBackend: () => true,
}));
vi.mock("@/authentication/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ uid: "user-1" }),
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
  mocks.listMemberships.mockReset();
  mocks.setBusinessContext.mockReset();
  mocks.rehydrateForUid.mockReset();
});

describe("BusinessContextGate orphan safety", () => {
  it("never activates a selected orphan membership", async () => {
    mocks.listMemberships.mockResolvedValue([]);

    render(<BusinessContextGate><div>scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("business-context-banner")).toBeInTheDocument();
    expect(mocks.rehydrateForUid).not.toHaveBeenCalled();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();
  });

  it("activates the selected business only when the structured loader validates it", async () => {
    mocks.listMemberships.mockResolvedValue([{
      id: "active_user-1",
      businessId: "orphan",
      businessName: "Restored Shop",
      userId: "user-1",
      role: "owner",
    }]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div>scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("orphan", "user-1"));
  });
});
