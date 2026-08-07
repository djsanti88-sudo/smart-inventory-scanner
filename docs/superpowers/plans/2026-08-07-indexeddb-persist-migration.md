# IndexedDB Persist Migration (#27) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the scan store's persisted state from localStorage (~5MB quota, dies ~500 scans on real backend) to IndexedDB (effectively unbounded), with a safe one-time migration and a localStorage fallback when IndexedDB is unavailable.

**Architecture:** Keep the existing coalesce/fail-soft/flush-on-hide contract in `scanPersistStorage.ts` and swap only the *backing* store. A new minimal promise-based KV module wraps raw IndexedDB (NO new npm dependency). A new async `PersistStorage<S>` factory composes: coalesced stringify -> async IDB write, fail-soft on every error, migration-on-read from the legacy localStorage key. zustand persist natively supports async storage (`getItem` may return a Promise) and the store already uses `skipHydration: true` + explicit `rehydrate()`, so the async read path slots into the existing flow.

**Tech Stack:** TypeScript, zustand 5 persist middleware, raw `indexedDB` browser API, Vitest (dom project, in-memory fake backing - jsdom has no IndexedDB), Playwright mock E2E (port 3100) for real-browser proof.

## Global Constraints

- TOP-LEVEL LAW: a persist failure must NEVER throw out of `processScan` or roll back an optimistic scan. Every backing error is fail-soft (warn + drop), mirroring the existing wrapper.
- NO new npm dependencies (raw IndexedDB only; tests use an injected in-memory fake, not `fake-indexeddb`).
- Barcodes/values are strings always; never touch value contents.
- The uid-namespaced key scheme (`persistKeyForUid`, `sis-scan-<uid>` / legacy `sis-scan-v1`) is unchanged - IDB stores the same keys.
- `npm run test:ledger` must stay green (counting untouched, but run it - persistence feeds replay).
- No em/en dash in any user-facing copy added.
- Do not deploy or push; local work only until owner review.

## File Structure

- Create: `src/stores/idbBacking.ts` - minimal async KV over raw IndexedDB (db `sis-persist`, object store `kv`). One responsibility: promise get/set/remove of string values, null when `indexedDB` is absent.
- Create: `src/stores/idbBacking.test.ts` - contract tests via injected fake `IDBFactory`-shaped stub? No - jsdom has no IDB; instead this module is thin enough that its logic (open-once, upgrade, error wrapping) is covered by the E2E; unit tests target the composition layer below with an in-memory `AsyncBacking` fake.
- Modify: `src/stores/scanPersistStorage.ts` - add `AsyncBacking` type + `createAsyncCoalescedFailSoftPersistStorage<S>(getAsyncBacking, opts)` with localStorage migration hook. Existing sync functions untouched (fallback path keeps using them).
- Modify: `src/stores/scanStore.ts:8225` - `storage:` picks IDB-backed storage when available, else the current localStorage storage.
- Modify: `src/stores/scanStore.ts:2259-2266` (sign-out wipe) - also remove the uid key from IDB.
- Modify: `src/stores/scanPersistNamespace.ts` - export a `removePersistedKeyEverywhere(key)` helper used by the wipe and by "Clear local cache".
- Test: `src/stores/scanPersistStorage.async.test.ts` (dom project) - coalescing, fail-soft, migration, remove-cancels-pending.
- Test: `e2e/persist-indexeddb.spec.ts` - real Chromium proof: scans survive reload via IDB; legacy localStorage blob migrates then clears.

---

### Task 1: Minimal IndexedDB backing (`idbBacking.ts`)

**Files:**
- Create: `src/stores/idbBacking.ts`

**Interfaces:**
- Produces: `type AsyncBacking = { getItem(name: string): Promise<string | null>; setItem(name: string, value: string): Promise<void>; removeItem(name: string): Promise<void>; }` and `createIdbBacking(): AsyncBacking | null` (null when `indexedDB` undefined, e.g. SSR/jsdom).

- [ ] **Step 1: Write the module** (no unit test here - jsdom lacks IndexedDB; the composition tests in Task 2 use a fake AsyncBacking and the E2E in Task 5 proves this module in a real browser)

