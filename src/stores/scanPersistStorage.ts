// QA finding #16 (critical) - CONTAINED MITIGATION for the /scan-page brick.
//
// scanStore.ts previously persisted through a plain createJSONStorage(() => localStorage). Two problems
// compounded into a hard brick as a scan session grew:
//   1. NO quota guard. Near the ~5MB localStorage quota, setItem throws QuotaExceededError SYNCHRONOUSLY
//      out of zustand's set() - and set() is called inside processScan - so the scan threw, and every
//      subsequent scan re-threw (a fresh tab stayed broken until localStorage was cleared).
//   2. WRITE AMPLIFICATION. Each processScan fires ~6 set() calls, each serializing the whole state and
//      writing it, so bytes written per scan grew linearly with session size.
//
// The wrappers here are the fix seam (pure + unit-testable, no store/Firebase imports):
//   (a) FAIL-SOFT: setItem never throws; a quota/unavailable error is logged (console.warn) and dropped,
//       mirroring reconcileStore.ts. A persist failure must NEVER propagate out of processScan and must
//       NEVER roll back the optimistic in-memory scan (TOP-LEVEL LAW).
//   (b) COALESCE: the ~6 writes per scan are collapsed to at most ONE real backing write per tick - we
//       keep only the LATEST value and schedule a single flush (cancel + reschedule on each new write).
//   (c) FLUSH ON HIDE: the pending coalesced write is flushed on pagehide and on
//       visibilitychange(hidden), so a scan-then-close never loses the last write (data loss = LAW break).
//
// Defect #37 layer 3 (fresh-device restore freeze, 2026-08-06): coalescing the BACKING setItem call is
// not enough when the wrapper is composed under zustand's `createJSONStorage`, because that helper's own
// `setItem(name, value)` calls `JSON.stringify(value)` SYNCHRONOUSLY on every single `set()` - BEFORE
// handing the string down - since zustand's persist middleware calls `storage.setItem` unconditionally
// from its overridden `api.setState` on every state change (node_modules/zustand/esm/middleware.mjs:
// `setItem = () => storage.setItem(name, {state, version})`, invoked from every `set(...)` call, not
// just ones the app intends to persist). At restore-time state size (~1,800 products + ~4,500 scanFeed
// rows + ~4,499 finalCounts, ~5MB), a handful of back-to-back set() calls in the restore chain
// (persist.rehydrate -> setHasHydrated -> setBusinessContext's synchronous branch -> its async loader's
// merge) each re-stringify the FULL state, blocking the main thread long enough (repeatedly) to starve
// the Firestore SDK's webchannel keepalive - which reconnects, re-delivers, and re-triggers a merge +
// another stringify, observed live as ~30s freeze "waves".
// Both wrappers below therefore implement zustand's `PersistStorage<S>` DIRECTLY (bypassing
// `createJSONStorage`) so `setItem` receives the RAW state object and defers `JSON.stringify` itself
// into the SAME coalesced flush as the backing write - collapsing N back-to-back set() calls in one tick
// to at most ONE stringify + ONE backing write.

import type { PersistStorage, StorageValue } from "zustand/middleware";
import { probeIdbBacking, type AsyncBacking } from "@/stores/idbBacking";

// Backing storage may or may not be present (SSR / disabled). Kept minimal on purpose.
type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SyncLegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A zustand `PersistStorage<S>` plus a synchronous force-flush so tests are deterministic and
 *  hide-events can drain the pending coalesced write. */
export interface CoalescedFailSoftPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

/**
 * Wrap a SYNCHRONOUS backing storage (localStorage) as a zustand `PersistStorage<S>` whose `setItem`
 * defers BOTH serialization and the disk write to a single coalesced flush per tick. Used when
 * IndexedDB is unavailable (SSR, jsdom, lockdown browsers) - see scanStore.ts.
 */
