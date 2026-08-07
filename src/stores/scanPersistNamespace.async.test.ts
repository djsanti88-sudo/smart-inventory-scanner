import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable in-memory AsyncBacking double for idbBacking's createIdbBacking(). Each test can
// mutate `idbStore` directly (via the exported map) and toggle `idbAvailable` to simulate the
// SSR/jsdom-absent-indexedDB case (createIdbBacking returning null).
const idbStore = new Map<string, string>();
let idbAvailable = true;
let idbSetItemShouldThrow = false;
let idbRemoveItemShouldThrow = false;

vi.mock("@/stores/idbBacking", () => ({
  createIdbBacking: () => {
    if (!idbAvailable) return null;
    return {
      getItem: async (name: string) => idbStore.get(name) ?? null,
      setItem: async (name: string, value: string) => {
        if (idbSetItemShouldThrow) throw new Error("idb setItem failed");
        idbStore.set(name, value);
      },
      removeItem: async (name: string) => {
        if (idbRemoveItemShouldThrow) throw new Error("idb removeItem failed");
        idbStore.delete(name);
      },
    };
  },
}));

import {
  getPersistedBlob,
  hasPersistedBlobAsync,
  hasMeaningfulLegacyBlobAsync,
  migrateLegacyBlobOnceAsync,
  removePersistedKeyEverywhere,
  LEGACY_PERSIST_KEY,
  persistKeyForUid,
} from "./scanPersistNamespace";

beforeEach(() => {
  idbStore.clear();
  idbAvailable = true;
  idbSetItemShouldThrow = false;
  idbRemoveItemShouldThrow = false;
  window.localStorage.clear();
});

describe("getPersistedBlob", () => {
  it("returns the IDB value when both stores hold the key (IDB wins)", async () => {
    idbStore.set("k1", "from-idb");
    window.localStorage.setItem("k1", "from-ls");
    await expect(getPersistedBlob("k1")).resolves.toBe("from-idb");
  });

  it("falls back to localStorage when IDB misses", async () => {
    window.localStorage.setItem("k2", "from-ls");
    await expect(getPersistedBlob("k2")).resolves.toBe("from-ls");
  });

  it("returns null when neither store holds the key", async () => {
    await expect(getPersistedBlob("missing")).resolves.toBeNull();
  });
});

describe("hasPersistedBlobAsync", () => {
  it("is true when ONLY IDB has it", async () => {
    idbStore.set("only-idb", "v");
    await expect(hasPersistedBlobAsync("only-idb")).resolves.toBe(true);
  });

  it("is true when ONLY localStorage has it", async () => {
    window.localStorage.setItem("only-ls", "v");
    await expect(hasPersistedBlobAsync("only-ls")).resolves.toBe(true);
  });

  it("is false when neither store has it", async () => {
    await expect(hasPersistedBlobAsync("neither")).resolves.toBe(false);
  });
});

describe("hasMeaningfulLegacyBlobAsync", () => {
  it("is false for an empty-state blob even though the key exists (N2 guard)", async () => {
    idbStore.set(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [], finalCounts: [], needsReviewQueue: [] }, version: 8 }),
    );
    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(false);
  });

  it("is true for a blob with a non-empty scanFeed", async () => {
    idbStore.set(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [{ id: "e1" }], finalCounts: [], needsReviewQueue: [] }, version: 8 }),
    );
    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(true);
  });

  it("is false when no legacy blob exists at all", async () => {
    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(false);
  });
});

describe("migrateLegacyBlobOnceAsync", () => {
  it("copies the anon blob into the per-uid IDB slot AND removes the anon blob from both stores; normalizes quantityDelta:0 -> 1", async () => {
    const legacy = {
      state: { scanFeed: [{ id: "e1", quantityDelta: 0 }, { id: "e2", quantityDelta: 3 }], businessId: "b1" },
      version: 7,
    };
    idbStore.set(LEGACY_PERSIST_KEY, JSON.stringify(legacy));
    window.localStorage.setItem(LEGACY_PERSIST_KEY, JSON.stringify(legacy));

    await migrateLegacyBlobOnceAsync("abc123");

    const targetKey = persistKeyForUid("abc123");
    const copiedRaw = idbStore.get(targetKey);
    expect(copiedRaw).toBeTruthy();
    const copied = JSON.parse(copiedRaw!);
    expect(copied.state.scanFeed[0].quantityDelta).toBe(1); // 0 -> 1
    expect(copied.state.scanFeed[1].quantityDelta).toBe(3); // untouched

    expect(idbStore.get(LEGACY_PERSIST_KEY)).toBeUndefined();
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull();
  });

  it("is a no-op when the per-uid slot already exists in IDB (idempotency guard reads IDB)", async () => {
    const targetKey = persistKeyForUid("abc123");
    idbStore.set(targetKey, JSON.stringify({ state: { marker: "keep" }, version: 8 }));
    idbStore.set(LEGACY_PERSIST_KEY, JSON.stringify({ state: { scanFeed: [{ id: "e1", quantityDelta: 0 }] }, version: 7 }));

    await migrateLegacyBlobOnceAsync("abc123");

    expect(JSON.parse(idbStore.get(targetKey)!).state.marker).toBe("keep");
    expect(idbStore.get(LEGACY_PERSIST_KEY)).toBeTruthy(); // nothing consumed
  });
});

describe("removePersistedKeyEverywhere", () => {
  it("removes from both stores", () => {
    idbStore.set("rk", "v");
    window.localStorage.setItem("rk", "v");
    removePersistedKeyEverywhere("rk");
    expect(window.localStorage.getItem("rk")).toBeNull();
    // IDB removal is async/fire-and-forget; give the microtask queue a tick.
    return Promise.resolve().then(() => {
      expect(idbStore.get("rk")).toBeUndefined();
    });
  });

  it("never throws when either store's removeItem rejects/throws", () => {
    idbRemoveItemShouldThrow = true;
    expect(() => removePersistedKeyEverywhere("rk2")).not.toThrow();
  });
});