```typescript
// src/stores/idbBacking.ts
// #27 IndexedDB migration: minimal promise KV over raw IndexedDB. No dependency on purpose
// (owner gate on new deps; the API surface we need is tiny). One DB, one object store, string
// values keyed by the same persist names localStorage used (sis-scan-v1 / sis-scan-<uid>).
// Every method rejects on IDB errors; callers (the fail-soft persist wrapper) catch and drop.

export type AsyncBacking = {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
};

const DB_NAME = "sis-persist";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If the connection dies (eviction, devtools clear), drop the cache so the next call reopens.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error ?? new Error("indexedDB open failed")); };
    req.onblocked = () => { /* another tab holds an old version; onsuccess still fires later */ };
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let req: IDBRequest<T>;
        try {
          const t = db.transaction(STORE, mode);
          req = run(t.objectStore(STORE));
        } catch (err) {
          dbPromise = null; // connection may be stale; reopen next time
          reject(err);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
      }),
  );
}

/** null when IndexedDB is unavailable (SSR, jsdom, lockdown browsers) - caller falls back to localStorage. */
export function createIdbBacking(): AsyncBacking | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    getItem: (name) =>
      tx<unknown>("readonly", (s) => s.get(name) as IDBRequest<unknown>).then((v) =>
        typeof v === "string" ? v : null,
      ),
    setItem: (name, value) => tx("readwrite", (s) => s.put(value, name)).then(() => undefined),
    removeItem: (name) => tx("readwrite", (s) => s.delete(name)).then(() => undefined),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/idbBacking.ts
git commit -m "feat(#27): minimal promise KV over raw IndexedDB for scan persist backing"
```

---

### Task 2: Async coalesced fail-soft persist storage with migration

**Files:**
- Modify: `src/stores/scanPersistStorage.ts` (append; existing exports untouched)
- Test: `src/stores/scanPersistStorage.async.test.ts`

**Interfaces:**
- Consumes: `AsyncBacking` from Task 1 (`import type { AsyncBacking } from "@/stores/idbBacking"`).
- Produces: `createAsyncCoalescedFailSoftPersistStorage<S>(getAsyncBacking: () => AsyncBacking, opts?: { migrateFrom?: Pick<Storage, "getItem" | "removeItem"> }): CoalescedFailSoftPersistStorage<S>` - same `PersistStorage<S> & { flush(): void }` shape scanStore already uses, so `scanStore.ts:8225` swaps factories with no other change.

Behavior contract (each bullet is a test):
1. `setItem` coalesces N calls per tick to ONE stringify + ONE backing write (same as sync version).
2. Backing write rejection is swallowed with a `console.warn` (fail-soft; never throws).
3. `getItem` returns the parsed IDB value when present.
4. MIGRATION: `getItem` miss + `opts.migrateFrom.getItem(name)` hit -> returns the parsed legacy value AND schedules a copy into the async backing; the legacy key is removed ONLY after that copy resolves (never on failure - the localStorage copy is the safety net until IDB provably holds the data).
5. `removeItem` cancels a pending coalesced write for that key and removes from BOTH the async backing and `migrateFrom`.
6. `flush()` fires the pending write immediately (returns void; the IDB put is started synchronously so pagehide flushes are best-effort-started, which is the strongest guarantee IndexedDB offers).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/stores/scanPersistStorage.async.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAsyncCoalescedFailSoftPersistStorage } from "./scanPersistStorage";
import type { AsyncBacking } from "./idbBacking";

function makeFakeBacking(overrides: Partial<AsyncBacking> = {}) {
  const data = new Map<string, string>();
  const backing: AsyncBacking = {
    getItem: vi.fn(async (n: string) => data.get(n) ?? null),
    setItem: vi.fn(async (n: string, v: string) => { data.set(n, v); }),
    removeItem: vi.fn(async (n: string) => { data.delete(n); }),
    ...overrides,
  };
  return { backing, data };
}

const VALUE = { state: { scanFeed: [{ id: "s1" }] }, version: 7 };