export function createCoalescedFailSoftPersistStorage<S>(
  getBackingStorage: () => Backing,
): CoalescedFailSoftPersistStorage<S> {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let hasPending = false;
  let scheduled = false;

  const doWrite = (name: string, value: StorageValue<S>) => {
    let serialized: string;
    try {
      // The expensive step this wrapper exists to bound: one stringify per coalesced flush, not one
      // per set() call.
      serialized = JSON.stringify(value);
    } catch (err) {
      console.warn(
        `[scanStore] Could not serialize '${name}' for persistence; this write was dropped. ` +
          `Scanning continues in memory. (finding #16 / defect #37 fail-soft)`,
        err,
      );
      return;
    }
    try {
      getBackingStorage().setItem(name, serialized);
    } catch (err) {
      // Fail soft: quota exceeded, storage disabled, or private-mode restriction. Never throw - a persist
      // failure must not brick scanning; the in-memory session keeps working. (Mirrors reconcileStore.ts.)
      console.warn(
        `[scanStore] Could not persist '${name}' (storage quota or unavailable); this write was dropped. ` +
          `Scanning continues in memory; consider clearing local cache. (finding #16 fail-soft)`,
        err,
      );
    }
  };

  const flush = () => {
    scheduled = false;
    if (!hasPending || pendingName === null || pendingValue === null) return;
    const name = pendingName;
    const value = pendingValue;
    hasPending = false;
    pendingName = null;
    pendingValue = null;
    doWrite(name, value);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // A short timer coalesces the burst of writes in one processScan tick. rAF/microtask would also
    // work; a 0ms timer is deterministic under fake timers and available everywhere (jsdom + browser).
    if (typeof setTimeout === "function") {
      setTimeout(flush, 0);
    } else {
      flush();
    }
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const flushNow = () => flush();
    window.addEventListener("pagehide", flushNow);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
  }

  return {
    getItem: (name: string) => {
      let raw: string | null;
      try {
        raw = getBackingStorage().getItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not read '${name}' from storage (unavailable).`, err);
        return null;
      }
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch (err) {
        console.warn(`[scanStore] Could not parse persisted '${name}'; treating as absent.`, err);
        return null;
      }
    },
    removeItem: (name: string) => {
      // A removal must be authoritative and immediate: drop any queued write for this key first so a
      // stale coalesced value can't resurrect it, then remove (fail-soft).
      if (pendingName === name) {
        hasPending = false;
        pendingName = null;
        pendingValue = null;
      }
      try {
        getBackingStorage().removeItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not remove '${name}' from storage (unavailable).`, err);
      }
    },
    setItem: (name: string, value: StorageValue<S>) => {
      // Coalesce: remember only the latest RAW value; stringify happens once, at flush time.
      pendingName = name;
      pendingValue = value;
      hasPending = true;
      schedule();
    },
    flush,
  };
}

/**
 * #27: same coalesce/fail-soft/flush-on-hide contract as createCoalescedFailSoftPersistStorage, but
 * backed by an ASYNC store (IndexedDB), with plain localStorage kept as a SECOND store that is both the
 * migration source and the failure fallback. Differences, all deliberate:
 *
 *  - getItem is async (zustand persist supports Promise-returning storage; the store already runs
 *    skipHydration + explicit rehydrate(), so the async read slots into the existing flow).
 *
 *  - TWO STORES, NEWEST-WINS (review round 2, defect B1). Because writes can fall back to localStorage
 *    (see below), the same persist name can exist in BOTH stores with different contents. Reading
 *    IndexedDB first and only consulting localStorage on a MISS silently shadowed - and then
 *    overwrote - newer localStorage data written by a previous failing-IndexedDB session (scans rolled
 *    back on reload). So every successful write, in EITHER store, also writes a monotonic stamp under a
 *    sibling key `${name}::stamp` (Date.now(), forced strictly increasing within an instance), and
 *    getItem reads blob + stamp from BOTH stores and returns the blob with the NEWER stamp.
 *      Tie/absence rules: a missing or unparseable stamp counts as 0, so a stamped blob always beats an
 *      unstamped one (an unstamped blob predates this scheme and is of unknown, therefore oldest, age);
 *      an exact tie goes to IndexedDB, the primary store (the only way to tie is two unstamped blobs or
 *      a migration copy that carried its source stamp verbatim, where both sides hold the same data).
 *      The blob and its stamp are written TOGETHER, in one IndexedDB transaction (F2, idbBacking's
 *      setItems) - as two sequential puts the stamp landed a microtask later and routinely died with
 *      the document on a pagehide flush, so the last write of every tab-close session kept the
 *      PREVIOUS stamp and lost newest-wins next session. The localStorage side writes blob-then-stamp
 *      as two synchronous calls in one task, which cannot be split the same way.
 *      The comparison itself lives in ONE exported function, readNewestPersistedRaw, shared with
 *      scanPersistNamespace's adopt-banner + adopt-copy path (F1) so the two can never drift.
 *      Stamps are also FLOORED at hydration (F3): lastStamp is seeded to the highest stamp seen on
 *      disk, so a backwards device-clock jump cannot make this session's genuinely newer writes stamp
 *      lower than the stale copy they are meant to replace.
 *    Whenever the localStorage copy wins, it is migrated forward (copy-then-clear) so the divergence
 *    heals instead of repeating every reload; whenever IndexedDB wins, the losing localStorage copy is
 *    removed best-effort so a stale multi-MB blob does not sit against the ~5MB quota.
 *
 *  - MIGRATION: on an IndexedDB miss, opts.migrateFrom (localStorage) is consulted; a hit is returned to
 *    the caller immediately and copied into IndexedDB in the background, carrying the SOURCE stamp (so a
 *    copy never spuriously outranks a newer localStorage write); the legacy key + stamp are removed ONLY
 *    after that copy resolves, so the data always exists in at least one store. The copy runs OUTSIDE
 *    the coalesce queue (it is not a "latest pending write"), so it is tracked separately (see
 *    `migrations`): a real write for the same key always applies AFTER the migration settles, and
 *    removeItem cancels the migration's effect even if the copy is still in flight.
 *
 *  - WRITE-THROUGH ON FAILURE (defect B2). ANY failed backing write immediately re-writes the same
 *    value + stamp to opts.migrateFrom, so the write that FAILS is not the write that gets lost. That
 *    fallback can itself throw (localStorage quota - the accepted residual risk B6); that is fail-soft
 *    and reported through onPersistFailure("write", err), but nothing further can be done - the write is
 *    genuinely dropped and the in-memory session continues (TOP-LEVEL LAW).
 *
 *  - `backingBroken` is a PERFORMANCE short-circuit ONLY (defect B2). After BACKING_BROKEN_THRESHOLD
 *    consecutive failed backing WRITES - or an up-front probe that says IndexedDB does not work at all
 *    (defect B5) - writes skip IndexedDB and go straight to localStorage instead of paying a doomed
 *    round trip each time. Data correctness never depends on it: it is the stamps + write-through above
 *    that make the two-store state recoverable. Only real backing WRITES move the counter (a success
 *    resets it); reads and removes never touch it, so a write-only failure mode interleaved with
 *    successful reads still latches. Reads always consult both stores regardless, and removes always
 *    reach both stores regardless.
 *
 *  - flush()'s real guarantee: when the IndexedDB connection is already open (the common case once
 *    warmed up), idbBacking.tx() starts the transaction SYNCHRONOUSLY, in the same task, so flush() on
 *    pagehide really does start the put before the task ends. While the connection is still opening
 *    (first write of a session, or after eviction), the put is necessarily async/best-effort - the
 *    localStorage version can write fully synchronously in every case, which remains the one contract
 *    weakening of the migration, bounded to the (rare) not-yet-open case instead of every flush.
 */
