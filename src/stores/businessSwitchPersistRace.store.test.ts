import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durable = vi.hoisted(() => {
  const values = new Map<string, string>();
  const writtenKeys: string[] = [];
  let intentGate: Promise<void> | null = null;
  let releaseIntent: (() => void) | null = null;
  let observeIntent: (() => void) | null = null;
  let holdClear = false;
  let releaseClear: (() => void) | null = null;
  let observeClear: (() => void) | null = null;
  return {
    values,
    writtenKeys,
    hold: () => { intentGate = new Promise<void>((resolve) => { releaseIntent = resolve; }); },
    release: () => { intentGate = null; releaseIntent?.(); },
    waitForIntent: (debug: () => string) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for durable write intent: ${debug()}`)), 5_000);
      observeIntent = () => { clearTimeout(timeout); resolve(); };
    }),
    holdClear: () => { holdClear = true; },
    releaseClear: () => { holdClear = false; releaseClear?.(); },
    waitForClear: (debug: () => string) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for durable clear: ${debug()}`)), 5_000);
      observeClear = () => { clearTimeout(timeout); resolve(); };
    }),
    database: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        writtenKeys.push(key);
        if (intentGate && key.endsWith("::scanbin-write-intent-v1")) {
          observeIntent?.();
          await intentGate;
        }
        values.set(key, value);
      },
      remove: async (key: string) => {
        if (holdClear && key === "sis-scan-owner") {
          observeClear?.();
          await new Promise<void>((resolve) => { releaseClear = resolve; });
        }
        values.delete(key);
      },
      createNamespaceIfAbsent: async (key: string, value: string, metadata: string[]) => {
        if (values.has(key) || metadata.some((candidate) => values.has(candidate))) return "exists" as const;
        values.set(key, value);
        return "created" as const;
      },
    },
  };
});

vi.mock("@/stores/scanPersistStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/scanPersistStorage")>();
  return { ...actual, createNativeIndexedDbDatabase: () => durable.database };
});

import { useScanStore } from "./scanStore";

const initialState = useScanStore.getState();

beforeEach(() => {
  durable.values.clear();
  durable.writtenKeys.length = 0;
  window.localStorage.clear();
  useScanStore.persist.setOptions({ name: "sis-scan-v1" });
  useScanStore.setState(initialState, true);
});

afterEach(() => {
  durable.release();
  durable.releaseClear();
  useScanStore.persist.setOptions({ name: "sis-scan-v1" });
  useScanStore.setState(initialState, true);
  durable.values.clear();
  window.localStorage.clear();
});

describe("same-uid business persistence race", () => {
  it("does not hydrate business B with a delayed A feed, count, review, or raw identifier", async () => {
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.getState().setBusinessContext("business-a", "owner");
    await vi.waitFor(() => expect(durable.values.get("sis-scan-owner")).toBeTruthy());
    durable.hold();
    const intent = durable.waitForIntent(() => `name=${useScanStore.persist.getOptions().name} hydrated=${useScanStore.persist.hasHydrated()} business=${useScanStore.getState().businessId} user=${useScanStore.getState().userId} writes=${durable.writtenKeys.join(",")}`);
    useScanStore.setState({
      scanFeed: [{ id: "A-scan", rawCode: "A-raw-identifier", cleanCode: "A-raw-identifier", quantityDelta: 1 } as never],
      finalCounts: [{ id: "A-count", productId: "A-product", quantity: 1 } as never],
      needsReviewQueue: [{ id: "A-review", cleanCode: "A-raw-identifier" } as never],
    });
    await intent;
    useScanStore.getState().setBusinessContext("business-b", "owner");
    durable.release();
    await vi.waitFor(() => expect(durable.values.get("sis-scan-owner")).toBeTruthy());

    await useScanStore.getState().rehydrateForUid("owner");
    expect(useScanStore.getState().scanFeed.map((row) => row.id)).not.toContain("A-scan");
    expect(useScanStore.getState().finalCounts.map((row) => row.id)).not.toContain("A-count");
    expect(useScanStore.getState().needsReviewQueue.map((row) => row.id)).not.toContain("A-review");
    expect(JSON.stringify(useScanStore.getState())).not.toContain("A-raw-identifier");
  });

  it("keeps a post-reset mutation when its durable clear completes after that mutation", async () => {
    await useScanStore.getState().rehydrateForUid("owner");
    useScanStore.getState().setBusinessContext("business-owner", "owner");
    durable.holdClear();
    const clearStarted = durable.waitForClear(() => `name=${useScanStore.persist.getOptions().name} business=${useScanStore.getState().businessId} user=${useScanStore.getState().userId}`);

    const clear = useScanStore.getState().clearLocalCache();
    await clearStarted;
    useScanStore.setState({
      scanFeed: [{ id: "post-clear-scan", rawCode: "post-clear-raw", cleanCode: "post-clear-raw", quantityDelta: 1 } as never],
      finalCounts: [{ id: "post-clear-count", productId: "post-clear-product", quantity: 1 } as never],
      needsReviewQueue: [{ id: "post-clear-review", cleanCode: "post-clear-raw" } as never],
    });

    durable.releaseClear();
    await expect(clear).resolves.toMatchObject({ cleared: false });
    await vi.waitFor(() => expect(durable.values.get("sis-scan-owner")).toContain("post-clear-scan"));

    await useScanStore.getState().rehydrateForUid("owner");
    expect(useScanStore.getState().scanFeed.map((row) => row.id)).toContain("post-clear-scan");
    expect(useScanStore.getState().finalCounts.map((row) => row.id)).toContain("post-clear-count");
    expect(useScanStore.getState().needsReviewQueue.map((row) => row.id)).toContain("post-clear-review");
    expect(JSON.stringify(useScanStore.getState())).toContain("post-clear-raw");
  });
});
