import { type Firestore, collection, getDocs, orderBy, query, where } from "firebase/firestore";
import type { Product, Alias, InventorySession, InventoryCount, ScanEvent, UnknownCodeReview } from "@/types";
import { COLLECTIONS } from "@/sync-database/types";
import {
  toStoreProduct,
  toStoreAlias,
  toStoreSession,
  toStoreCount,
  toStoreScanEvent,
  toStoreUnknownCodeReview,
} from "./storeMappers";
import { retryingRead, READ_ATTEMPT_TIMEOUT_MS, READ_MAX_ATTEMPTS, READ_RETRY_BACKOFF_MS } from "./boundedRead";

// Loads a business's persisted data from Firestore into the shapes the local store uses, so the
// deterministic resolver sees products/aliases after a refresh or on a fresh device, and the active
// count session + its counts are reconstructed (survive-refresh). The pure doc->store mappers live in
// `storeMappers.ts` (no client Firebase SDK) so they can also be used by the server API route without
// bundling firebase/firestore into the serverless function. RLS scopes reads to members of `businessId`.

export interface LoadedBusinessData {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  counts: InventoryCount[];
  scanEvents: ScanEvent[];
  reviews: UnknownCodeReview[];
}

// One-shot getDocs() reads have NO built-in retry (unlike onSnapshot, which keeps listening after a
// transport error). If the transport channel errors mid-request (observed: emulator channel 400s;
// equally possible on real networks going through a flaky connection), the returned promise can hang
// forever with nothing thrown - the caller (loadBusinessData -> scanStore.setBusinessContext ->
// BusinessContextGate) then waits on "Loading business data..." with no timeout and no way to recover
// short of a full reload. The bounded retry itself lives in ./boundedRead.ts (shared with
// lib/auth.ts's listMemberships, the other Firestore read reachable from the fresh-device bootstrap
// chain). Re-exported here under the loader's original names for back-compat with existing importers
// (this module's own tests included).
export {
  READ_ATTEMPT_TIMEOUT_MS as LOAD_ATTEMPT_TIMEOUT_MS,
  READ_MAX_ATTEMPTS as LOAD_MAX_ATTEMPTS,
} from "./boundedRead";

/**
 * Read a business's products, aliases, count sessions, count lines, and review queue from Firestore,
 * mapped to the local store shapes. The store uses sessions/counts/events to reconstruct the active
 * session and its visible history after a refresh. RLS scopes every read to members of `businessId`.
 *
 * Every getDocs() read is wrapped in a bounded-attempt retry (LOAD_ATTEMPT_TIMEOUT_MS per attempt, up
 * to LOAD_MAX_ATTEMPTS) so a stuck transport channel rejects instead of hanging forever - see the retry
 * helpers above. On exhausted retries this rejects with a clear error; the caller (scanStore) already
 * surfaces that as `lastSyncError` and unblocks `businessDataLoaded`.
 */
export async function loadBusinessData(db: Firestore, businessId: string): Promise<LoadedBusinessData> {
  const [psnap, asnap, ssnap, csnap, rsnap] = await Promise.all([
    retryingRead("products", () => getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.products))),
    retryingRead("aliases", () => getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.aliases))),
    retryingRead("count sessions", () =>
      getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.countSessions)),
    ),
    retryingRead("inventory counts", () =>
      getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.inventoryCounts)),
    ),
    retryingRead("unknown code reviews", () =>
      getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.unknownCodeReviews)),
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
    reviews: rsnap.docs.map((d) => toStoreUnknownCodeReview(d.id, d.data() as Record<string, unknown>, businessId)),
  };
}