const BACKING_BROKEN_THRESHOLD = 3;

/** Sibling key holding the write stamp for `name`. Kept as a separate key (not folded into the blob)
 *  so the blob under `name` stays byte-identical to what localStorage held - external readers, the E2E
 *  proof, and the migration copy all treat it as an opaque string. */
export const persistStampKey = (name: string) => `${name}::stamp`;

/** Parse a stamp string; anything missing or non-numeric is 0 = "oldest / unknown age". */
function parseStamp(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// -------------------------------------------------------------------------------------------------
// P7 (MEDIUM): the legacy blob and its stamp could SPLIT on quota.
//
// writeThroughToLegacy wrote the blob to `name` and the stamp to `name::stamp` as two separate
// localStorage.setItem calls. They are synchronous and in one task, so an unload cannot split them -
// but a QUOTA error can: the blob write can succeed (it usually REPLACES an existing value, so the
// net byte delta is small) while the stamp write throws (a brand-new key, so it is a net ADD). That
// leaves localStorage holding NEW content under an OLD stamp, and the next session's newest-wins
// comparison then hands the crown to the stale IndexedDB copy - and destructively deletes the newer
// localStorage blob as "the loser".
//
// CHOICE: the envelope (the reviewer's preferred fix), because localStorage gives us exactly one
// atomic primitive - a single setItem - and both facts have to land or neither. The alternative
// (delete the stamp key on stamp-write failure, leaving the blob merely UNSTAMPED) was rejected:
// an unstamped blob is treated as age 0, so the newest content still LOSES and is still deleted by
// the loser cleanup. It converts a wrong-winner bug into a different wrong-winner bug.
//
// FORMAT: a `sisv1:<stamp>:<raw>` PREFIX, deliberately not JSON. Nesting the multi-MB blob inside a
// JSON envelope would re-escape every quote in it (~2x size) against the very ~5MB quota this path
// exists to survive - the fix would cause the failure. The prefix is O(1) to write and to strip, and
// cannot collide with a real persisted blob (those are JSON objects, always starting with `{`).
//
// BACK-COMPAT is mandatory in both directions and is handled by decodeLegacyStamped below: a value
// with no prefix is a PLAIN raw blob whose stamp lives in the sibling `::stamp` key, which is what
// every pre-existing install holds and what the E2E's legacy-seeding writes. The sibling key is
// still removed on removal (removeFromLegacy / removePersistedKeyEverywhere) so no orphan survives.
// -------------------------------------------------------------------------------------------------
const LEGACY_ENVELOPE_PREFIX = "sisv1:";

/** Blob + stamp as ONE atomic localStorage value. */
export function encodeLegacyStamped(raw: string, stamp: number): string {
  return `${LEGACY_ENVELOPE_PREFIX}${stamp}:${raw}`;
}

/**
 * Split a stored legacy value into its blob and stamp.
 * `stamp: null` means "not enveloped" - a plain pre-envelope blob, whose age the caller must still
 * look up in the sibling `::stamp` key. A malformed envelope is treated as plain raw rather than
 * discarded: never lose a user's blob over a formatting doubt.
 */
export function decodeLegacyStamped(stored: string | null): { raw: string | null; stamp: number | null } {
  if (stored === null) return { raw: null, stamp: null };
  if (!stored.startsWith(LEGACY_ENVELOPE_PREFIX)) return { raw: stored, stamp: null };
  const rest = stored.slice(LEGACY_ENVELOPE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return { raw: stored, stamp: null };
  const stamp = parseStamp(rest.slice(0, sep));
  if (stamp === 0) return { raw: stored, stamp: null };
  return { raw: rest.slice(sep + 1), stamp };
}

/** Which store the newest copy of a key came from. "none" = neither store holds it. */
export type PersistedReadSource = "backing" | "legacy" | "none";

export interface NewestPersistedRead {
  /** The winning raw blob (still a string; callers parse), or null when neither store has the key. */
  raw: string | null;
  source: PersistedReadSource;
  /** Both sides, so a caller can heal the divergence (migrate forward / drop the loser). */
  backingRaw: string | null;
  legacyRaw: string | null;
  /** 0 when absent or unstamped. P3/P4: BOTH stamps are now read on EVERY call, and the backing's
   *  blob+stamp come from ONE snapshot. Previously the backing stamp was skipped whenever legacy had
   *  no blob, which left the write-stamp FLOOR unseeded in the backing-only path (P3): after a clock
   *  rollback the next fallback write stamped LOWER than the stale IndexedDB stamp and lost on
   *  reload. The extra read costs one more request in the SAME transaction. */
  backingStamp: number;
  legacyStamp: number;
}

/**
 * F1: the ONE newest-wins comparison, shared by this wrapper's getItem AND by
 * scanPersistNamespace.getPersistedBlob (the adopt-banner decision + the adopt copy). Those used to
 * carry a second, IDB-first-then-localStorage implementation, so under divergence (the write-through
 * path leaves the NEWEST blob in localStorage while an OLDER copy sits in IndexedDB) the adopt path
 * copied the stale blob to the per-uid key and then deleted the newer one - silent loss of the newest
 * pre-account scans - while the inverse (a stale empty sign-out wipe blob in IndexedDB) suppressed the
 * adopt banner entirely. One function, one rule: higher stamp wins, missing/unparseable stamp = 0
 * (oldest), exact tie goes to the backing (the primary store).
 *
 * Read-only and fail-soft: never writes, never heals, never throws - a failed read counts as absent.
 */
export async function readNewestPersistedRaw(
  name: string,
  backing: (Pick<AsyncBacking, "getItem"> & Partial<Pick<AsyncBacking, "getItems">>) | null,
  legacy: Pick<SyncLegacyStorage, "getItem"> | null,
): Promise<NewestPersistedRead> {
  /**
   * P4 (HIGH, torn read): the blob and its stamp used to be fetched in TWO separate transactions.
   * Between them, another tab's atomic write (idbBacking.setItems - blob and stamp together) can
   * land, so this reader could pair the STALE blob A with the NEW stamp 3. That false pair then wins
   * the comparison and the loser cleanup below DELETES the genuinely newest blob from the other
   * store - a silent, unrecoverable loss. One transaction, one snapshot: they can no longer disagree.
   */
  const readBackingPair = async (blobKey: string, stampKey: string): Promise<[string | null, string | null]> => {
    if (!backing) return [null, null];
    try {
      if (backing.getItems) {
        const [blob, stamp] = await backing.getItems([blobKey, stampKey]);
        return [blob ?? null, stamp ?? null];
      }
      // Documented fallback for a backing without getItems (hand-rolled test doubles and any future
      // alternative backing - the real idbBacking always provides it). These are two independent
      // reads, so this path remains torn-read-prone BY CONSTRUCTION; it is accepted only because such
      // backings are single-tab/in-process, where no concurrent atomic writer exists.
      return [await backing.getItem(blobKey), await backing.getItem(stampKey)];
    } catch (err) {
      console.warn(`[scanStore] Could not read '${blobKey}' from IndexedDB.`, err);
      return [null, null];
    }
  };
  const readLegacy = (key: string): string | null => {
    if (!legacy) return null;
    try {
      return legacy.getItem(key);
    } catch (err) {
      console.warn(`[scanStore] Could not read '${key}' from local storage.`, err);
      return null;
    }
  };

  const [backingRaw, backingStampRaw] = await readBackingPair(name, persistStampKey(name));
  const backingStamp = parseStamp(backingStampRaw);

  // P7: a legacy value may be an atomic `sisv1:<stamp>:<raw>` envelope (blob + stamp in one setItem)
  // or a pre-envelope plain blob whose stamp lives in the sibling key. Both are supported forever.
  const decoded = decodeLegacyStamped(readLegacy(name));
  const legacyRaw = decoded.raw;

  if (legacyRaw === null) {
    return {
      raw: backingRaw,
      source: backingRaw === null ? "none" : "backing",
      backingRaw,
      legacyRaw,
      backingStamp,
      legacyStamp: 0,
    };
  }

  const legacyStamp = decoded.stamp ?? parseStamp(readLegacy(persistStampKey(name)));
  if (backingRaw === null) {
    return { raw: legacyRaw, source: "legacy", backingRaw, legacyRaw, backingStamp, legacyStamp };
  }

  const legacyWins = legacyStamp > backingStamp;
  return {
    raw: legacyWins ? legacyRaw : backingRaw,
    source: legacyWins ? "legacy" : "backing",
    backingRaw,
    legacyRaw,
    backingStamp,
    legacyStamp,
  };
}

export function createAsyncCoalescedFailSoftPersistStorage<S>(
  getAsyncBacking: () => AsyncBacking,
  opts: {
    migrateFrom?: SyncLegacyStorage;
    onPersistFailure?: (kind: "write" | "migrate" | "demoted", err: unknown) => void;
    /** Injectable for tests. Defaults to the real IndexedDB round-trip probe when a global
     *  `indexedDB` exists; when it does not, no probe runs (the caller injected some other backing,
     *  and the global probe would say nothing about it). */
    probeBacking?: () => Promise<boolean>;
  } = {},
): CoalescedFailSoftPersistStorage<S> {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let hasPending = false;
  let scheduled = false;

  // Perf short-circuit only - see the header note. Correctness rests on stamps + write-through.
  let backingBroken = false;
  let consecutiveWriteFailures = 0;

  // Strictly increasing within this instance even if Date.now() does not advance between two writes
  // in the same millisecond, so "later write" always means "higher stamp".
  let lastStamp = 0;
  const nextStamp = (): number => {
    const now = Date.now();
    lastStamp = now > lastStamp ? now : lastStamp + 1;
    return lastStamp;
  };

  // Migration writes run outside the coalesce queue, so track them separately, keyed by persist name,
  // so a same-name real write or removeItem can coordinate with an in-flight copy.
  const migrations = new Map<string, { cancelled: boolean; promise: Promise<void> }>();

  /**
   * P2 (HIGH, resurrection of a previous user's data after sign-out).
   *
   * flush() launches `void doWrite(...)` and drops all tracking of it, so an ALREADY-FLUSHED write is
   * invisible to removeItem - which cancels only the still-pending coalesced slot and any in-flight
   * migration, then deletes both stores. When that untracked backing write later REJECTS, its
   * `.catch` ran writeThroughToLegacy UNCONDITIONALLY, re-creating the blob in localStorage AFTER the
   * removal. On a shared device that resurrected blob is the PREVIOUS user's inventory, and the next
   * sign-in is offered it by the adopt banner.
   *
   * A generation counter per key is enough and cheap: removeItem bumps it, every write captures it at
   * start, and any post-hoc bookkeeping (the failure fallback, and late success cleanup) is skipped
   * once the generation has moved - "a removal happened while I was in flight, so I no longer speak
   * for this key". No lock, no queue, no ordering assumption about who wins the race.
   */
  const removalGenerations = new Map<string, number>();
  const generationOf = (name: string): number => removalGenerations.get(name) ?? 0;

  const notifyFailure = (kind: "write" | "migrate" | "demoted", err: unknown) => {
    if (!opts.onPersistFailure) return;
    try {
      // The callback is caller-supplied and must NEVER throw into the persist path (TOP-LEVEL LAW:
      // persistence failures can never propagate into the store's set()).
      opts.onPersistFailure(kind, err);
    } catch {
      /* swallow: a broken callback must not break persistence */
    }
  };

  const warnDrop = (name: string, step: string, err: unknown) =>
    console.warn(
      `[scanStore] Could not ${step} '${name}' (IndexedDB unavailable or failed); this write was dropped. ` +
        `Scanning continues in memory. (#27 fail-soft)`,
      err,
    );

  const markBackingBroken = (reason: string, err: unknown) => {
    if (backingBroken) return;
    backingBroken = true;
    console.warn(
      `[scanStore] IndexedDB looks unusable (${reason}); routing further writes straight to local ` +
        `storage for the rest of this session. Existing data stays readable from both stores. (#27)`,
      err,
    );
    notifyFailure("demoted", err);
  };

  const recordWriteSuccess = () => {
    consecutiveWriteFailures = 0;
  };

  const recordWriteFailure = (err: unknown) => {
    if (backingBroken) return;
    consecutiveWriteFailures += 1;
    if (consecutiveWriteFailures < BACKING_BROKEN_THRESHOLD) return;
    markBackingBroken(`${BACKING_BROKEN_THRESHOLD} consecutive write failures`, err);
  };

  // Defect B5: backing SELECTION upstream (typeof indexedDB !== "undefined") is only a feature-detect,
  // true even when IndexedDB exists but is BLOCKED (Chrome block-site-data, enterprise policy, Safari
  // lockdown). A fire-and-forget real round trip lets a fully-broken browser skip the 3-failure tax.
  // It can only ever SET the perf flag; nothing waits on it, and no data path depends on its result.
  const probeBacking =
    opts.probeBacking ?? (typeof indexedDB !== "undefined" ? probeIdbBacking : null);
  if (probeBacking) {
    void Promise.resolve()
      .then(() => probeBacking())
      .then((ok) => {
        if (!ok) markBackingBroken("startup probe failed", new Error("IndexedDB probe returned false"));
      })
      .catch((err) => markBackingBroken("startup probe threw", err));
  }

  // --- localStorage (second store) helpers -------------------------------------------------------
  // (Reads live in readNewestPersistedRaw above - the single shared newest-wins reader, F1.)

  /** Returns true when the value landed in localStorage. Fail-soft (B6): a quota error here means the
   *  write is genuinely dropped - reported, never thrown.
   *  Atomicity (P7): blob and stamp go in as ONE `sisv1:<stamp>:<raw>` envelope under the ONE legacy
   *  key, because localStorage's only atomic primitive is a single setItem. As two writes, a quota
   *  error on the stamp (a net-new key) could land NEW content under an OLD stamp - stale-stamped
   *  content that newest-wins then judges the loser and DELETES. Either both facts land or neither. */
  const writeThroughToLegacy = (name: string, serialized: string, stamp: number): boolean => {
    if (!opts.migrateFrom) return false;
    try {
      opts.migrateFrom.setItem(name, encodeLegacyStamped(serialized, stamp));
      // Best-effort: retire any pre-envelope sibling stamp key. The decoder already prefers the
      // envelope's stamp, so an orphan here is inert - but leaving it wastes quota and confuses
      // anyone reading the store by hand. Its own try/catch: this cleanup must never fail the write.
      try {
        opts.migrateFrom.removeItem(persistStampKey(name));
      } catch {
        /* inert orphan; the envelope stamp already governs */
      }
      return true;
    } catch (err) {
      // B6 (accepted, documented risk): the fallback store has its own ~5MB quota wall. There is no
      // third store to try; be honest about the drop instead of pretending it landed.
      warnDrop(name, "persist (local-storage fallback)", err);
      notifyFailure("write", err);
      return false;
    }
  };

  const removeFromLegacy = (name: string) => {
    if (!opts.migrateFrom) return;
    try {
      opts.migrateFrom.removeItem(name);
      opts.migrateFrom.removeItem(persistStampKey(name));
    } catch (err) {
      console.warn(`[scanStore] Could not remove '${name}' from local storage.`, err);
    }
  };

  // --- IndexedDB (primary store) ----------------------------------------------------------------
  /** F2: blob + stamp in ONE backing transaction so a pagehide flush can never land the blob while
   *  its stamp put dies with the document (which left the last write of every tab-close session
   *  carrying the PREVIOUS write's stamp, losing newest-wins in the next session). A backing without
   *  setItems (test doubles only - the real idbBacking always has it) falls back to the old two-call
   *  sequence, which is still blob-then-stamp so a failed stamp leaves the blob merely "unstamped"
   *  (treated as oldest) rather than a fresh stamp advertising stale content. */
  const writeBlobAndStamp = (
    backing: AsyncBacking,
    name: string,
    serialized: string,
    stamp: number,
  ): Promise<void> => {
    const stampRaw = String(stamp);
    if (backing.setItems) {
      return backing.setItems([[name, serialized], [persistStampKey(name), stampRaw]]);
    }
    return backing
      .setItem(name, serialized)
      .then(() => backing.setItem(persistStampKey(name), stampRaw));
  };

  const doWrite = (name: string, value: StorageValue<S>): Promise<void> => {
    const write = (): Promise<void> => {
      // P2: captured at the START of the real write attempt (after any migration wait), so it
      // reflects the state of the world this write believes in.
      const generation = generationOf(name);
      const removedSinceStart = () => generationOf(name) !== generation;
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch (err) {
        warnDrop(name, "serialize", err);
        notifyFailure("write", err);
        return Promise.resolve();
      }
      const stamp = nextStamp();

      // Perf short-circuit only, and only when there IS somewhere else to write: with no
      // migrateFrom, skipping the backing would mean dropping the write, so keep trying it.
      if (backingBroken && opts.migrateFrom) {
        writeThroughToLegacy(name, serialized, stamp);
        return Promise.resolve();
      }

      const backing = getAsyncBacking();
      return writeBlobAndStamp(backing, name, serialized, stamp)
        .then(() => {
          recordWriteSuccess();
          if (!removedSinceStart()) return;
          // P2 (late success): this write COMMITTED after a removal was requested, so it just put the
          // removed key back into the backing. removeItem's own delete already ran (and raced past
          // this commit), so re-issue it - the removal is authoritative, not this stale write.
          const warnRemove = (key: string) => (err: unknown) =>
            console.warn(`[scanStore] Could not remove '${key}' from IndexedDB.`, err);
          backing.removeItem(name).catch(warnRemove(name));
          backing.removeItem(persistStampKey(name)).catch(warnRemove(persistStampKey(name)));
          removeFromLegacy(name);
        })
        .catch((err) => {
          warnDrop(name, "persist", err);
          notifyFailure("write", err);
          recordWriteFailure(err);
          if (removedSinceStart()) {
            // P2 (the resurrection case): a removeItem landed for this key while this write was in
            // flight. Writing the value through to localStorage now would re-create exactly what the
            // removal just deleted - on a shared device, the previous user's inventory, offered to
            // the next sign-in by the adopt banner. The write is genuinely dropped, which is correct:
            // its data was explicitly removed.
            return;
          }
          // Defect B2: the FAILING write is written through immediately, not only once a latch trips -
          // otherwise the writes that trip the latch are exactly the ones lost.
          writeThroughToLegacy(name, serialized, stamp);
        });
    };

    const migrationEntry = migrations.get(name);
    if (migrationEntry) {
      // A later real write must always win over a slower in-flight migration copy for the SAME key.
      // Wait for the migration to settle (success or failure) before applying this write, so this
      // write's value is always the final state, regardless of which started first.
      return migrationEntry.promise.catch(() => undefined).then(write);
    }
    return write();
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

  const parseBlob = (name: string, raw: string | null): StorageValue<S> | null => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StorageValue<S>;
    } catch (err) {
      console.warn(`[scanStore] Could not parse persisted '${name}'; treating as absent.`, err);
      return null;
    }
  };

  // Backing reads go through readNewestPersistedRaw (F1), which is fail-soft the same way and, like
  // this wrapper always has, never moves the WRITE-failure counter (defect B2): a broken read says
  // nothing about whether writes land, and conflating the two let read successes mask a write-only
  // outage.

  /** Copy a localStorage blob (+ its stamp) forward into IndexedDB, then clear it - copy-then-clear, so
   *  the data always exists in at least one store. Tracked so a same-key write/removal can coordinate. */
  const startMigration = (name: string, legacyRaw: string, sourceStamp: number) => {
    // Nothing to migrate INTO while the backing is the known-broken one: localStorage is the live
    // store in that state, and the copy would just fail. It is retried on the next load.
    if (backingBroken && opts.migrateFrom) return;
    if (migrations.has(name)) return;

    const backing = getAsyncBacking();
    const migrationEntry: { cancelled: boolean; promise: Promise<void> } = {
      cancelled: false,
      promise: Promise.resolve(),
    };
    // Carries the SOURCE stamp (0 when the legacy blob predates the stamp scheme) so the copy cannot
    // spuriously outrank a genuinely newer localStorage write for the same key - and lands blob +
    // stamp in one transaction (F2), so an interrupted copy can never leave an unstamped blob that a
    // later comparison would treat as oldest.
    const migrationPromise = writeBlobAndStamp(backing, name, legacyRaw, sourceStamp)
      .then(() => {
        recordWriteSuccess();
        if (migrationEntry.cancelled) return; // superseded: removeItem already owns cleanup
        removeFromLegacy(name);
      })
      .catch((err) => {
        recordWriteFailure(err);
        if (migrationEntry.cancelled) return;
        warnDrop(name, "migrate", err);
        notifyFailure("migrate", err);
      });
    migrationEntry.promise = migrationPromise;
    migrations.set(name, migrationEntry);
    void migrationPromise.finally(() => {
      if (migrations.get(name) === migrationEntry) migrations.delete(name);
    });
  };

  return {
    getItem: async (name: string) => {
      // Both stores are ALWAYS consulted (defect B1): whichever holds the newer stamp wins. This does
      // not depend on backingBroken - a fresh wrapper in a new session has no idea which store the
      // previous session ended up writing to. The comparison itself lives in readNewestPersistedRaw
      // so the adopt-banner/adopt-copy path (scanPersistNamespace) shares this exact rule (F1).
      const read = await readNewestPersistedRaw(
        name,
        { getItem: (key: string) => getAsyncBacking().getItem(key) },
        opts.migrateFrom ?? null,
      );

      // F3 + P3: seed the stamp floor from what is already on disk. lastStamp starts at 0 per
      // instance, so after a backwards device-clock jump (or a restored-from-backup profile)
      // Date.now() can be LOWER than the stamp already stored - a genuinely newer write would then
      // look older and newest-wins would discard it.
      //
      // P3 (HIGH): this used to be gated on `read.legacyRaw !== null`, and the reader did not even
      // fetch the backing stamp when legacy had no blob. So in the BACKING-ONLY path (the normal
      // steady state: everything lives in IndexedDB, nothing in localStorage) the floor was never
      // seeded. After a clock rollback the next write that FALLS BACK to localStorage stamped LOWER
      // than the stale IndexedDB stamp, and the stale IndexedDB copy won the next reload - losing the
      // session's real scans. The floor is unconditional now; the reader always supplies both stamps.
      lastStamp = Math.max(lastStamp, read.backingStamp, read.legacyStamp);

      if (read.source === "legacy") {
        // Either the classic migration case (only localStorage has it) or a divergence where the
        // localStorage copy is newer because a previous session's IndexedDB writes were failing.
        // Both heal the same way: copy forward carrying the source stamp, clear legacy after it lands.
        startMigration(name, read.legacyRaw as string, read.legacyStamp);
        return parseBlob(name, read.legacyRaw);
      }

      if (read.source === "backing" && read.legacyRaw !== null) {
        // IndexedDB wins a divergence: drop the stale localStorage copy so a multi-MB loser does not
        // sit against the ~5MB quota (best-effort; the winning copy is already safely in IndexedDB).
        removeFromLegacy(name);
      }
      return parseBlob(name, read.backingRaw);
    },

    removeItem: (name: string) => {
      // A removal must be authoritative in BOTH stores, and must happen regardless of backingBroken
      // (defect B3: an early return here used to skip migration cancellation, letting an in-flight
      // migration copy resurrect a key that sign-out / "Clear local cache" had just removed - on a
      // shared device that resurrected blob is the PREVIOUS user's inventory).
      // P2: bump FIRST, before anything can await, so every write already in flight for this key sees
      // the advanced generation and refuses to write itself back through the failure fallback.
      removalGenerations.set(name, generationOf(name) + 1);

      if (pendingName === name) {
        hasPending = false;
        pendingName = null;
        pendingValue = null;
      }

      const migrationEntry = migrations.get(name);
      if (migrationEntry) migrationEntry.cancelled = true;

      const removeFromBacking = () => {
        const backing = getAsyncBacking();
        const warnRemove = (key: string) => (err: unknown) =>
          console.warn(`[scanStore] Could not remove '${key}' from IndexedDB.`, err);
        backing.removeItem(name).catch(warnRemove(name));
        backing.removeItem(persistStampKey(name)).catch(warnRemove(persistStampKey(name)));
      };

      if (migrationEntry) {
        // Defer the backing removal until the cancelled copy has settled, otherwise a migration write
        // that lands after this call would reinstate the value we just deleted.
        void migrationEntry.promise.catch(() => undefined).then(removeFromBacking);
      } else {
        removeFromBacking();
      }

      removeFromLegacy(name);
    },

    setItem: (name: string, value: StorageValue<S>) => {
      // Coalesce: remember only the latest RAW value; stringify happens once, at flush time.
      pendingName = name;
      pendingValue = value;
      hasPending = true;
      schedule();
    },

    flush,
  };
}
