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

/**
 * Read a business's products, aliases, count sessions, and count lines from Firestore, mapped to the
 * local store shapes. The store uses sessions/counts to reconstruct the active session + finalCounts
 * after a refresh (survive-refresh). RLS scopes every read to members of `businessId`.
 */
export async function loadBusinessData(db: Firestore, businessId: string): Promise<LoadedBusinessData> {
  const [psnap, asnap, ssnap, csnap] = await Promise.all([
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.products)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.aliases)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.countSessions)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.inventoryCounts)),
  ]);
  const sessions = ssnap.docs.map((d) => toStoreSession(d.id, d.data() as Record<string, unknown>, businessId));
  const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  const restored = [...sessions].sort(byStartedAtDesc).find((s) => s.status === "active") ?? [...sessions].sort(byStartedAtDesc)[0] ?? null;
  const esnap = restored
    ? await getDocs(
        query(
          collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.scanEvents),
          where("sessionId", "==", restored.id),
          orderBy("createdAt", "asc"),
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
