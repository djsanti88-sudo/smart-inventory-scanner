import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable in-memory AsyncBacking double for idbBacking's createIdbBacking(). Each test can
// mutate `idbStore` directly (via the exported map) and toggle `idbAvailable` to simulate the
// SSR/jsdom-absent-indexedDB case (createIdbBacking returning null).
const idbStore = new Map<string, string>();
let idbAvailable = true;
let idbSetItemShouldThrow = false;
let idbRemoveItemShouldThrow = false;
/** P6: runs while an adopt copy is "in flight", so a test can simulate a concurrent scan appending
 *  to the legacy key between the adopt read and the adopt delete. */
let idbSetItemHook: (() => void) | null = null;

vi.mock("@/stores/idbBacking", () => ({
  createIdbBacking: () => {
    if (!idbAvailable) return null;
    return {
      getItem: async (name: string) => idbStore.get(name) ?? null,
      getItems: async (names: string[]) => names.map((n) => idbStore.get(n) ?? null),
      setItem: async (name: string, value: string) => {
        if (idbSetItemShouldThrow) throw new Error("idb setItem failed");
        idbStore.set(name, value);
        idbSetItemHook?.();
      },
      setItems: async (entries: Array<[string, string]>) => {
        if (idbSetItemShouldThrow) throw new Error("idb setItem failed");
        for (const [name, value] of entries) idbStore.set(name, value);
        idbSetItemHook?.();
      },
      removeItem: async (name: string) => {
        if (idbRemoveItemShouldThrow) throw new Error("idb removeItem failed");
        idbStore.delete(name);
      },
    };
  },
  // scanPersistNamespace now imports the shared newest-wins reader from scanPersistStorage, which
  // imports probeIdbBacking from this module - so the mock must expose it or the import fails.
  probeIdbBacking: async () => true,
}));

