// Fail-soft IndexedDB persistence for the scan store. It keeps the optimistic count in memory first,
// migrates legacy localStorage safely, and coalesces durable snapshots outside the scan hot path.

import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

// Backing storage may or may not be present (SSR / disabled). Kept minimal on purpose.
type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Observable persistence health. Degraded means scans still work in memory, but durable writes failed. */
export type PersistenceStatus = "available" | "degraded";
let browserPersistenceStatus: PersistenceStatus = "available";
const persistenceListeners = new Set<() => void>();
export function getBrowserPersistenceStatus(): PersistenceStatus { return browserPersistenceStatus; }
export function subscribeBrowserPersistenceStatus(listener: () => void): () => void { persistenceListeners.add(listener); return () => persistenceListeners.delete(listener); }
export function setBrowserPersistenceStatus(status: PersistenceStatus): void {
  if (browserPersistenceStatus === status) return;
  browserPersistenceStatus = status;
  persistenceListeners.forEach((listener) => listener());
}

/** Small async seam so migration behavior is testable without a third-party IndexedDB shim. */
export interface AsyncKeyValueDatabase {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** Atomically reserve a previously absent key. Native IndexedDB implements this in one readwrite transaction. */
  createIfAbsent?: (key: string, value: string) => Promise<"created" | "exists">;
  /** Atomically reserve a complete namespace when its main value and metadata are all absent. */
  createNamespaceIfAbsent?: (key: string, value: string, occupiedMetadataKeys: string[]) => Promise<"created" | "exists">;
}

export type PersistenceClearResult = { cleared: boolean; authority: "durable" | "local" | "none" };

type AsyncDurableStorageOptions = {
  database: AsyncKeyValueDatabase | null;
  getLegacyStorage: () => Backing | null;
  onStatusChange?: (status: PersistenceStatus) => void;
};

type AsyncDurablePersistStorageOptions = AsyncDurableStorageOptions & {
  /** Test seam; production uses JSON.stringify at the deferred flush boundary. */
  serialize?: (snapshot: unknown) => string;
};

type DeferredStringStorage = StateStorage & {
  setDeferredItem: (name: string, serialize: () => string) => Promise<void>;
};

const PERSIST_POINTER_KEY = "__scanPersistPointer";
const TOMBSTONE_SUFFIX = "::scanbin-cleared-v1";
const RECOVERY_SUFFIX = "::scanbin-recovery-v1";
const WRITE_INTENT_SUFFIX = "::scanbin-write-intent-v1";
const PERSIST_FALLBACK_KEY = "__scanPersistFallback";
const PERSIST_RECOVERY_KEY = "__scanPersistRecovery";
const PERSIST_CLEAR_KEY = "__scanPersistClear";

type RecoveryCandidate = { payload: string; supersedesTombstone: string | null };
type AuthoritativeFallback = RecoveryCandidate & { invalidatesRecovery: boolean };
type TombstoneState = {
  token: string | null;
  conflict: boolean;
  durableKnown: boolean;
  maxVersion: number;
  maxIssuedAt: number;
  intentBarrierEstablished: boolean;
  conflictFingerprint: string | null;
};

