import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const seams = vi.hoisted(() => ({
  inspectLegacy: vi.fn(),
  uidPresence: vi.fn(),
}));

vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => "business-1",
  isFirebaseBackend: () => true,
  clearSelectedBusinessId: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ uid: "user-1" }),
  listMemberships: vi.fn().mockResolvedValue([{
    id: "membership-1", businessId: "business-1", businessName: "Business", userId: "user-1", role: "owner",
  }]),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/scan" }));
vi.mock("@/stores/scanPersistNamespace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/scanPersistNamespace")>();
  return { ...actual, inspectLegacyAdoptionCandidate: () => seams.inspectLegacy() };
});
vi.mock("@/stores/scanPersistStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/scanPersistStorage")>();
  return { ...actual, getPersistedStatePresence: () => seams.uidPresence() };
});

import { BusinessContextGate } from "./BusinessContextGate";
import { StoreHydrator } from "./StoreHydrator";
import { useScanStore } from "@/stores/scanStore";

describe("StoreHydrator + BusinessContextGate persistence sequencing", () => {
  beforeEach(() => {
    seams.inspectLegacy.mockResolvedValue("absent");
    seams.uidPresence.mockResolvedValue("found");
    useScanStore.setState({ _hasHydrated: false, businessContextReady: false, businessDataLoaded: false });
  });

  afterEach(() => {
    cleanup();
    seams.inspectLegacy.mockReset();
    seams.uidPresence.mockReset();
    vi.restoreAllMocks();
  });

  it("keeps the gate unmounted through active hydration, then hydrates the UID before activating the business", async () => {
    let finishActive!: () => void;
    let releaseUid!: () => void;
    const active = new Promise<void>((resolve) => {
      finishActive = () => {
        useScanStore.setState({ _hasHydrated: true });
        resolve();
      };
    });
    const uid = new Promise<void>((resolve) => { releaseUid = resolve; });
    const rehydrate = vi.spyOn(useScanStore.persist, "rehydrate")
      .mockImplementationOnce(() => active)
      .mockImplementationOnce(() => uid);
    const setOptions = vi.spyOn(useScanStore.persist, "setOptions");
    const setBusinessContext = vi.spyOn(useScanStore.getState(), "setBusinessContext");

    render(
      <StoreHydrator>
        <BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>
      </StoreHydrator>,
    );

    await waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    expect(setBusinessContext).not.toHaveBeenCalled();
    expect(screen.queryByTestId("scanner")).toBeNull();

    finishActive();
    await waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2));
    expect(setOptions).toHaveBeenCalledWith({ name: "sis-scan-user-1" });
    expect(setBusinessContext).not.toHaveBeenCalled();

    releaseUid();
    await waitFor(() => expect(setBusinessContext).toHaveBeenCalledWith("business-1", "user-1"));
  });
});