import { persistStampKey, encodeLegacyStamped } from "./scanPersistStorage";
import {
  getPersistedBlob,
  hasPersistedBlobAsync,
  hasMeaningfulLegacyBlobAsync,
  migrateLegacyBlobOnce,
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
  idbSetItemHook = null;
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

// F1 (tier-3 review round 3, 2026-08-09): getPersistedBlob used to be IDB-first-then-localStorage and
// therefore NOT stamp-aware, while the persist wrapper it shares a store with had already moved to
// newest-wins. Under divergence (the wrapper's write-through puts the NEWEST blob in localStorage while
// an OLDER copy sits in IndexedDB) the adopt path read the stale IDB blob: the adopt copy wrote the
// stale data to the per-uid key and then deleted the newer localStorage blob (silent loss of the newest
// pre-account scans), and the inverse (a stale empty sign-out wipe blob in IDB) suppressed the banner
// entirely. Both directions are now decided by the SAME comparison the wrapper uses
// (readNewestPersistedRaw in scanPersistStorage.ts).
describe("F1: getPersistedBlob is stamp-aware (newest-wins, one shared comparison)", () => {
  it("returns the NEWER-stamped localStorage blob when IndexedDB holds an older stamped blob", async () => {
    idbStore.set("k", "old-idb");
    idbStore.set(persistStampKey("k"), "1000");
    window.localStorage.setItem("k", "new-ls");
    window.localStorage.setItem(persistStampKey("k"), "2000");
    await expect(getPersistedBlob("k")).resolves.toBe("new-ls");
  });

  it("returns the NEWER-stamped IndexedDB blob when localStorage holds an older stamped blob", async () => {
    idbStore.set("k", "new-idb");
    idbStore.set(persistStampKey("k"), "2000");
    window.localStorage.setItem("k", "old-ls");
    window.localStorage.setItem(persistStampKey("k"), "1000");
    await expect(getPersistedBlob("k")).resolves.toBe("new-idb");
  });

  it("the adopt banner decision follows the NEWER blob: a stale empty IDB wipe blob no longer suppresses it", async () => {
    // Sign-out's wipe write left an effectively-empty blob in IndexedDB; the real pre-account scans
    // were written through to localStorage later (newer stamp).
    idbStore.set(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [], finalCounts: [], needsReviewQueue: [] }, version: 8 }),
    );
    idbStore.set(persistStampKey(LEGACY_PERSIST_KEY), "1000");
    window.localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [{ id: "e1" }], finalCounts: [], needsReviewQueue: [] }, version: 8 }),
    );
    window.localStorage.setItem(persistStampKey(LEGACY_PERSIST_KEY), "2000");

    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(true);
  });

  it("the adopt banner decision follows the NEWER blob in the inverse direction too (newer empty IDB wipe wins)", async () => {
    idbStore.set(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [], finalCounts: [], needsReviewQueue: [] }, version: 8 }),
    );
    idbStore.set(persistStampKey(LEGACY_PERSIST_KEY), "2000");
    window.localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [{ id: "stale" }] }, version: 8 }),
    );
    window.localStorage.setItem(persistStampKey(LEGACY_PERSIST_KEY), "1000");

    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(false);
  });

  it("the adopt COPY takes the newer localStorage blob, never the stale IndexedDB one", async () => {
    idbStore.set(LEGACY_PERSIST_KEY, JSON.stringify({ state: { scanFeed: [{ id: "STALE" }] }, version: 7 }));
    idbStore.set(persistStampKey(LEGACY_PERSIST_KEY), "1000");
    window.localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [{ id: "STALE" }, { id: "NEWEST", quantityDelta: 0 }] }, version: 7 }),
    );
    window.localStorage.setItem(persistStampKey(LEGACY_PERSIST_KEY), "2000");

    await migrateLegacyBlobOnceAsync("uid-newest");

    const copied = JSON.parse(idbStore.get(persistKeyForUid("uid-newest"))!);
    expect(copied.state.scanFeed.map((r: { id: string }) => r.id)).toEqual(["STALE", "NEWEST"]);
    expect(copied.state.scanFeed[1].quantityDelta).toBe(1); // still normalized on the copy
  });

  it("the adopt COPY takes the newer IndexedDB blob in the inverse direction", async () => {
    idbStore.set(
      LEGACY_PERSIST_KEY,
      JSON.stringify({ state: { scanFeed: [{ id: "A" }, { id: "NEWEST" }] }, version: 7 }),
    );
    idbStore.set(persistStampKey(LEGACY_PERSIST_KEY), "2000");
    window.localStorage.setItem(LEGACY_PERSIST_KEY, JSON.stringify({ state: { scanFeed: [{ id: "A" }] }, version: 7 }));
    window.localStorage.setItem(persistStampKey(LEGACY_PERSIST_KEY), "1000");

    await migrateLegacyBlobOnceAsync("uid-inverse");

    const copied = JSON.parse(idbStore.get(persistKeyForUid("uid-inverse"))!);
    expect(copied.state.scanFeed.map((r: { id: string }) => r.id)).toEqual(["A", "NEWEST"]);
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

  // Task 4a: createIdbBacking() returns null on SSR/jsdom-absent-indexedDB/lockdown browsers - the
  // mock's idbAvailable flag simulates exactly that. Nothing in this test suite previously drove that
  // branch, so the localStorage-only fallback path (idb() -> null -> ls() writes) was untested.
  it("falls back to localStorage end-to-end when IndexedDB is unavailable (migrate + adopt still work)", async () => {
    idbAvailable = false;
    const legacy = { state: { scanFeed: [{ id: "e1", quantityDelta: 0 }] }, version: 7 };
    window.localStorage.setItem(LEGACY_PERSIST_KEY, JSON.stringify(legacy));

    // hasMeaningfulLegacyBlobAsync must see the blob via the localStorage fallback (getPersistedBlob
    // falls through to localStorage when idb() is null).
    await expect(hasMeaningfulLegacyBlobAsync()).resolves.toBe(true);

    await migrateLegacyBlobOnceAsync("lsuser");

    const targetKey = persistKeyForUid("lsuser");
    const copiedRaw = window.localStorage.getItem(targetKey);
    expect(copiedRaw).toBeTruthy();
    const copied = JSON.parse(copiedRaw!);
    expect(copied.state.scanFeed[0].quantityDelta).toBe(1); // normalized 0 -> 1, same as the IDB path
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull(); // consumed
    expect(idbStore.size).toBe(0); // IndexedDB was never touched - it is unavailable
  });

  // Task 4b: idbSetItemShouldThrow was declared in the mock but nothing exercised it. The documented
  // contract ("throws propagate: never remove the anon blob on a failed copy") was therefore
  // unproven - a silently-swallowed failed copy there would delete the ONLY copy of the user's
  // pre-adoption data without ever landing the copy anywhere durable.
  //
  // P8 (2026-08-09) narrowed WHEN that contract applies: a failing IndexedDB now falls back to
  // localStorage first, and only a failure of BOTH stores propagates. So this case is split in two:
  // the fallback succeeding (below, under P8) and the both-fail case here.
  it("propagates the copy failure and keeps the legacy blob when BOTH stores fail", async () => {
    const legacy = { state: { scanFeed: [{ id: "e1", quantityDelta: 2 }] }, version: 7 };
    window.localStorage.setItem(LEGACY_PERSIST_KEY, JSON.stringify(legacy));
    idbSetItemShouldThrow = true;
    const lsSetItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => { throw new Error("localStorage quota exceeded"); });

    await expect(migrateLegacyBlobOnceAsync("failuser")).rejects.toThrow("idb setItem failed");

    lsSetItem.mockRestore();
    // The legacy blob must survive the failed copy - removePersistedKeyEverywhere is only reached
    // AFTER the copy landed somewhere, so a failure of both stores short-circuits before it runs.
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeTruthy();
    expect(idbStore.get(LEGACY_PERSIST_KEY)).toBeUndefined(); // never written to IDB to begin with
    // No partial/corrupt copy was left behind at the target key either.
    const targetKey = persistKeyForUid("failuser");
    expect(idbStore.get(targetKey)).toBeUndefined();
    expect(window.localStorage.getItem(targetKey)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Tier-3 external review (clean-room, 2026-08-09).
// ---------------------------------------------------------------------------------------------

// P8: the persist wrapper probes IndexedDB and DEMOTES to localStorage when it is present-but-broken
// (Chrome block-site-data, enterprise policy, Safari lockdown). Scans then persist fine - in
// localStorage. But the adopt path selected the async/IDB route purely on `typeof indexedDB` and then
// used IDB exclusively, so Adopt threw and failed FOREVER for exactly those users, on data that was
// sitting in localStorage the whole time.
describe("P8: adoption survives a present-but-BROKEN IndexedDB (demotion-aware)", () => {
  it("falls back to localStorage when every IDB op throws, and still consumes the legacy blob", async () => {
    idbSetItemShouldThrow = true;
    idbRemoveItemShouldThrow = true;
    const legacy = { state: { scanFeed: [{ id: "e1", quantityDelta: 0 }] }, version: 7 };
    window.localStorage.setItem(LEGACY_PERSIST_KEY, JSON.stringify(legacy));

    await expect(migrateLegacyBlobOnceAsync("blockeduser")).resolves.toBeUndefined();

    const targetKey = persistKeyForUid("blockeduser");
    const copiedRaw = window.localStorage.getItem(targetKey);
    expect(copiedRaw).toBeTruthy();
    expect(JSON.parse(copiedRaw!).state.scanFeed[0].quantityDelta).toBe(1); // normalized as usual
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull(); // consumed after the copy
  });

  it("adopts an ENVELOPED legacy blob (what the demoted wrapper actually writes) as its decoded raw", async () => {
    idbSetItemShouldThrow = true;
    const raw = JSON.stringify({ state: { scanFeed: [{ id: "enveloped", quantityDelta: 0 }] }, version: 7 });
    window.localStorage.setItem(LEGACY_PERSIST_KEY, encodeLegacyStamped(raw, 9999));

    await migrateLegacyBlobOnceAsync("envuser");

    const copiedRaw = window.localStorage.getItem(persistKeyForUid("envuser"))!;
    expect(copiedRaw.startsWith("sisv1:")).toBe(false); // stored as the blob, not the envelope
    expect(JSON.parse(copiedRaw).state.scanFeed[0].quantityDelta).toBe(1);
  });

  it("the sync localStorage migration also decodes an envelope (the demoted-browser path)", () => {
    const raw = JSON.stringify({ state: { scanFeed: [{ id: "sync-env", quantityDelta: 0 }] }, version: 7 });
    window.localStorage.setItem(LEGACY_PERSIST_KEY, encodeLegacyStamped(raw, 4321));

    migrateLegacyBlobOnce("syncuser", window.localStorage);

    const copiedRaw = window.localStorage.getItem(persistKeyForUid("syncuser"))!;
    expect(JSON.parse(copiedRaw).state.scanFeed[0].quantityDelta).toBe(1);
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull();
    expect(window.localStorage.getItem(persistStampKey(LEGACY_PERSIST_KEY))).toBeNull();
  });
});

// P6: adoption did existence-check / read / write / delete as four separate steps with no recheck of
// the source. A scan appended to the legacy key BETWEEN the read and the delete was silently
// destroyed - the delete removed a blob strictly newer than the one that was copied.
describe("P6: the adopt source is re-checked before it is deleted", () => {
  function feedBlob(ids: string[]) {
    return JSON.stringify({ state: { scanFeed: ids.map((id) => ({ id })) }, version: 7 });
  }

  it("a scan appended DURING the copy is re-copied instead of being deleted", async () => {
    window.localStorage.setItem(LEGACY_PERSIST_KEY, feedBlob(["s1"]));

    // The concurrent scan lands exactly once, while the first copy's write is in flight.
    let appended = false;
    idbSetItemHook = () => {
      if (appended) return;
      appended = true;
      window.localStorage.setItem(LEGACY_PERSIST_KEY, feedBlob(["s1", "s2-DURING-ADOPT"]));
    };

    await migrateLegacyBlobOnceAsync("raceuser");

    const copied = JSON.parse(idbStore.get(persistKeyForUid("raceuser"))!);
    expect(copied.state.scanFeed.map((r: { id: string }) => r.id)).toEqual(["s1", "s2-DURING-ADOPT"]);
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull(); // consumed, nothing lost
  });

  it("an unchanged source is deleted without any extra copy (no retry tax on the normal path)", async () => {
    window.localStorage.setItem(LEGACY_PERSIST_KEY, feedBlob(["only"]));
    let copies = 0;
    idbSetItemHook = () => { copies += 1; };

    await migrateLegacyBlobOnceAsync("calmuser");

    expect(copies).toBe(1);
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull();
  });

  it("a source that keeps advancing is bounded, and the LAST observed content is what gets adopted", async () => {
    window.localStorage.setItem(LEGACY_PERSIST_KEY, feedBlob(["s1"]));
    let n = 1;
    idbSetItemHook = () => {
      n += 1;
      window.localStorage.setItem(LEGACY_PERSIST_KEY, feedBlob(Array.from({ length: n }, (_, i) => `s${i + 1}`)));
    };

    await migrateLegacyBlobOnceAsync("busyuser"); // must terminate, never spin

    const copied = JSON.parse(idbStore.get(persistKeyForUid("busyuser"))!);
    expect(copied.state.scanFeed.length).toBeGreaterThan(1); // later content, not the first snapshot
    expect(window.localStorage.getItem(LEGACY_PERSIST_KEY)).toBeNull();
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

  // F6 (hygiene): the sibling write stamp is part of the key's persisted footprint. Removing only the
  // blob left an orphan `<key>::stamp` behind, which then decided ordering for a blob that no longer
  // exists (and leaked one more per-uid trace of a signed-out user on a shared device).
  it("removes the sibling write stamp too, from both stores", async () => {
    idbStore.set("rk3", "v");
    idbStore.set(persistStampKey("rk3"), "1234");
    window.localStorage.setItem("rk3", "v");
    window.localStorage.setItem(persistStampKey("rk3"), "1234");

    removePersistedKeyEverywhere("rk3");

    expect(window.localStorage.getItem("rk3")).toBeNull();
    expect(window.localStorage.getItem(persistStampKey("rk3"))).toBeNull();
    await Promise.resolve();
    expect(idbStore.get("rk3")).toBeUndefined();
    expect(idbStore.get(persistStampKey("rk3"))).toBeUndefined();
  });

  it("never throws when either store's removeItem rejects/throws", () => {
    idbRemoveItemShouldThrow = true;
    expect(() => removePersistedKeyEverywhere("rk2")).not.toThrow();
  });
});
