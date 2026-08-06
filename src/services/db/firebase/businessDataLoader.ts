import { type Firestore, collection, getDocs, orderBy, query, where } from "firebase/firestore";
import type { Product, Alias, InventorySession, InventoryCount, ScanEvent } from "@/types";
import { COLLECTIONS } from "@/services/db/types";
import { toStoreProduct, toStoreAlias, toStoreSession, toStoreCount, toStoreScanEvent } from "./storeMappers";

// Loads a business's persisted data from Firestore into the shapes the local store uses, so the
// deterministic resolver sees products/aliases after a refresh or on a fresh device, and the active
// count session + its counts are reconstructed (survive-refresh). The pure doc->store mappers live in
// `storeMappers.ts` (no client Firebase SDK) so they can also be used by the server API route without
// bundling firebase/firestore into the serverless function. RLS scopes reads to members of `businessId`.

// Re-exported for back-compat with existing importers; the canonical home is ./storeMappers.
export { toStoreProduct, toStoreAlias, toStoreSession, toStoreCount, toStoreScanEvent } from "./storeMappers";

export interface LoadedBusinessData {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  counts: InventoryCount[];
  scanEvents: ScanEvent[];
}

// One-shot getDocs() reads have NO built-in retry (unlike onSnapshot, which keeps listening after a
// transport error). If the transport channel errors mid-request (observed: emulator channel 400s;
// equally possible on real networks going through a flaky connection), the returned promise can hang
// forever with nothing thrown - the caller (loadBusinessData -> scanStore.setBusinessContext ->
// BusinessContextGate) then waits on "Loading business data..." with no timeout and no way to recover
// short of a full reload. These constants bound every getDocs read in this file so a stuck transport
// always surfaces as an honest rejection instead of an infinite silent hang.
export const LOAD_ATTEMPT_TIMEOUT_MS = 20_000;
export const LOAD_MAX_ATTEMPTS = 3;
export const LOAD_RETRY_BACKOFF_MS = 500;

// Races a fresh attempt against a per-attempt timeout. A timed-out attempt's underlying promise is
// abandoned (not cancelled - Firestore gives no cancel handle), so if it settles later it is ignored:
// `settled` guarantees only the winner (timeout vs the real settle, whichever comes first) ever resolves
// or rejects this wrapper, so a late straggler can never double-apply a result.
function withAttemptTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out loading ${label} after ${ms}ms.`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Bounded-attempt retry for a single Firestore read. `factory` must issue a FRESH getDocs() call on
// each attempt (never reuse a prior attempt's promise) since a timed-out attempt is abandoned, not
// cancelled. Reads are idempotent, so re-issuing is safe. Rejects with a clear error only after every
// attempt has failed or timed out.
async function retryingRead<T>(label: string, factory: () => Promise<T>, attempts = LOAD_MAX_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withAttemptTimeout(factory(), LOAD_ATTEMPT_TIMEOUT_MS, label);
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_BACKOFF_MS * attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to load ${label} after ${attempts} attempts.`);
}

/**
 * Read a business's products, aliases, count sessions, and count lines from Firestore, mapped to the
 * local store shapes. The store uses sessions/counts to reconstruct the active session + finalCounts
 * after a refresh (survive-refresh). RLS scopes every read to members of `businessId`.
 *
 * Every getDocs() read is wrapped in a bounded-attempt retry (LOAD_ATTEMPT_TIMEOUT_MS per attempt, up
 * to LOAD_MAX_ATTEMPTS) so a stuck transport channel rejects instead of hanging forever - see the retry
 * helpers above. On exhausted retries this rejects with a clear error; the caller (scanStore) already
 * surfaces that as `lastSyncError` and unblocks `businessDataLoaded`.
 */
export async function loadBusinessData(db: Firestore, businessId: string): Promise<LoadedBusinessData> {
  const [psnap, asnap, ssnap, csnap] = await Promise.all([
    retryingRead("products", () => getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.products))),
    retryingRead("aliases", () => getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.aliases))),
    retryingRead("count sessions", () =>
      getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.countSessions)),
    ),
    retryingRead("inventory counts", () =>
      getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.inventoryCounts)),
    ),
  ]);
  const sessions = ssnap.docs.map((d) => toStoreSession(d.id, d.data() as Record<string, unknown>, businessId));
  const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  const restored = [...sessions].sort(byStartedAtDesc).find((s) => s.status === "active") ?? [...sessions].sort(byStartedAtDesc)[0] ?? null;
  const esnap = restored
    ? await retryingRead("scan events", () =>
        getDocs(
          query(
            collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.scanEvents),
            where("sessionId", "==", restored.id),
            orderBy("createdAt", "asc"),
          ),
        ),
      )
    : null;
  return {
    products: psnap.docs.map((d) => toStoreProduct(d.id, d.data() as Record<string, unknown>, businessId)),
    aliases: asnap.docs.map((d) => toStoreAlias(d.id, d.data() as Record<string, unknown>, businessId)),
    sessions,
    counts: csnap.docs.map((d) => toStoreCount(d.id, d.data() as Record<string, unknown>, businessId)),
    scanEvents: esnap?.docs.map((d) => toStoreScanEvent(d.id, d.data() as Record<string, unknown>, businessId)) ?? [],
  };
}
