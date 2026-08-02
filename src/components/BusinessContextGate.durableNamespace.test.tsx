import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getPersistedStatePresence: vi.fn(),
  inspectLegacyAdoptionCandidate: vi.fn(),
  rehydrateForUid: vi.fn(),
  setBusinessContext: vi.fn(),
  adoptLegacyLocalData: vi.fn(),
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
  inspectLegacyAdoptionCandidate: (...args: unknown[]) => mocks.inspectLegacyAdoptionCandidate(...args),
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));
vi.mock("@/stores/scanPersistStorage", () => ({
  getPersistedStatePresence: (...args: unknown[]) => mocks.getPersistedStatePresence(...args),
  getAuthoritativePersistFallback: (value: string | null) => {
    if (!value) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.__scanPersistFallback === 1 && typeof parsed.payload === "string" ? parsed.payload : null;
  },
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
      adoptLegacyLocalData: mocks.adoptLegacyLocalData,
    }) },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

beforeEach(() => {
  mocks.inspectLegacyAdoptionCandidate.mockResolvedValue("found");
  mocks.adoptLegacyLocalData.mockResolvedValue({ status: "adopted" });
});

afterEach(() => {
  cleanup();
  mocks.getPersistedStatePresence.mockReset();
  mocks.inspectLegacyAdoptionCandidate.mockReset();
  mocks.rehydrateForUid.mockReset();
  mocks.setBusinessContext.mockReset();
  mocks.adoptLegacyLocalData.mockReset();
});

describe("BusinessContextGate durable UID namespace safety", () => {
  it("waits for UID hydration before activating the selected business", async () => {
    mocks.getPersistedStatePresence.mockResolvedValue("found");
    let release!: () => void;
    mocks.rehydrateForUid.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);
    await waitFor(() => expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1"));
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1"));
  });

  it("offers explicit adoption for a durable-only anonymous candidate", async () => {
    mocks.getPersistedStatePresence.mockResolvedValue("absent");

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
  });

  it("does not activate business context when adoption does not complete", async () => {
    mocks.getPersistedStatePresence.mockResolvedValue("absent");
    mocks.adoptLegacyLocalData.mockResolvedValue({ status: "unavailable" });

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await screen.findByTestId("adopt-banner");
    await screen.getByTestId("adopt-data").click();
    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();
  });

  it("coalesces a double-click while the adoption write is in flight", async () => {
    mocks.getPersistedStatePresence.mockResolvedValue("absent");
    let finish!: (value: { status: "adopted" }) => void;
    mocks.adoptLegacyLocalData.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    const button = await screen.findByTestId("adopt-data");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.adoptLegacyLocalData).toHaveBeenCalledTimes(1);
    finish({ status: "adopted" });
    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1"));
  });

  it("does not offer legacy adoption when the UID snapshot exists only in IndexedDB", async () => {
    // No localStorage ownership marker exists: durable storage is the sole namespace evidence.
    expect(window.localStorage.getItem("sis-scan-user-1")).toBeNull();
    mocks.getPersistedStatePresence.mockResolvedValue("found");
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.getPersistedStatePresence).toHaveBeenCalledWith("sis-scan-user-1"));
    expect(screen.queryByTestId("adopt-banner")).toBeNull();
    await waitFor(() => expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1"));
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1");
  });

  it("pauses legacy adoption when the durable UID namespace cannot be inspected", async () => {
    mocks.getPersistedStatePresence.mockResolvedValue("unavailable");
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.getPersistedStatePresence).toHaveBeenCalledWith("sis-scan-user-1"));
    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(mocks.rehydrateForUid).not.toHaveBeenCalled();
  });

  it("pauses bootstrap when the durable UID namespace cannot be inspected even with a local ownership pointer", async () => {
    window.localStorage.setItem("sis-scan-user-1", '{"__scanPersistPointer":1}');
    mocks.getPersistedStatePresence.mockResolvedValue("unavailable");
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.getPersistedStatePresence).toHaveBeenCalledWith("sis-scan-user-1"));
    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(mocks.rehydrateForUid).not.toHaveBeenCalled();
  });

  it("hydrates from an authoritative atomic fallback when IndexedDB cannot be inspected", async () => {
    window.localStorage.setItem(
      "sis-scan-user-1",
      JSON.stringify({ __scanPersistFallback: 1, payload: '{"version":14}' }),
    );
    mocks.getPersistedStatePresence.mockResolvedValue("unavailable");
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.getPersistedStatePresence).toHaveBeenCalledWith("sis-scan-user-1"));
    await waitFor(() => expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1"));
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1");
    expect(screen.getByTestId("scanner")).toBeInTheDocument();
  });

  it("continues durable UID hydration when localStorage methods throw", async () => {
    const proto = Object.getPrototypeOf(window.localStorage);
    const getItem = vi.spyOn(proto, "getItem").mockImplementation(() => {
      throw new DOMException("storage blocked", "InvalidStateError");
    });
    mocks.inspectLegacyAdoptionCandidate.mockResolvedValue("absent");
    mocks.getPersistedStatePresence.mockResolvedValue("found");
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<BusinessContextGate><div data-testid="scanner">scanner</div></BusinessContextGate>);

    await waitFor(() => expect(mocks.getPersistedStatePresence).toHaveBeenCalledWith("sis-scan-user-1"));
    await waitFor(() => expect(mocks.rehydrateForUid).toHaveBeenCalledWith("user-1"));
    expect(screen.getByTestId("scanner")).toBeInTheDocument();
    getItem.mockRestore();
  });
});