function createOperationId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch { /* fall through to a non-ordering random identity */ }
  return `clear-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

type ClearToken = {
  raw: string;
  version: number;
  id: string;
  ordered: boolean;
  issuedAt: number;
  intentBarrierEstablished: boolean;
};

function parseClearToken(raw: string): ClearToken {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed[PERSIST_CLEAR_KEY] === 1 && Number.isSafeInteger(parsed.version) && (parsed.version as number) > 0 && typeof parsed.id === "string") {
      return {
        raw,
        version: parsed.version as number,
        id: parsed.id,
        ordered: true,
        issuedAt: typeof parsed.issuedAt === "number" && Number.isFinite(parsed.issuedAt) ? parsed.issuedAt : 0,
        intentBarrierEstablished: parsed.intentBarrierEstablished === true,
      };
    }
  } catch { /* legacy tombstones are opaque version-zero identities */ }
  return {
    raw,
    version: 0,
    id: raw,
    ordered: false,
    issuedAt: 0,
    intentBarrierEstablished: false,
  };
}

function encodeClearToken(version: number, issuedAt: number, intentBarrierEstablished = false): string {
  return JSON.stringify({
    [PERSIST_CLEAR_KEY]: 1,
    version,
    id: createOperationId(),
    issuedAt,
    intentBarrierEstablished,
  });
}

function resolveNewestClearToken(rawTokens: string[]): { token: string | null; conflict: boolean; maxVersion: number } {
  const tokens = rawTokens.map(parseClearToken);
  if (tokens.length === 0) return { token: null, conflict: false, maxVersion: 0 };
  const maxVersion = Math.max(...tokens.map((token) => token.version));
  const newest = tokens.filter((token) => token.version === maxVersion);
  const ids = new Set(newest.map((token) => token.id));
  if (ids.size > 1) return { token: null, conflict: true, maxVersion };
  return { token: newest[0].raw, conflict: false, maxVersion };
}

// Synchronous cross-adapter evidence. This is deliberately metadata-only: scheduling a scan never
// starts IndexedDB work, while clear issuance is immediately visible to other adapters in this tab.
const publishedClearTokensByDatabase = new WeakMap<AsyncKeyValueDatabase, Map<string, Set<string>>>();

type WriteIntent = {
  id: string;
  scheduledAt: number;
  observedToken: string | null;
  observedConflictFingerprint: string | null;
};

function encodeWriteIntent(intent: WriteIntent): string {
  return JSON.stringify({ __scanPersistWriteIntent: 1, ...intent });
}

function decodeWriteIntent(raw: string | null): WriteIntent | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.__scanPersistWriteIntent !== 1 || typeof parsed.id !== "string") return null;
    return {
      id: parsed.id,
      scheduledAt: typeof parsed.scheduledAt === "number" ? parsed.scheduledAt : 0,
      observedToken: typeof parsed.observedToken === "string" ? parsed.observedToken : null,
      observedConflictFingerprint: typeof parsed.observedConflictFingerprint === "string"
        ? parsed.observedConflictFingerprint
        : null,
    };
  } catch {
    return null;
  }
}

function encodeRecoveryCandidate(candidate: RecoveryCandidate): string {
  return JSON.stringify({ [PERSIST_RECOVERY_KEY]: 1, ...candidate });
}

function decodeRecoveryCandidate(value: string | null): RecoveryCandidate | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed[PERSIST_RECOVERY_KEY] === 1 && typeof parsed.payload === "string") {
      return {
        payload: parsed.payload,
        supersedesTombstone: typeof parsed.supersedesTombstone === "string" ? parsed.supersedesTombstone : null,
      };
    }
  } catch { /* pre-envelope candidates were stored as raw payload strings */ }
  return { payload: value, supersedesTombstone: null };
}

function encodeAuthoritativePersistFallback(
  payload: string,
  options: { invalidatesRecovery?: boolean; supersedesTombstone?: string | null } = {},
): string {
  return JSON.stringify({
    [PERSIST_FALLBACK_KEY]: 1,
    payload,
    invalidatesRecovery: options.invalidatesRecovery === true,
    supersedesTombstone: options.supersedesTombstone ?? null,
  });
}

function decodeAuthoritativePersistFallback(value: string | null): AuthoritativeFallback | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed[PERSIST_FALLBACK_KEY] !== 1 || typeof parsed.payload !== "string") return null;
    return {
      payload: parsed.payload,
      invalidatesRecovery: parsed.invalidatesRecovery === true,
      supersedesTombstone: typeof parsed.supersedesTombstone === "string" ? parsed.supersedesTombstone : null,
    };
  } catch {
    return null;
  }
}

/** Returns only a complete atomic fallback envelope; raw legacy snapshots and pointers are ambiguous. */
export function getAuthoritativePersistFallback(value: string | null): string | null {
  return decodeAuthoritativePersistFallback(value)?.payload ?? null;
}

function isDurablePointer(value: string | null): boolean {
  if (!value) return false;
  try {
    return (JSON.parse(value) as Record<string, unknown>)[PERSIST_POINTER_KEY] === 1;
  } catch {
    return false;
  }
}

function isUidNamespace(name: string): boolean {
  return name.startsWith("sis-scan-") && name !== "sis-scan-v1";
}

/**
 * Async, fail-soft bridge from Zustand to durable storage. Existing localStorage values are read once
 * into IndexedDB without altering their bytes. After IndexedDB accepts the snapshot, the legacy copy
 * is removed. UID namespaces retain only their tiny ownership marker; full snapshots return to
 * localStorage only if durable persistence later fails.
 */
export function createAsyncDurableStorage(options: AsyncDurableStorageOptions): StateStorage {
  const reportDegraded = () => options.onStatusChange?.("degraded");
  const reportAvailable = () => options.onStatusChange?.("available");
  const queuedByKey = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, {
    serialize: () => string;
    token: number;
    observation: TombstoneState;
    scheduledAt: number;
    intentId: string;
    intentWrite: Promise<boolean>;
    resolvers: Array<() => void>;
    scheduled: boolean;
  }>();
  let lastCausalTimestamp = Number.NEGATIVE_INFINITY;
  const causalNow = (): number => {
    let timestamp = Date.now();
    try {
      const highResolution = globalThis.performance.timeOrigin + globalThis.performance.now();
      if (Number.isFinite(highResolution)) {
        // performance.now is already monotonic. Preserve equal reduced-precision ticks: inventing
        // sub-tick order would let a pre-clear burst appear causally newer than a same-tick clear.
        lastCausalTimestamp = highResolution;
        return highResolution;
      }
    } catch { /* Date.now remains the epoch-clock fallback */ }
    if (timestamp <= lastCausalTimestamp) timestamp = lastCausalTimestamp + 1;
    lastCausalTimestamp = timestamp;
    return timestamp;
  };
  const lastObservedTombstoneState = new Map<string, TombstoneState>();
  const publishedClearTokens = options.database
    ? (publishedClearTokensByDatabase.get(options.database) ?? new Map<string, Set<string>>())
    : new Map<string, Set<string>>();
  if (options.database) publishedClearTokensByDatabase.set(options.database, publishedClearTokens);
  const publishClearToken = (name: string, token: string): void => {
    const tokens = publishedClearTokens.get(name) ?? new Set<string>();
    tokens.add(token);
    publishedClearTokens.set(name, tokens);
  };
  let clearBroadcast: BroadcastChannel | null = null;
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (!event.key?.endsWith(TOMBSTONE_SUFFIX) || event.newValue === null) return;
      publishClearToken(event.key.slice(0, -TOMBSTONE_SUFFIX.length), event.newValue);
    });
    try {
      if (typeof window.BroadcastChannel !== "undefined") {
        clearBroadcast = new window.BroadcastChannel("scanbin-persist-clear-v1");
        clearBroadcast.onmessage = (event: MessageEvent<{ name?: unknown; token?: unknown }>) => {
          if (typeof event.data?.name === "string" && typeof event.data.token === "string") {
            publishClearToken(event.data.name, event.data.token);
          }
        };
      }
    } catch { clearBroadcast = null; }
  }
  const tombstones = new Map<string, string>();
  const legacySnapshotsCleaned = new Set<string>();
  const legacyMarkersEnsured = new Set<string>();
  const legacyMarkerWarnings = new Set<string>();
  const legacyRemoveWarnings = new Set<string>();
  // Each clear moves a key to a new generation. A write captures the generation it was created in,
  // so a pre-clear write that completes late cannot remove the newer clear tombstone.
  const generationByKey = new Map<string, number>();
  const enqueue = <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const prior = queuedByKey.get(name);
    // Start the first operation immediately. This preserves the fail-soft guarantee at Zustand's
    // synchronous set boundary while later same-key operations remain strictly ordered.
    const next = prior ? prior.catch(() => undefined).then(task) : task();
    queuedByKey.set(name, next.then(() => undefined, () => undefined));
    return next;
  };
  // localStorage is a migration/fallback layer, not the durable authority. Its absence must not mark
  // a healthy IndexedDB session degraded; IndexedDB failures report their own status below.
  const reportLegacyFailure = () => {
    if (!options.database) reportDegraded();
  };

  const legacyRead = (name: string): { available: boolean; value: string | null } => {
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return { available: false, value: null };
      return { available: true, value: storage.getItem(name) };
    } catch {
      reportLegacyFailure();
      return { available: false, value: null };
    }
  };
  const legacyGet = (name: string): string | null => legacyRead(name).value;

  const legacySet = (name: string, value: string): boolean => {
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      storage.setItem(name, value);
      return true;
    } catch {
      reportLegacyFailure();
      // Kept as a diagnostic supplement only. The store/UI status is the user-visible failure path.
      console.warn(`[scanStore] Could not persist '${name}' to local fallback storage.`);
      return false;
    }
  };

  const legacyRemove = (name: string): boolean => {
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      storage.removeItem(name);
      legacyRemoveWarnings.delete(name);
      return true;
    } catch {
      reportLegacyFailure();
      if (!legacyRemoveWarnings.has(name)) {
        legacyRemoveWarnings.add(name);
        console.warn(`[scanStore] Could not remove stale '${name}' local persistence data.`);
      }
      return false;
    }
  };
  const ensureLegacyMarkerOnce = (name: string): boolean => {
    if (legacyMarkersEnsured.has(name)) return true;
    const marker = JSON.stringify({ [PERSIST_POINTER_KEY]: 1 });
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      if (!isDurablePointer(storage.getItem(name))) storage.setItem(name, marker);
    } catch {
      // This marker is supplemental ownership metadata, not the snapshot fallback. IndexedDB is
      // healthy, so surface the failure once without creating a warning loop on every scan.
      if (!legacyMarkerWarnings.has(name)) {
        legacyMarkerWarnings.add(name);
        console.warn(`[scanStore] Could not persist '${name}' ownership marker to local storage.`);
      }
      return false;
    }
    legacyMarkersEnsured.add(name);
    legacyMarkerWarnings.delete(name);
    return true;
  };
  const removeLegacySnapshotOnce = (name: string) => {
    if (legacySnapshotsCleaned.has(name)) return;
    const completed = isUidNamespace(name) ? ensureLegacyMarkerOnce(name) : legacyRemove(name);
    if (completed) legacySnapshotsCleaned.add(name);
  };
  const tombstoneKey = (name: string) => `${name}${TOMBSTONE_SUFFIX}`;
  const recoveryKey = (name: string) => `${name}${RECOVERY_SUFFIX}`;
  const writeIntentKey = (name: string) => `${name}${WRITE_INTENT_SUFFIX}`;
  const generationFor = (name: string) => generationByKey.get(name) ?? 0;
  const stateFromTokens = (rawTokens: string[], durableKnown: boolean): TombstoneState => {
    const uniqueTokens = [...new Set(rawTokens)];
    const parsedTokens = uniqueTokens.map(parseClearToken);
    const resolved = resolveNewestClearToken(uniqueTokens);
    const authoritativeTokens = parsedTokens.filter((token) => token.version === resolved.maxVersion);
    const conflictFingerprint = resolved.conflict
      ? authoritativeTokens.map((token) => token.raw).sort().join("\n")
      : null;
    const maxIssuedAt = authoritativeTokens.length === 0
      ? 0
      : Math.max(...authoritativeTokens.map((token) => token.issuedAt));
    const intentBarrierEstablished = authoritativeTokens.length > 0
      && authoritativeTokens.every((token) => token.intentBarrierEstablished);
    return { ...resolved, durableKnown, maxIssuedAt, intentBarrierEstablished, conflictFingerprint };
  };
  const getSynchronousTombstoneEvidence = (name: string): TombstoneState => {
    const local = legacyGet(tombstoneKey(name));
    const published = [...(publishedClearTokens.get(name) ?? [])];
    return stateFromTokens(local === null ? published : [...published, local], false);
  };
  const getTombstoneState = async (name: string): Promise<TombstoneState> => {
    const remembered = tombstones.get(name) ?? null;
    const local = legacyGet(tombstoneKey(name));
    let durable: string | null = null;
    let candidateToken: string | null = null;
    let durableKnown = !options.database;
    if (options.database) {
    try {
        durable = await options.database.get(tombstoneKey(name));
        candidateToken = decodeRecoveryCandidate(await options.database.get(recoveryKey(name)))?.supersedesTombstone ?? null;
        durableKnown = true;
    } catch {
      reportDegraded();
    }
    }
    const rawTokens = [remembered, local, durable, candidateToken].filter((value): value is string => value !== null);
    rawTokens.forEach((raw) => publishClearToken(name, raw));
    const state = stateFromTokens(rawTokens, durableKnown);
    const { token } = state;
    if (token !== null) tombstones.set(name, token);
    lastObservedTombstoneState.set(name, state);
    return state;
  };
  const writeTombstone = (name: string, operationToken: string): boolean => {
    publishClearToken(name, operationToken);
    try { clearBroadcast?.postMessage({ name, token: operationToken }); } catch { /* local evidence remains */ }
    tombstones.set(name, operationToken);
    return legacySet(tombstoneKey(name), operationToken);
  };
  const persistTombstone = async (name: string, operationToken: string): Promise<boolean> => {
    if (!options.database) {
      reportDegraded();
      return false;
    }
    try {
      await options.database.set(tombstoneKey(name), operationToken);
      reportAvailable(); return true;
    } catch {
      reportDegraded(); return false;
    }
  };
  const clearTombstone = async (name: string, generation: number, operationToken: string | null): Promise<boolean> => {
    if (generationFor(name) !== generation) return false;
    if (operationToken === null) return true;
    if (options.database) {
      try {
        const durable = await options.database.get(tombstoneKey(name));
        if (durable !== null && durable !== operationToken) return false;
        if (durable === operationToken) await options.database.remove(tombstoneKey(name));
        reportAvailable();
      } catch {
        reportDegraded();
        return false;
      }
    }
    if (generationFor(name) !== generation) return false;
    const local = legacyRead(tombstoneKey(name));
    if (!local.available) return false;
    if (local.value !== null && local.value !== operationToken) return false;
    if (local.value === operationToken && !legacyRemove(tombstoneKey(name))) return false;
    tombstones.delete(name);
    return true;
  };

  const retireAuthoritativeLocalFallback = (name: string): boolean => {
    const local = legacyRead(name);
    if (!local.available) {
      reportDegraded();
      return false;
    }
    if (local.value === null) {
      if (isUidNamespace(name)) ensureLegacyMarkerOnce(name);
      return true;
    }
    if (isDurablePointer(local.value)) return true;
    // Any non-pointer payload is ambiguous once a recovery candidate exists. Replace or remove it
    // before retiring the candidate so a later IndexedDB outage cannot resurrect stale local bytes.
    if (isUidNamespace(name) && ensureLegacyMarkerOnce(name)) {
      legacySnapshotsCleaned.add(name);
      return true;
    }
    const removed = legacyRemove(name);
    if (removed) legacySnapshotsCleaned.add(name);
    else reportDegraded();
    return removed;
  };

  const performWrite = async (
    name: string,
    value: string,
    token: number,
    scheduledObservation: TombstoneState,
    scheduledAt: number,
    intentId: string,
    intentWrite: Promise<boolean>,
  ) => {
    // When recovering from a prior fallback, update its payload first. A crash on either side of the
    // IndexedDB commit then leaves the same newest snapshot authoritative in at least one store.
    const existingLocalFallback = decodeAuthoritativePersistFallback(legacyGet(name));
    const hadFallback = existingLocalFallback !== null;
    const scheduledState = scheduledObservation;
    const tombstoneState = await getTombstoneState(name);
    const scheduledObservedCurrentAuthority = tombstoneState.conflict
      ? scheduledState.conflict
        && scheduledState.maxVersion === tombstoneState.maxVersion
        && scheduledState.conflictFingerprint === tombstoneState.conflictFingerprint
      : tombstoneState.token === null || scheduledState.token === tombstoneState.token;
    // A legacy token's zero timestamp is unknown, not proof that every modern snapshot followed it.
    const scheduledStrictlyAfterCurrentClear = tombstoneState.maxIssuedAt > 0
      && scheduledAt > tombstoneState.maxIssuedAt;
    let matchingSurvivingIntent = false;
    if (!scheduledObservedCurrentAuthority && !scheduledStrictlyAfterCurrentClear
      && tombstoneState.intentBarrierEstablished && options.database && await intentWrite) {
      try {
        matchingSurvivingIntent = decodeWriteIntent(
          await options.database.get(writeIntentKey(name)),
        )?.id === intentId;
      } catch {
        reportDegraded();
      }
    }
    const scheduleAuthorityProven = scheduledObservedCurrentAuthority
      || scheduledStrictlyAfterCurrentClear
      || matchingSurvivingIntent;
    if (!scheduleAuthorityProven) {
      reportDegraded();
      return;
    }
    const removeMatchingIntent = async (): Promise<void> => {
      if (!options.database) return;
      try {
        const currentIntent = decodeWriteIntent(await options.database.get(writeIntentKey(name)));
        if (currentIntent?.id === intentId) await options.database.remove(writeIntentKey(name));
      } catch {
        reportDegraded();
      }
    };
    if (options.database && !tombstoneState.durableKnown) {
      legacySnapshotsCleaned.delete(name);
      legacyMarkersEnsured.delete(name);
      legacySet(name, encodeAuthoritativePersistFallback(value, {
        invalidatesRecovery: true,
        supersedesTombstone: tombstoneState.token,
      }));
      reportDegraded();
      return;
    }
    if (tombstoneState.conflict) {
      const observedSameConflict = scheduledState.conflict
        && scheduledState.maxVersion === tombstoneState.maxVersion
        && scheduledState.conflictFingerprint === tombstoneState.conflictFingerprint;
      if (!observedSameConflict && !scheduledStrictlyAfterCurrentClear && !matchingSurvivingIntent) {
        reportDegraded();
        return;
      }
      if (!options.database) { reportDegraded(); return; }
      const recoveryToken = encodeClearToken(tombstoneState.maxVersion + 1, causalNow());
      try {
        // The full payload is durable before either conflicting clear is reconciled. Its strictly
        // newer generation then provides the only safe ordering point for all tabs.
        await options.database.set(
          recoveryKey(name),
          encodeRecoveryCandidate({ payload: value, supersedesTombstone: recoveryToken }),
        );
        reportAvailable();
      } catch {
        reportDegraded();
        return;
      }
      writeTombstone(name, recoveryToken);
      await persistTombstone(name, recoveryToken);
      let mainWritten = false;
      try {
        await options.database.set(name, value);
        mainWritten = true;
        reportAvailable();
      } catch { reportDegraded(); }
      if (!mainWritten || generationFor(name) !== token) return;
      const localRetired = retireAuthoritativeLocalFallback(name);
      const tombstoneCleared = await clearTombstone(name, token, recoveryToken);
      if (localRetired && tombstoneCleared) {
        try {
          await options.database.remove(recoveryKey(name));
          reportAvailable();
        } catch { reportDegraded(); }
      }
      await removeMatchingIntent();
      return;
    }
    const tombstoneToken = tombstoneState.token;
    if (!options.database) {
      legacySnapshotsCleaned.delete(name);
      legacyMarkersEnsured.delete(name);
      legacySet(name, encodeAuthoritativePersistFallback(value, {
        invalidatesRecovery: true,
        supersedesTombstone: tombstoneToken,
      }));
      reportDegraded();
      return;
    }
    let existingRecovery = false;
    let recoveryWritten = false;
    {
      try {
        existingRecovery = await options.database.get(recoveryKey(name)) !== null;
      } catch {
        // An unknown candidate cannot be allowed to survive and outrank a newer main write. Replace
        // it journal-first; if that also fails, keep the current in-memory state and retry later.
        try {
          await options.database.set(
            recoveryKey(name),
            encodeRecoveryCandidate({ payload: value, supersedesTombstone: tombstoneToken }),
          );
          existingRecovery = true;
          recoveryWritten = true;
          reportAvailable();
        } catch {
          reportDegraded();
          legacySnapshotsCleaned.delete(name);
          legacyMarkersEnsured.delete(name);
          legacySet(name, encodeAuthoritativePersistFallback(value, {
            invalidatesRecovery: true,
            supersedesTombstone: tombstoneToken,
          }));
          return;
        }
      }
    }
    const causalityRequiresRecovery = existingRecovery
      || tombstoneToken !== null
      || existingLocalFallback?.invalidatesRecovery === true;
    const shouldWriteLocalFallback = hadFallback || causalityRequiresRecovery;
    const localFallbackUpdated = !shouldWriteLocalFallback || legacySet(name, encodeAuthoritativePersistFallback(value, {
      invalidatesRecovery: causalityRequiresRecovery,
      supersedesTombstone: tombstoneToken,
    }));
    const needsRecovery = causalityRequiresRecovery || !localFallbackUpdated;
    if (needsRecovery && !existingRecovery) {
      if (!options.database) { reportDegraded(); return; }
      try {
        await options.database.set(
          recoveryKey(name),
          encodeRecoveryCandidate({ payload: value, supersedesTombstone: tombstoneToken }),
        );
        existingRecovery = true;
        recoveryWritten = true;
        reportAvailable();
      } catch {
        reportDegraded();
        return;
      }
    }
    if (existingRecovery && !recoveryWritten) {
      try {
        await options.database!.set(
          recoveryKey(name),
          encodeRecoveryCandidate({ payload: value, supersedesTombstone: tombstoneToken }),
        );
        recoveryWritten = true;
        reportAvailable();
      } catch {
        reportDegraded();
        return;
      }
    }
    let durableWritten = false;
    if (options.database) {
      try { await options.database.set(name, value); durableWritten = true; reportAvailable(); } catch { reportDegraded(); }
    } else reportDegraded();
    // A successful write after an intentional clear supersedes its tombstone. An older in-flight
    // write is deliberately ignored: it may have reached IndexedDB, but the newer tombstone wins.
    if (generationFor(name) !== token) return;
    if (durableWritten) {
      const localRetired = recoveryWritten
        ? retireAuthoritativeLocalFallback(name)
        : (removeLegacySnapshotOnce(name), true);
      const tombstoneCleared = await clearTombstone(name, token, tombstoneToken);
      if (recoveryWritten && localRetired && tombstoneCleared && options.database) {
        try {
          await options.database.remove(recoveryKey(name));
          reportAvailable();
        } catch {
          // The candidate contains the same newest bytes and remains authoritative on reload.
          reportDegraded();
        }
      }
      await removeMatchingIntent();
    } else {
      // Payload and authority metadata are one localStorage value, so an interrupted write cannot
      // leave newer bytes looking like an ambiguous legacy snapshot.
      legacySnapshotsCleaned.delete(name);
      legacyMarkersEnsured.delete(name);
      if (!hadFallback && !recoveryWritten) legacySet(name, encodeAuthoritativePersistFallback(value));
    }
  };
  const flushWrite = (name: string, persistUnloadFallback = false) => {
    const pending = pendingWrites.get(name);
    if (!pending) return;
    pendingWrites.delete(name);
    let value: string;
    try {
      // JSON encoding belongs here, after coalescing chose the latest state, never on Zustand's
      // synchronous set() path. An encode error remains fail-soft just like a durable write failure.
      value = pending.serialize();
    } catch {
      reportDegraded();
      pending.resolvers.forEach((resolve) => resolve());
      return;
    }
    if (persistUnloadFallback) {
      // IndexedDB work cannot be awaited during pagehide. Atomically preserve the newest serialized
      // snapshot locally first; its precedence flag prevents an older recovery candidate winning if
      // the page closes before the async journal/main commit completes.
      legacySnapshotsCleaned.delete(name);
      legacyMarkersEnsured.delete(name);
      legacySet(name, encodeAuthoritativePersistFallback(value, {
        invalidatesRecovery: true,
        supersedesTombstone: tombstones.get(name) ?? legacyGet(tombstoneKey(name)),
      }));
    }
    void enqueue(name, () => performWrite(
      name,
      value,
      pending.token,
      pending.observation,
      pending.scheduledAt,
      pending.intentId,
      pending.intentWrite,
    ))
      .then(() => pending.resolvers.forEach((resolve) => resolve()));
  };
  if (typeof window !== "undefined") {
    const flushAll = () => [...pendingWrites.keys()].forEach((name) => flushWrite(name, true));
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });
  }

  const scheduleWrite = (name: string, serialize: () => string) => new Promise<void>((resolve) => {
    // Capture authority evidence at the same moment as the snapshot. A coalesced newer snapshot
    // replaces both fields, so a delayed pre-clear payload can never borrow post-clear evidence.
    const observation = getSynchronousTombstoneEvidence(name);
    const scheduledAt = causalNow();
    const pending = pendingWrites.get(name);
    if (pending) {
      // The first snapshot owns the burst's ordering intent. Reusing it prevents scan bursts from
      // creating one IndexedDB transaction per keystroke. If a clear removes that intent while the
      // burst is pending, later coalesced bytes cannot recreate or borrow post-clear authority.
      pending.serialize = serialize;
      pending.observation = observation;
      pending.scheduledAt = scheduledAt;
      pending.resolvers.push(resolve);
      return;
    }
    const intentId = createOperationId();
    let intentWrite = Promise.resolve(false);
    if (options.database) {
      try {
        intentWrite = options.database.set(writeIntentKey(name), encodeWriteIntent({
          id: intentId,
          scheduledAt,
          observedToken: observation.token,
          observedConflictFingerprint: observation.conflictFingerprint,
        })).then(
          () => true,
          () => {
            reportDegraded();
            return false;
          },
        );
      } catch {
        reportDegraded();
      }
    }
    const nextPending = {
      serialize,
      token: generationFor(name),
      observation,
      scheduledAt,
      intentId,
      intentWrite,
      resolvers: [resolve],
      scheduled: true,
    };
    pendingWrites.set(name, nextPending);
    queueMicrotask(() => flushWrite(name));
  });

  return {
    getItem: (name) => {
      flushWrite(name);
      return enqueue(name, async () => {
      const tombstoneState = await getTombstoneState(name);
      if (options.database && !tombstoneState.durableKnown) return null;
      const tombstoneToken = tombstoneState.token;
      const localValue = legacyGet(name);
      const localFallback = decodeAuthoritativePersistFallback(localValue);
      let recovery: RecoveryCandidate | null = null;
      let recoveryReadable = true;
      if (options.database) {
        try {
          recovery = decodeRecoveryCandidate(await options.database.get(recoveryKey(name)));
        } catch {
          recoveryReadable = false;
          reportDegraded();
        }
      }
      if (tombstoneState.conflict) {
        reportDegraded();
        return null;
      }
      const localInvalidatesRecovery = localFallback?.invalidatesRecovery === true
        && (tombstoneToken === null || localFallback.supersedesTombstone === tombstoneToken);
      if (localInvalidatesRecovery && localFallback) {
        if (!options.database) return localFallback.payload;
        const replacement = encodeRecoveryCandidate({
          payload: localFallback.payload,
          supersedesTombstone: tombstoneToken,
        });
        try {
          // Journal first so a crash cannot expose the stale candidate after local cleanup.
          await options.database.set(recoveryKey(name), replacement);
          await options.database.set(name, localFallback.payload);
          reportAvailable();
        } catch {
          reportDegraded();
          return localFallback.payload;
        }
        const localRetired = retireAuthoritativeLocalFallback(name);
        const tombstoneCleared = await clearTombstone(name, generationFor(name), tombstoneToken);
        if (localRetired && tombstoneCleared) {
          try {
            await options.database.remove(recoveryKey(name));
            reportAvailable();
          } catch { reportDegraded(); }
        }
        return localFallback.payload;
      }
      if (tombstoneToken !== null && !recoveryReadable) return null;
      const recoverySupersedesClear = recovery !== null
        && recovery.supersedesTombstone === tombstoneToken
        && tombstoneToken !== null;
      if (tombstoneToken !== null && !recoverySupersedesClear) {
        if (options.database) {
          try {
            await options.database.remove(name);
            await options.database.remove(recoveryKey(name));
            reportAvailable();
          } catch { reportDegraded(); }
        }
        legacyRemove(name);
        return null;
      }
      if (recovery !== null) {
        if (!options.database) return recovery.payload;
        try {
          await options.database.set(name, recovery.payload);
          reportAvailable();
        } catch {
          reportDegraded();
          return recovery.payload;
        }
        const localRetired = retireAuthoritativeLocalFallback(name);
        const tombstoneCleared = await clearTombstone(name, generationFor(name), tombstoneToken);
        if (localRetired && tombstoneCleared) {
          try {
            await options.database.remove(recoveryKey(name));
            reportAvailable();
          } catch {
            reportDegraded();
          }
        }
        return recovery.payload;
      }
      const authoritativeFallback = getAuthoritativePersistFallback(localValue);
      if (authoritativeFallback !== null) {
        if (options.database) {
          try {
            await options.database.set(name, authoritativeFallback);
            reportAvailable();
            removeLegacySnapshotOnce(name);
          } catch {
            reportDegraded();
          }
        } else reportDegraded();
        return authoritativeFallback;
      }
      if (options.database) {
        try {
          const durable = await options.database.get(name);
          if (durable !== null) {
            reportAvailable();
            removeLegacySnapshotOnce(name);
            return durable;
          }
          const legacy = localValue;
          if (legacy !== null && !isDurablePointer(legacy)) {
            await options.database.set(name, legacy);
            reportAvailable();
            removeLegacySnapshotOnce(name);
            return legacy;
          }
          reportAvailable();
          return null;
        } catch {
          reportDegraded();
        }
      } else {
        reportDegraded();
      }
      const legacy = localValue;
      return isDurablePointer(legacy) ? null : legacy;
      });
    },
    setItem: (name, value) => scheduleWrite(name, () => value),
    setDeferredItem: scheduleWrite,
    removeItem: (name) => {
      const pending = pendingWrites.get(name);
      if (pending) { pendingWrites.delete(name); pending.resolvers.forEach((resolve) => resolve()); }
      generationByKey.set(name, generationFor(name) + 1);
      legacyMarkersEnsured.delete(name);
      legacySnapshotsCleaned.delete(name);
      return enqueue(name, async () => {
      const current = await getTombstoneState(name);
      const issuedAt = causalNow();
      let intentBarrierEstablished = !options.database;
      if (options.database) {
        try {
          await options.database.remove(writeIntentKey(name));
          intentBarrierEstablished = true;
          reportAvailable();
        } catch {
          reportDegraded();
        }
      }
      const operationToken = encodeClearToken(current.maxVersion + 1, issuedAt, intentBarrierEstablished);
      const localTombstone = writeTombstone(name, operationToken);
      const durableTombstone = await persistTombstone(name, operationToken);
      let candidateDeleted = !options.database;
      if (options.database) {
        try {
          await options.database.remove(name);
          reportAvailable();
        } catch {
          reportDegraded();
        }
        try {
          await options.database.remove(recoveryKey(name));
          candidateDeleted = true;
          reportAvailable();
        } catch { reportDegraded(); }
      } else {
        reportDegraded();
      }
      legacyRemove(name);
      const authorityEstablished = current.durableKnown || candidateDeleted;
      if (!authorityEstablished || !intentBarrierEstablished) {
        return { cleared: false, authority: "none" } satisfies PersistenceClearResult;
      }
      return {
        cleared: durableTombstone || localTombstone,
        authority: durableTombstone ? "durable" : localTombstone ? "local" : "none",
      } satisfies PersistenceClearResult;
      });
    },
  } as DeferredStringStorage;
}

/**
 * Zustand's typed persistence boundary. It intentionally receives the object snapshot rather than a
 * pre-stringified value, so a scan burst selects its latest snapshot before JSON encoding happens.
 */
export function createAsyncDurablePersistStorage<S>(options: AsyncDurablePersistStorageOptions): PersistStorage<S> {
  const { serialize = JSON.stringify, ...durableOptions } = options;
  const storage = createAsyncDurableStorage(durableOptions) as DeferredStringStorage;
  return {
    getItem: async (name) => {
      const raw = await storage.getItem(name);
      return raw === null ? null : JSON.parse(raw) as StorageValue<S>;
    },
    setItem: (name, snapshot) => storage.setDeferredItem(name, () => serialize(snapshot)),
    removeItem: (name) => storage.removeItem(name),
  };
}

/** Exact durable namespace probe result for a shared-browser adoption decision. */
export type PersistedStatePresence = "found" | "absent" | "unavailable";
export type DurableCreateIfAbsentResult = "created" | "exists" | "unavailable";

const createIfAbsentQueues = new WeakMap<AsyncKeyValueDatabase, Promise<void>>();

/**
 * Durable-only create-if-absent with exact readback. This deliberately bypasses the fail-soft
 * adapter: a local fallback is never authority to consume an anonymous durable namespace.
 */
export async function createDurableIfAbsentAndVerify(
  database: AsyncKeyValueDatabase,
  key: string,
  value: string,
): Promise<DurableCreateIfAbsentResult> {
  try {
    let created = false;
    const occupiedMetadataKeys = [`${key}${TOMBSTONE_SUFFIX}`, `${key}${RECOVERY_SUFFIX}`];
    if (database.createNamespaceIfAbsent) {
      created = (await database.createNamespaceIfAbsent(key, value, occupiedMetadataKeys)) === "created";
    } else if (database.createIfAbsent) {
      // A primitive that reserves only the main key cannot safely write behind a tombstone.
      if ((await Promise.all(occupiedMetadataKeys.map((metadataKey) => database.get(metadataKey)))).some((raw) => raw !== null)) {
        return "exists";
      }
      created = (await database.createIfAbsent(key, value)) === "created";
    } else {
      // Test/seam databases without a native transaction still serialize reservations per backing
      // database object. Browser production always uses the native transactional implementation.
      const prior = createIfAbsentQueues.get(database) ?? Promise.resolve();
      const reservation = prior.catch(() => undefined).then(async () => {
        if (await database.get(key) !== null) return false;
        if ((await Promise.all(occupiedMetadataKeys.map((metadataKey) => database.get(metadataKey)))).some((raw) => raw !== null)) return false;
        await database.set(key, value);
        return true;
      });
      createIfAbsentQueues.set(database, reservation.then(() => undefined, () => undefined));
      created = await reservation;
    }
    if (!created) return "exists";
    return (await database.get(key)) === value ? "created" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function getPersistedStatePresenceFromDatabase(
  name: string,
  database: AsyncKeyValueDatabase,
): Promise<PersistedStatePresence> {
  try {
    const tombstone = await database.get(`${name}${TOMBSTONE_SUFFIX}`);
    const main = await database.get(name);
    const recovery = decodeRecoveryCandidate(await database.get(`${name}${RECOVERY_SUFFIX}`));
    if (tombstone !== null) {
      if (!recovery?.supersedesTombstone) return "absent";
      const resolved = resolveNewestClearToken([tombstone, recovery.supersedesTombstone]);
      if (resolved.conflict) return "unavailable";
      return resolved.token === recovery.supersedesTombstone ? "found" : "absent";
    }
    return main !== null || recovery !== null ? "found" : "absent";
  } catch {
    return "unavailable";
  }
}

/**
 * Probe IndexedDB directly rather than through the fail-soft read adapter. The adapter rightly falls
 * back to localStorage for normal hydration, but a missing fallback must never make an inaccessible
 * durable UID namespace look absent and enable cross-account legacy adoption.
 */
export async function getPersistedStatePresence(name: string): Promise<PersistedStatePresence> {
  const database = createNativeIndexedDbDatabase();
  if (!database) return "unavailable";
  return getPersistedStatePresenceFromDatabase(name, database);
}

// Exported as a narrow test seam for the native transaction lifecycle; application callers use the
// browser-facing storage factory below.
export function createNativeIndexedDbDatabase(): AsyncKeyValueDatabase | null {
  if (typeof window === "undefined") return null;
  let indexedDb: IDBFactory;
  try {
    if (!window.indexedDB) return null;
    indexedDb = window.indexedDB;
  } catch {
    return null;
  }
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open("scanbin-persist-v1", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("scan-state")) request.result.createObjectStore("scan-state");
    };
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => { database?.close(); database = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    opening = openPromise;
    // Do not leave a rejected promise created solely by `finally` unobserved. The caller owns the
    // original openPromise and receives its failure through the normal fail-soft adapter path.
    void openPromise.then(() => { opening = null; }, () => { opening = null; });
    return openPromise;
  };
  const run = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((db) => new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("scan-state", mode);
      const request = action(transaction.objectStore("scan-state"));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    }));
  return {
    get: async (key) => {
      const value = await run("readonly", (store) => store.get(key));
      return typeof value === "string" ? value : null;
    },
    set: async (key, value) => { await run("readwrite", (store) => store.put(value, key)); },
    remove: async (key) => { await run("readwrite", (store) => store.delete(key)); },
    createIfAbsent: (key, value) => open().then((db) => new Promise<"created" | "exists">((resolve, reject) => {
      const transaction = db.transaction("scan-state", "readwrite");
      const store = transaction.objectStore("scan-state");
      const read = store.get(key);
      let created = false;
      read.onsuccess = () => {
        if (read.result !== undefined) return;
        created = true;
        const write = store.put(value, key);
        write.onerror = () => reject(write.error ?? new Error("IndexedDB create failed"));
      };
      read.onerror = () => reject(read.error ?? new Error("IndexedDB create read failed"));
      transaction.oncomplete = () => resolve(created ? "created" : "exists");
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    })),
    createNamespaceIfAbsent: (key, value, occupiedMetadataKeys) => open().then((db) => new Promise<"created" | "exists">((resolve, reject) => {
      const transaction = db.transaction("scan-state", "readwrite");
      const store = transaction.objectStore("scan-state");
      const keys = [key, ...occupiedMetadataKeys];
      let pending = keys.length;
      let occupied = false;
      let created = false;
      for (const candidate of keys) {
        const read = store.get(candidate);
        read.onsuccess = () => {
          occupied ||= read.result !== undefined;
          pending -= 1;
          if (pending !== 0 || occupied) return;
          created = true;
          const write = store.put(value, key);
          write.onerror = () => reject(write.error ?? new Error("IndexedDB namespace create failed"));
        };
        read.onerror = () => reject(read.error ?? new Error("IndexedDB namespace create read failed"));
      }
      transaction.oncomplete = () => resolve(created ? "created" : "exists");
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    })),
  };
}