describe("createAsyncCoalescedFailSoftPersistStorage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of setItem calls into one backing write", async () => {
    const { backing } = makeFakeBacking();
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    for (let i = 0; i < 6; i++) storage.setItem("sis-scan-v1", { ...VALUE, version: i });
    await vi.runAllTimersAsync();
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse((backing.setItem as ReturnType<typeof vi.fn>).mock.calls[0][1]).version).toBe(5);
  });

  it("swallows backing write rejection (fail-soft, warns, never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("quota"); }) });
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    storage.setItem("sis-scan-v1", VALUE);
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("getItem returns parsed value from the async backing", async () => {
    const { backing, data } = makeFakeBacking();
    data.set("sis-scan-v1", JSON.stringify(VALUE));
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
  });

  it("migrates from legacy storage on IDB miss and clears legacy only after copy succeeds", async () => {
    const { backing, data } = makeFakeBacking();
    const legacy = {
      getItem: vi.fn(() => JSON.stringify(VALUE)),
      removeItem: vi.fn(),
    };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
    await vi.runAllTimersAsync();
    expect(data.get("sis-scan-v1")).toBe(JSON.stringify(VALUE)); // copied into IDB
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-v1"); // cleared AFTER copy
  });

  it("does NOT clear legacy storage when the migration copy fails", async () => {
    const legacy = { getItem: vi.fn(() => JSON.stringify(VALUE)), removeItem: vi.fn() };
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await storage.getItem("sis-scan-v1");
    await vi.runAllTimersAsync();
    expect(legacy.removeItem).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("removeItem cancels the pending write and removes from backing AND legacy", async () => {
    const { backing } = makeFakeBacking();
    const legacy = { getItem: vi.fn(() => null), removeItem: vi.fn() };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    storage.setItem("sis-scan-u1", VALUE);
    storage.removeItem("sis-scan-u1");
    await vi.runAllTimersAsync();
    expect(backing.setItem).not.toHaveBeenCalled(); // pending write cancelled
    expect(backing.removeItem).toHaveBeenCalledWith("sis-scan-u1");
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-u1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/stores/scanPersistStorage.async.test.ts`
Expected: FAIL - `createAsyncCoalescedFailSoftPersistStorage` is not exported.

- [ ] **Step 3: Implement** (append to `src/stores/scanPersistStorage.ts`)

```typescript
import type { AsyncBacking } from "@/stores/idbBacking";

/**
 * #27: same coalesce/fail-soft/flush-on-hide contract as createCoalescedFailSoftPersistStorage,
 * backed by an ASYNC store (IndexedDB). Differences, all deliberate:
 *  - getItem is async (zustand persist supports Promise-returning storage; the store already runs
 *    skipHydration + explicit rehydrate(), so the async read slots into the existing flow).
 *  - MIGRATION: on an IDB miss, opts.migrateFrom (localStorage) is consulted; a hit is returned to
 *    the caller immediately and copied into IDB in the background; the legacy key is removed ONLY
 *    after that copy resolves, so the data always exists in at least one store.
 *  - flush() STARTS the pending IDB put synchronously. On pagehide that is best-effort (the browser
 *    usually completes an already-started transaction); the localStorage version could write fully
 *    synchronously - this is the one contract weakening of the migration, bounded to one tick of data.
 */
export function createAsyncCoalescedFailSoftPersistStorage<S>(
  getAsyncBacking: () => AsyncBacking,
  opts: { migrateFrom?: Pick<Storage, "getItem" | "removeItem"> } = {},
): CoalescedFailSoftPersistStorage<S> {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let hasPending = false;
  let scheduled = false;

  const warnDrop = (name: string, step: string, err: unknown) =>
    console.warn(
      `[scanStore] Could not ${step} '${name}' (IndexedDB unavailable or failed); this write was dropped. ` +
        `Scanning continues in memory. (#27 fail-soft)`,
      err,
    );

  const doWrite = (name: string, value: StorageValue<S>): Promise<void> => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (err) {
      warnDrop(name, "serialize", err);
      return Promise.resolve();
    }
    return getAsyncBacking()
      .setItem(name, serialized)
      .catch((err) => warnDrop(name, "persist", err));
  };

  const flush = () => {
    scheduled = false;
    if (!hasPending || pendingName === null || pendingValue === null) return;
    const name = pendingName;
    const value = pendingValue;
    hasPending = false;
    pendingName = null;
    pendingValue = null;
    void doWrite(name, value);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof setTimeout === "function") setTimeout(flush, 0);
    else flush();
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flush);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
  }

  const readLegacy = (name: string): string | null => {
    if (!opts.migrateFrom) return null;
    try {
      return opts.migrateFrom.getItem(name);
    } catch {
      return null;
    }
  };

  return {
    getItem: async (name: string) => {
      let raw: string | null = null;
      try {
        raw = await getAsyncBacking().getItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not read '${name}' from IndexedDB.`, err);
      }
      if (raw === null) {
        const legacyRaw = readLegacy(name);
        if (legacyRaw !== null) {
          // Copy-then-clear: legacy is removed only after IDB provably holds the value.
          getAsyncBacking()
            .setItem(name, legacyRaw)
            .then(() => {
              try {
                opts.migrateFrom?.removeItem(name);
              } catch {
                /* legacy removal is best-effort; a stale copy is harmless (IDB wins on next read) */
              }
            })
            .catch((err) => warnDrop(name, "migrate", err));
          raw = legacyRaw;
        }
      }
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch (err) {
        console.warn(`[scanStore] Could not parse persisted '${name}'; treating as absent.`, err);
        return null;
      }
    },
    removeItem: (name: string) => {
      if (pendingName === name) {
        hasPending = false;
        pendingName = null;
        pendingValue = null;
      }
      getAsyncBacking()
        .removeItem(name)
        .catch((err) => console.warn(`[scanStore] Could not remove '${name}' from IndexedDB.`, err));
      try {
        opts.migrateFrom?.removeItem(name);
      } catch {
        /* fail-soft */
      }
    },
    setItem: (name: string, value: StorageValue<S>) => {
      pendingName = name;
      pendingValue = value;
      hasPending = true;
      schedule();
    },
    flush,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/stores/scanPersistStorage.async.test.ts` then `npx vitest run src/stores/scanPersistStorage.test.ts` (existing suite must stay green)
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanPersistStorage.ts src/stores/scanPersistStorage.async.test.ts
git commit -m "feat(#27): async coalesced fail-soft persist storage with copy-then-clear localStorage migration"
```

---

### Task 3: Wire scanStore to IndexedDB with localStorage fallback

**Files:**
- Modify: `src/stores/scanStore.ts:8225` (the `storage:` option)

**Interfaces:**
- Consumes: `createIdbBacking` (Task 1), `createAsyncCoalescedFailSoftPersistStorage` (Task 2), existing `createCoalescedFailSoftPersistStorage`.
- Produces: no new exports; behavioral change only.

- [ ] **Step 1: Replace the storage wiring**

At `scanStore.ts:8225`, replace:

```typescript
    storage: createCoalescedFailSoftPersistStorage(() => localStorage),
```

with:

```typescript
    // #27: IndexedDB is the primary persist backing (localStorage's ~5MB quota bricked large real-
    // backend sessions ~500 scans in). Feature-detected once at store creation: no indexedDB (SSR,
    // jsdom, lockdown) -> the previous localStorage path, byte-for-byte identical behavior. When IDB
    // is active, migrateFrom copies a legacy localStorage blob forward on first read (copy-then-clear).
    storage: (() => {
      const idb = typeof indexedDB !== "undefined" ? createIdbBacking() : null;
      return idb
        ? createAsyncCoalescedFailSoftPersistStorage(() => idb, {
            migrateFrom: typeof localStorage !== "undefined" ? localStorage : undefined,
          })
        : createCoalescedFailSoftPersistStorage(() => localStorage);
    })(),
```

Add the imports next to the existing `createCoalescedFailSoftPersistStorage` import (`scanStore.ts:90`):

```typescript
import { createCoalescedFailSoftPersistStorage, createAsyncCoalescedFailSoftPersistStorage } from "@/stores/scanPersistStorage";
import { createIdbBacking } from "@/stores/idbBacking";
```

- [ ] **Step 2: Verify the full dom test suite still passes** (jsdom has no indexedDB, so every existing store test exercises the unchanged fallback path - that is itself the fallback regression test)

Run: `npm run test`
Expected: PASS (note: `cloudDrainRace.store.test.ts` is known timing-flaky under full parallel load only; rerun isolated if it trips).

- [ ] **Step 3: Run the ledger gate**

Run: `npm run test:ledger`
Expected: PASS 45/45.

- [ ] **Step 4: Commit**

```bash
git add src/stores/scanStore.ts
git commit -m "feat(#27): scanStore persists to IndexedDB with localStorage fallback + forward migration"
```

---

### Task 4: Port the ENTIRE namespace/adopt subsystem to IDB (review finding C1 - this is the critical task)

**Why this task exists (Opus review C1/I1/I2):** the per-uid keying is not done by the storage backing; it is done by re-pointing the persist `name` + `rehydrate()` (`scanStore.ts:2228,2279,2283`), and FOUR localStorage-coupled functions sit around it. Swapping the backing without porting them breaks the sign-in adopt flow:
- `BusinessContextGate.tsx:64` `hasLegacyBlob(window.localStorage)` - after Task 2's copy-then-clear removes `sis-scan-v1` from localStorage, this returns false forever and a user who scanned anonymously is NEVER offered the adopt banner (their scans orphan in IDB).
- `BusinessContextGate.tsx:65` `alreadyOwn` reads `localStorage.getItem(persistKeyForUid(uid))` - per-uid data now lives in IDB, so this reads false even when the user owns data, mis-driving the adopt/skip branch.
- `scanStore.adoptLegacyLocalData` -> `migrateLegacyBlobOnce(uid, window.localStorage)` (`scanStore.ts:2293`, impl in `scanPersistNamespace.ts`) - reads/writes/deletes localStorage only; its idempotency guard (`if (storage.getItem(targetKey)) return;` at `scanPersistNamespace.ts:49`) checks the WRONG store once data is in IDB.
- `clearLocalCache` (`scanStore.ts:7576`) hardcodes `removeItem("sis-scan-v1")` only - it would leave a signed-in user's per-uid IDB blob intact, a worse data remnant than today.

**Design decision:** introduce ONE async read/remove seam - `persistBlobStore` - that checks IDB first, then localStorage, and make all four call sites go through it. The gate's `hasLegacyBlob`/`alreadyOwn` checks become async (the gate already awaits `rehydrate()`, so an awaited check fits its existing flow).

**Files:**
- Modify: `src/stores/scanPersistNamespace.ts` (add `persistBlobStore` helpers + async `migrateLegacyBlobOnceAsync`; keep the sync legacy functions exported for the no-IDB fallback path)
- Modify: `src/components/BusinessContextGate.tsx:64-71` (await the async checks)
- Modify: `src/stores/scanStore.ts:2262` (sign-out wipe), `scanStore.ts:2293` (adopt call), `scanStore.ts:7576` (clearLocalCache - clear BOTH `sis-scan-v1` AND the current per-uid key, in both stores)
- Test: `src/stores/scanPersistNamespace.async.test.ts` (fake AsyncBacking; covers: hasBlob true when only IDB has it / true when only localStorage has it; adopt copies anon blob to per-uid slot in IDB and clears both anon copies; idempotency guard checks IDB, not localStorage; removeEverywhere clears both stores)

**Interfaces:**
- Produces (in `scanPersistNamespace.ts`):
  - `getPersistedBlob(key: string): Promise<string | null>` - IDB first, localStorage second, fail-soft null.
  - `hasPersistedBlobAsync(key: string): Promise<boolean>`
  - `migrateLegacyBlobOnceAsync(uid: string): Promise<void>` - reads anon blob via `getPersistedBlob("sis-scan-v1")`, idempotency-guards on `getPersistedBlob(persistKeyForUid(uid))`, writes the per-uid blob to IDB (localStorage fallback when IDB absent), then removes the anon blob from BOTH stores.
  - `removePersistedKeyEverywhere(key: string): void` - removes `key` from localStorage AND IndexedDB (fire-and-forget, fail-soft).
- Consumes: `createIdbBacking` (Task 1). All helpers no-op the IDB half when `createIdbBacking()` returns null, so the localStorage-fallback build keeps today's exact behavior.

- [ ] **Step 1: Find every bypass call site (verify the four known ones, catch strays)**

Run: `npx rg -n "hasLegacyBlob|migrateLegacyBlobOnce|localStorage.removeItem\(persistKeyForUid|removeItem\(.?['\"]sis-scan|getItem\(persistKeyForUid" src/`
Expected known hits: `BusinessContextGate.tsx:64,65`, `scanStore.ts:2262,2293,7576`, `scanPersistNamespace.ts` internals. Every OTHER hit found must be triaged into this task before proceeding.

- [ ] **Step 2: Write the failing tests** (`src/stores/scanPersistNamespace.async.test.ts`; inject a fake AsyncBacking via a test-only setter or module mock of `@/stores/idbBacking` - match the repo's existing `vi.mock` style)

Test list (each is a `it(...)`):
1. `getPersistedBlob` returns the IDB value when both stores hold the key (IDB wins).
2. `getPersistedBlob` falls back to localStorage when IDB misses.
3. `hasPersistedBlobAsync` true when ONLY IDB has it; true when ONLY localStorage has it; false when neither.
4. `migrateLegacyBlobOnceAsync(uid)` copies the anon blob into the per-uid IDB slot and removes the anon blob from BOTH stores.
5. `migrateLegacyBlobOnceAsync(uid)` is a no-op when the per-uid slot already exists IN IDB (idempotency guard reads the right store).
6. `removePersistedKeyEverywhere` removes from both stores and never throws when either store errors.

- [ ] **Step 3: Implement the helpers** (in `scanPersistNamespace.ts`)

```typescript
import { createIdbBacking, type AsyncBacking } from "@/stores/idbBacking";

function idb(): AsyncBacking | null {
  try {
    return typeof indexedDB !== "undefined" ? createIdbBacking() : null;
  } catch {
    return null;
  }
}

function ls(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** #27: a persisted blob may live in IndexedDB (primary) or localStorage (legacy/fallback).
 *  Single read seam - IDB first, localStorage second, fail-soft null. */
export async function getPersistedBlob(key: string): Promise<string | null> {
  const backing = idb();
  if (backing) {
    try {
      const v = await backing.getItem(key);
      if (v !== null) return v;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export async function hasPersistedBlobAsync(key: string): Promise<boolean> {
  return (await getPersistedBlob(key)) !== null;
}

/** Async, IDB-aware successor to migrateLegacyBlobOnce: adopt the anonymous blob into the
 *  signed-in user's slot. Idempotency guard reads through getPersistedBlob (IDB-aware), fixing
 *  the localStorage-only guard at the sync version's scanPersistNamespace.ts:49. */
export async function migrateLegacyBlobOnceAsync(uid: string): Promise<void> {
  const targetKey = persistKeyForUid(uid);
  if (await hasPersistedBlobAsync(targetKey)) return; // already adopted / user owns data
  const legacy = await getPersistedBlob(LEGACY_PERSIST_KEY); // "sis-scan-v1"
  if (legacy === null) return;
  const backing = idb();
  if (backing) {
    await backing.setItem(targetKey, legacy); // throws -> caller's fail-soft; anon copies kept
  } else {
    ls()?.setItem(targetKey, legacy);
  }
  removePersistedKeyEverywhere(LEGACY_PERSIST_KEY); // only after the copy landed
}

/** Every explicit wipe (sign-out, Clear local cache, adopt cleanup) must clear BOTH stores or a
 *  signed-out user's session data resurrects from the store the wipe missed. Fail-soft. */
export function removePersistedKeyEverywhere(key: string): void {
  try {
    ls()?.removeItem(key);
  } catch {
    /* fail-soft */
  }
  try {
    void idb()?.removeItem(key).catch(() => undefined);
  } catch {
    /* fail-soft */
  }
}
```

IMPLEMENTER NOTE: `LEGACY_PERSIST_KEY` / `persistKeyForUid` already live in this file - reuse the existing constant names verbatim (open the file first; if the legacy constant is named differently, use the real name). Keep the existing sync `migrateLegacyBlobOnce` exported - the no-IDB fallback path and its tests still use it.

- [ ] **Step 4: Port the four call sites**

1. `scanStore.ts:2262`: `if (uid) window.localStorage.removeItem(persistKeyForUid(uid));` -> `if (uid) removePersistedKeyEverywhere(persistKeyForUid(uid));`
2. `scanStore.ts:2293` (adoptLegacyLocalData): call `await migrateLegacyBlobOnceAsync(uid)` when IDB is active, else the existing sync path. The surrounding action is already async-friendly (it precedes a `rehydrate()` await) - verify by reading the enclosing function before editing.
3. `BusinessContextGate.tsx:64-65`: replace `hasLegacyBlob(window.localStorage)` with `await hasPersistedBlobAsync(LEGACY_PERSIST_KEY)` and the `alreadyOwn` localStorage read with `await hasPersistedBlobAsync(persistKeyForUid(uid))`. The gate already awaits `rehydrate()` in this flow; add these awaits in the same async sequence. Update the gate's tests to mock the new async helpers.
4. `scanStore.ts:7576` (clearLocalCache): clear BOTH the anon key AND the current per-uid key via `removePersistedKeyEverywhere` - `removePersistedKeyEverywhere("sis-scan-v1"); const uid = get().userId; if (uid) removePersistedKeyEverywhere(persistKeyForUid(uid));` (verify the store field holding the uid - read the surrounding action first).

- [ ] **Step 5: Run the failing tests from Step 2, then the store + component suites**

Run: `npx vitest run src/stores/scanPersistNamespace.async.test.ts && npx vitest run src/stores/ src/components/BusinessContextGate*`
Expected: PASS all; existing BusinessContextGate tests updated for the async checks, none deleted or weakened.

- [ ] **Step 6: Commit**

```bash
git add src/stores/scanPersistNamespace.ts src/stores/scanPersistNamespace.async.test.ts src/stores/scanStore.ts src/components/
git commit -m "fix(#27): namespace/adopt subsystem is IDB-aware - adopt banner, alreadyOwn, once-guard, clear-cache all read/wipe both stores"
```

---

### Task 5: Real-browser proof (Playwright, mock E2E)

**Files:**
- Create: `e2e/persist-indexeddb.spec.ts`

**Interfaces:**
- Consumes: mock E2E harness (`npm run test:e2e`, port 3100, `IS_E2E=1`); existing E2E patterns for scanning (see `e2e/` specs that type into the scan input and press Enter).

- [ ] **Step 1: Write the spec**

```typescript
// e2e/persist-indexeddb.spec.ts
// #27 proof: scan state persists via IndexedDB, survives reload, and a legacy localStorage blob
// migrates forward (copy-then-clear). Runs on the mock backend (port 3100).
import { test, expect } from "@playwright/test";

const KEY = "sis-scan-v1"; // anonymous/demo persist key (persistKeyForUid(null))

async function readIdb(page: import("@playwright/test").Page, key: string): Promise<string | null> {
  return page.evaluate(
    (k) =>
      new Promise<string | null>((resolve) => {
        const req = indexedDB.open("sis-persist", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => {
          const t = req.result.transaction("kv", "readonly");
          const g = t.objectStore("kv").get(k);
          g.onsuccess = () => resolve(typeof g.result === "string" ? g.result : null);
          g.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      }),
    key,
  );
}

test("scans persist to IndexedDB and survive reload; localStorage stays small", async ({ page }) => {
  await page.goto("/scan");
  const input = page.getByRole("textbox").first();
  for (const code of ["3000000000017", "3000000000024", "3000000000031"]) {
    await input.fill(code);
    await input.press("Enter");
  }
  // Let the coalesced flush land, then force a hide-flush for determinism.
  await page.waitForTimeout(300);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => readIdb(page, KEY)).not.toBeNull();
  const blob = (await readIdb(page, KEY))!;
  expect(blob).toContain("3000000000017");
  // The big state blob must NOT be in localStorage anymore.
  const lsValue = await page.evaluate((k) => localStorage.getItem(k), KEY);
  expect(lsValue).toBeNull();

  await page.reload();
  // The 3 scans came back from IDB (feed rows visible after rehydrate).
  await expect(page.getByText("3000000000017")).toBeVisible();
});

test("legacy localStorage blob migrates into IndexedDB on load (copy-then-clear)", async ({ page }) => {
  await page.goto("/scan");
  // Seed a legacy blob shaped like a persisted store BEFORE the app reads it, then reload.
  // Simplest robust seed: scan once (creates a valid blob via the app itself), copy IDB -> localStorage,
  // wipe IDB, reload; the app must migrate it back.
  const input = page.getByRole("textbox").first();
  await input.fill("3000000000048");
  await input.press("Enter");
  await page.waitForTimeout(300);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const blob = await readIdb(page, KEY);
  expect(blob).not.toBeNull();
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [KEY, blob!] as const,
  );
  await page.evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open("sis-persist", 1);
        req.onsuccess = () => {
          const t = req.result.transaction("kv", "readwrite");
          t.objectStore("kv").delete(k);
          t.oncomplete = () => resolve();
        };
        req.onerror = () => resolve();
      }),
    KEY,
  );
  await page.reload();
  await expect(page.getByText("3000000000048")).toBeVisible(); // state came from the legacy blob
  await expect.poll(() => readIdb(page, KEY)).not.toBeNull(); // copied forward into IDB
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
    .toBeNull(); // legacy cleared AFTER the copy
});
```

NOTE for implementer: the scan-input locator and demo codes above must be aligned with the existing mock E2E specs (open one, e.g. the newest spec under `e2e/`, and reuse its exact input locator + a code the mock resolver accepts). If `sis-scan-v1` is not the anonymous key in mock mode, read `persistKeyForUid(null)` from `src/stores/scanPersistNamespace.ts` and use that literal.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/persist-indexeddb.spec.ts --config playwright.config.ts`
Expected: PASS 2/2.

- [ ] **Step 3: Run the whole mock E2E gate**

Run: `npm run test:e2e`
Expected: PASS (existing specs must not regress - several assert persistence behavior).

- [ ] **Step 4: Commit**

```bash
git add e2e/persist-indexeddb.spec.ts
git commit -m "test(#27): real-browser proof - IndexedDB persistence, reload survival, legacy migration"
```

---

### Task 6: Full gates + docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (persistence paragraph), `PROGRESS.md`, `TESTING.md`

- [ ] **Step 1: Run the full battery**

Run: `npm run proof:local` (tsc + unit), then `npm run test:ledger`, then `npm run test:e2e`
Expected: all green.

- [ ] **Step 2: Update docs** - ARCHITECTURE.md persistence note (localStorage -> IndexedDB primary, localStorage fallback + one-time migration), TESTING.md new suites, PROGRESS.md checkpoint. Remove/adjust the "IndexedDB is the documented next upgrade" lines (CLAUDE.md mentions it under Optimistic State; update that line too).

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md TESTING.md PROGRESS.md CLAUDE.md
git commit -m "docs(#27): persistence is IndexedDB-primary with localStorage fallback"
```

---

## Risks / open decisions

- **Async-storage integration coverage (review I3):** jsdom has no IndexedDB, so every dom-project store test exercises the localStorage fallback; the IDB + async-rehydrate seam (BusinessContextGate awaiting `rehydrate()` against async storage) is proven only by Task 5's Playwright specs and the Task 4 unit tests of the helpers. The sign-in ADOPT flow against real IDB is NOT covered by mock E2E (no sign-in there) - it must be spot-checked manually in `dev:emulator` mode before merge, and that check is a listed acceptance item, not optional.
- **Pagehide flush weakening:** IDB cannot write synchronously during pagehide; the started-transaction guarantee is best-effort. Exposure is at most one coalesced tick (~1 scan). Accepted trade for removing the 5MB brick; called out in code comments.
- **Multi-tab:** same as today - last write wins per key. No change.
- **Private/lockdown browsers without IDB:** fall back to today's exact localStorage behavior, including its quota limits.
- **CANELO rerun (owner-gated, recommended after merge):** re-run the 4,500-scan localhost campaign to prove the ~500-scan quota wall is gone end to end.
