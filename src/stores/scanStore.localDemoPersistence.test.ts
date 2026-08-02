import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NORMAL_KEY = "sis-scan-v1";
const DEMO_KEY = "sis-local-demo-scan-v1";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("local-demo scan persistence isolation", () => {
  it("hydrates and clears only its dedicated key, leaving normal shop state byte-for-byte intact", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const normalShopBlob = JSON.stringify({ state: { scanFeed: [{ id: "normal-shop-row" }], finalCounts: [] }, version: 14 });
    window.localStorage.setItem(NORMAL_KEY, normalShopBlob);

    const { useScanStore } = await import("@/stores/scanStore");

    expect(useScanStore.persist.getOptions().name).toBe(DEMO_KEY);
    await useScanStore.persist.rehydrate();
    expect(useScanStore.getState().scanFeed.some((row) => row.id === "normal-shop-row")).toBe(false);

    await useScanStore.getState().rehydrateForUid("shop-owner");
    expect(useScanStore.persist.getOptions().name).toBe(DEMO_KEY);

    useScanStore.getState().resetForSignOut();
    window.dispatchEvent(new Event("pagehide"));
    expect(useScanStore.persist.getOptions().name).toBe(DEMO_KEY);
    expect(window.localStorage.getItem(NORMAL_KEY)).toBe(normalShopBlob);

    await useScanStore.getState().clearLocalCache();
    expect(window.localStorage.getItem(NORMAL_KEY)).toBe(normalShopBlob);
    expect(window.localStorage.getItem(DEMO_KEY)).toBeNull();
  });
});
