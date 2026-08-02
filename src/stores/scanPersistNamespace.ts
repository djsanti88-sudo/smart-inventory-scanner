// Per-uid persist namespacing for the scan store. The anon/mock path keeps the legacy global key
// "sis-scan-v1" byte-for-byte so demos and every existing test are unaffected; a signed-in user gets
// their own "sis-scan-<uid>" key so two users on one browser never share persisted state.

import type { StateStorage } from "zustand/middleware";
import {
  createDurableIfAbsentAndVerify,
  createAsyncDurableStorage,
  createNativeIndexedDbDatabase,
  getPersistedStatePresenceFromDatabase,
  type AsyncKeyValueDatabase,
  type PersistedStatePresence,
} from "./scanPersistStorage";

const LEGACY_KEY = "sis-scan-v1";
const LOCAL_DEMO_KEY = "sis-local-demo-scan-v1";

// One in-tab linearization point for durable adoption and destructive store operations.
// It is intentionally transient: IndexedDB remains the cross-tab authority.
let persistenceMutationBarrier: symbol | null = null;
export function tryAcquirePersistenceMutationBarrier(): symbol | null {
  if (persistenceMutationBarrier) return null;
  const token = Symbol("scan-persist-mutation");
  persistenceMutationBarrier = token;
  return token;
}
export function releasePersistenceMutationBarrier(token: symbol): void {
  if (persistenceMutationBarrier === token) persistenceMutationBarrier = null;
}
export function ownsPersistenceMutationBarrier(token: symbol): boolean {
  return persistenceMutationBarrier === token;
}

export type LegacyAdoptionResult =
  | { status: "adopted" }
  | { status: "absent" }
  | { status: "target-exists" }
  | { status: "unavailable" }
  | { status: "invalid" };

type LegacyAdoptionOperations = {
  inspect: () => Promise<PersistedStatePresence>;
  adopt: (uid: string) => Promise<LegacyAdoptionResult>;
};

/** Narrow test seam: production creates one adapter backed by the browser's IndexedDB authority. */
export type LegacyAdoptionOptions = {
  database: AsyncKeyValueDatabase;
  createStorage: () => StateStorage;
  getPresence: (name: string) => Promise<PersistedStatePresence>;
  isLocalDemo?: () => boolean;
};

function isLocalDemoPersistence(): boolean {
  return process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
}

function isMeaningfulLegacySnapshot(parsed: unknown): boolean {
  const state = (parsed as { state?: { scanFeed?: unknown[]; finalCounts?: unknown[]; needsReviewQueue?: unknown[] } })?.state;
  return (Array.isArray(state?.scanFeed) && state.scanFeed.length > 0)
    || (Array.isArray(state?.finalCounts) && state.finalCounts.length > 0)
    || (Array.isArray(state?.needsReviewQueue) && state.needsReviewQueue.length > 0);
}

function normalizeLegacySnapshot(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isMeaningfulLegacySnapshot(parsed)) return null;
  const feed = (parsed as { state?: { scanFeed?: Array<{ quantityDelta?: number }> } }).state?.scanFeed;
  if (Array.isArray(feed)) {
    for (const row of feed) {
      if (row && row.quantityDelta === 0) row.quantityDelta = 1;
    }
  }
  return JSON.stringify(parsed);
}

export function createLegacyAdoptionOperations(options: LegacyAdoptionOptions): LegacyAdoptionOperations {
  const localDemo = options.isLocalDemo ?? isLocalDemoPersistence;
  const inFlight = new Map<string, Promise<LegacyAdoptionResult>>();
  const inspect = async (): Promise<PersistedStatePresence> => {
    if (localDemo()) return "absent";
    return options.getPresence(LEGACY_KEY);
  };
  const adopt = (uid: string): Promise<LegacyAdoptionResult> => {
    if (localDemo()) return Promise.resolve({ status: "absent" });
    const existing = inFlight.get(uid);
    if (existing) return existing;
    const operation = (async (): Promise<LegacyAdoptionResult> => {
      const barrier = tryAcquirePersistenceMutationBarrier();
      if (!barrier) return { status: "target-exists" };
      try {
      const sourcePresence = await inspect();
      if (sourcePresence === "unavailable") return { status: "unavailable" };
      if (sourcePresence === "absent") return { status: "absent" };
      const targetKey = persistKeyForUid(uid);
      if (targetKey === LEGACY_KEY) return { status: "invalid" };
      const storage = options.createStorage();
      let raw: string | null;
      try {
        raw = await storage.getItem(LEGACY_KEY);
      } catch {
        return { status: "unavailable" };
      }
      if (raw === null) return (await inspect()) === "unavailable" ? { status: "unavailable" } : { status: "absent" };
      const normalized = normalizeLegacySnapshot(raw);
      if (normalized === null) return { status: "invalid" };
      try {
        const reservation = await createDurableIfAbsentAndVerify(options.database, targetKey, normalized);
        if (reservation === "exists") return { status: "target-exists" };
        if (reservation !== "created") return { status: "unavailable" };
        if (await options.getPresence(targetKey) !== "found" || await options.database.get(targetKey) !== normalized) {
          return { status: "unavailable" };
        }
        // A destructive operation may have won after a delayed reservation. Never consume
        // anonymous source unless this adoption still owns the shared linearization point.
        if (!ownsPersistenceMutationBarrier(barrier)) return { status: "unavailable" };
        await storage.removeItem(LEGACY_KEY);
        if (await storage.getItem(LEGACY_KEY) !== null || await inspect() !== "absent") return { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
      return { status: "adopted" };
      } finally {
        releasePersistenceMutationBarrier(barrier);
      }
    })();
    inFlight.set(uid, operation);
    void operation.finally(() => inFlight.delete(uid));
    return operation;
  };
  return { inspect, adopt };
}

let browserLegacyAdoptionOperations: LegacyAdoptionOperations | null = null;

function getBrowserLegacyAdoptionOperations(): LegacyAdoptionOperations | null {
  if (browserLegacyAdoptionOperations) return browserLegacyAdoptionOperations;
  const database: AsyncKeyValueDatabase | null = createNativeIndexedDbDatabase();
  if (!database) return null;
  browserLegacyAdoptionOperations = createLegacyAdoptionOperations({
    database,
    createStorage: () => createAsyncDurableStorage({
      database,
      getLegacyStorage: () => {
        try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
      },
    }),
    getPresence: (name) => getPersistedStatePresenceFromDatabase(name, database),
  });
  return browserLegacyAdoptionOperations;
}

export async function inspectLegacyAdoptionCandidate(): Promise<PersistedStatePresence> {
  if (isLocalDemoPersistence()) return "absent";
  return getBrowserLegacyAdoptionOperations()?.inspect() ?? "unavailable";
}

export async function adoptLegacyPersistedState(uid: string): Promise<LegacyAdoptionResult> {
  if (isLocalDemoPersistence()) return { status: "absent" };
  return (await getBrowserLegacyAdoptionOperations()?.adopt(uid)) ?? { status: "unavailable" };
}

export function persistKeyForUid(uid: string | null): string {
  // The local demo shares a browser with normal shop sessions. It must never hydrate, overwrite,
  // or offer to adopt their global/uid-namespaced state, so the demo has one separate namespace.
  if (isLocalDemoPersistence()) return LOCAL_DEMO_KEY;
  return uid ? `sis-scan-${uid}` : LEGACY_KEY;
}
