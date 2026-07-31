import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  setBrowserPersistenceStatus: vi.fn(),
}));

vi.mock("@/stores/scanPersistStorage", () => ({
  createAsyncDurablePersistStorage: () => ({
    getItem: mocks.getItem,
    setItem: mocks.setItem,
    removeItem: mocks.removeItem,
  }),
  createNativeIndexedDbDatabase: () => null,
  setBrowserPersistenceStatus: mocks.setBrowserPersistenceStatus,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.getItem.mockResolvedValue(null);
  mocks.setItem.mockResolvedValue(undefined);
  mocks.removeItem.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resetForSignOut durable clear ordering", () => {
  it("keeps the active UID namespace and tenant state while its clear is pending", async () => {
    let resolveClear!: (result: { cleared: boolean; authority: "durable" | "local" | "none" }) => void;
    mocks.removeItem.mockReturnValueOnce(new Promise((resolve) => { resolveClear = resolve; }));

    const { useScanStore } = await import("@/stores/scanStore");
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.setState({
      businessId: "business-owner",
      userId: "owner",
      scanFeed: [{ id: "owner-scan" } as never],
    });

    const reset = useScanStore.getState().resetForSignOut();

    expect(mocks.removeItem).toHaveBeenCalledWith("sis-scan-owner");
    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-owner");
    expect(useScanStore.getState()).toMatchObject({
      businessId: "business-owner",
      userId: "owner",
      scanFeed: [{ id: "owner-scan" }],
    });

    resolveClear({ cleared: false, authority: "none" });
    await expect(reset).resolves.toEqual({ cleared: false, authority: "none" });
    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-owner");
    expect(useScanStore.getState().scanFeed).toEqual([{ id: "owner-scan" }]);
  });

  it("switches to the anonymous namespace only after an authoritative UID clear", async () => {
    mocks.removeItem.mockResolvedValueOnce({ cleared: true, authority: "durable" });

    const { useScanStore } = await import("@/stores/scanStore");
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.setState({ businessId: "business-owner", userId: "owner", scanFeed: [{ id: "owner-scan" } as never] });

    await expect(useScanStore.getState().resetForSignOut()).resolves.toEqual({ cleared: true, authority: "durable" });

    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-v1");
    expect(useScanStore.getState()).toMatchObject({ businessId: "demo-business", userId: null, scanFeed: [] });
  });
});
