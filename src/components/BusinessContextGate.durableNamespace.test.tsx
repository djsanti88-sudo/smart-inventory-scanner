import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  hasPersistedState: vi.fn(),
  rehydrateForUid: vi.fn(),
  setBusinessContext: vi.fn(),
}));

vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => "shop-1",
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ uid: "user-1" }),
  listMemberships: vi.fn().mockResolvedValue([{
    id: "membership-1", businessId: "shop-1", businessName: "Shop", userId: "user-1", role: "owner",
  }]),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasLegacyBlob: () => true,
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));
vi.mock("@/stores/scanPersistStorage", () => ({
  hasPersistedState: (...args: unknown[]) => mocks.hasPersistedState(...args),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) => select({
      businessContextReady: true,
      businessDataLoaded: true,
      setBusinessContext: mocks.setBusinessContext,
    }),
    { getState: () => ({
      rehydrateForUid: mocks.rehydrateForUid,
      adoptLegacyLocalData: vi.fn(),
    }) },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

afterEach(() => {
  cleanup();
  mocks.hasPersistedState.mockReset();
  mocks.rehydrateForUid.mockReset();
  mocks.setBusinessContext.mockReset();
});

describe("BusinessContextGate durable UID namespace safety", () => {
  it("does not offer legacy adoption when the UID snapshot exists only in IndexedDB", async () => {
    // No localStorage ownership marker exists: durable storage is the sole namespace evidence.
    expect(window.localStorage.getItem("sis-scan-user-1")).toBeNull();
    mocks.hasPersistedState.mockResolvedValue(true);
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.hasPersistedState).toHaveBeenCalledWith("sis-scan-user-1"));
    expect(screen.queryByTestId("adopt-banner")).toBeNull();
    await waitFor(() => expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1"));
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1");
  });
});
