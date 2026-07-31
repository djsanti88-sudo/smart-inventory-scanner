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

  it("aborts the reset when a physical scan is counted while the UID clear is pending", async () => {
    let resolveClear!: (result: { cleared: boolean; authority: "durable" | "local" | "none" }) => void;
    mocks.removeItem.mockReturnValueOnce(new Promise((resolve) => { resolveClear = resolve; }));

    const { useScanStore } = await import("@/stores/scanStore");
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.setState({ businessId: "business-owner", userId: "owner", scanFeed: [], finalCounts: [] });

    const reset = useScanStore.getState().resetForSignOut();
    const scan = useScanStore.getState().processScan("6419440485331");
    expect(scan).not.toBeNull();
    expect(useScanStore.getState().scanFeed).toHaveLength(1);
    expect(useScanStore.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);

    resolveClear({ cleared: true, authority: "durable" });
    await expect(reset).resolves.toEqual({ cleared: false, authority: "durable" });

    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-owner");
    expect(useScanStore.getState().scanFeed).toHaveLength(1);
    expect(useScanStore.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
  });

  it("aborts the reset when prefix enrichment mutates persisted product state during the UID clear", async () => {
    let resolveClear!: (result: { cleared: boolean; authority: "durable" | "local" | "none" }) => void;
    let resolveFloor!: (response: Response) => void;
    mocks.removeItem.mockReturnValueOnce(new Promise((resolve) => { resolveClear = resolve; }));
    const prefixFetch = vi.fn((url: string) => {
      if (!String(url).includes("/api/prefix-floor")) throw new Error(`unexpected fetch: ${url}`);
      return new Promise<Response>((resolve) => { resolveFloor = resolve; });
    });
    vi.stubGlobal("fetch", prefixFetch);

    const { useScanStore } = await import("@/stores/scanStore");
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.setState({ businessId: "business-owner", userId: "owner", scanFeed: [], finalCounts: [] });
    useScanStore.getState().updateSettings({ aiLookupEnabled: false });
    useScanStore.getState().processScan("5603344000016");
    await vi.waitFor(() => expect(prefixFetch).toHaveBeenCalledWith("/api/prefix-floor?code=5603344000016"));
    const countedProductId = useScanStore.getState().finalCounts[0]?.productId;
    expect(countedProductId).toBeTruthy();
    expect(useScanStore.getState().products.find((product) => product.id === countedProductId)?.name)
      .toBe("Unidentified item (barcode 5603344000016)");

    const reset = useScanStore.getState().resetForSignOut();
    resolveFloor({
      ok: true,
      json: async () => ({
        floor: {
          name: "General (Continental family) / product unconfirmed",
          brand: "General",
          familyLabel: "Continental family",
        },
      }),
    } as Response);
    await vi.waitFor(() => {
      expect(useScanStore.getState().products.find((product) => product.id === countedProductId)?.brand).toBe("General");
    });
    expect(useScanStore.getState().scanFeed).toHaveLength(1);
    expect(useScanStore.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);

    resolveClear({ cleared: true, authority: "durable" });
    await expect(reset).resolves.toEqual({ cleared: false, authority: "durable" });

    expect(useScanStore.persist.getOptions().name).toBe("sis-scan-owner");
    expect(useScanStore.getState().products.find((product) => product.id === countedProductId)?.brand).toBe("General");
    expect(useScanStore.getState().scanFeed).toHaveLength(1);
    expect(useScanStore.getState().finalCounts.reduce((total, row) => total + row.quantity, 0)).toBe(1);
  });

  it("does not apply a delayed prefix enrichment response after the active tenant changes", async () => {
    let resolveFloor!: (response: Response) => void;
    const prefixFetch = vi.fn((url: string) => {
      if (!String(url).includes("/api/prefix-floor")) throw new Error(`unexpected fetch: ${url}`);
      return new Promise<Response>((resolve) => { resolveFloor = resolve; });
    });
    vi.stubGlobal("fetch", prefixFetch);

    const { useScanStore } = await import("@/stores/scanStore");
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.setState({ businessId: "business-owner", userId: "owner", scanFeed: [], finalCounts: [] });
    useScanStore.getState().updateSettings({ aiLookupEnabled: false });
    useScanStore.getState().processScan("5603344000016");
    await vi.waitFor(() => expect(prefixFetch).toHaveBeenCalledWith("/api/prefix-floor?code=5603344000016"));
    const countedProductId = useScanStore.getState().finalCounts[0]?.productId;
    expect(countedProductId).toBeTruthy();

    useScanStore.setState({ businessId: "business-next", userId: "next-owner" });
    const json = vi.fn(async () => ({
      floor: {
        name: "General (Continental family) / product unconfirmed",
        brand: "General",
        familyLabel: "Continental family",
      },
    }));
    resolveFloor({ ok: true, json } as unknown as Response);
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useScanStore.getState().products.find((product) => product.id === countedProductId)?.brand).toBe("");
  });
});
