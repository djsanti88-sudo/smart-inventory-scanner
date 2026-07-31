import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("scan store persistence health", () => {
  it("surfaces a degraded status when browser IndexedDB is unavailable, without blocking hydration", async () => {
    // jsdom intentionally has no IndexedDB. The real browser fallback must still hydrate the scan store.
    const { useScanStore } = await import("@/stores/scanStore");

    await expect(useScanStore.persist.rehydrate()).resolves.toBeUndefined();
    expect(useScanStore.getState()._hasHydrated).toBe(true);
    expect(useScanStore.getState().persistenceStatus).toBe("degraded");
  });
});
