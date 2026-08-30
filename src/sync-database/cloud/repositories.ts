import {
  type Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import {
  COLLECTIONS,
  type Product,
  type Alias,
  type CatalogEntry,
  type AuditEvent,
} from "@/sync-database/types";

// Typed Firestore repositories. Business-scoped data lives in subcollections under
// /businesses/{businessId}/... so the security rules enforce tenancy from the PATH (works for get/list/
// create/update/delete; forged businessId is impossible). Dependency-injected `Firestore` instance so the
// SAME code runs in the browser app and in the emulator rules tests (authenticated contexts).

type Identified = { id: string; businessId: string };
const BIZ = COLLECTIONS.businesses;

/** CRUD for a subcollection /businesses/{businessId}/{name}. The factory binds db + businessId. */
function bizSubcollection<T extends Identified>(db: Firestore, businessId: string, name: string) {
  const colRef = () => collection(db, BIZ, businessId, name);
  const docRef = (id: string) => doc(db, BIZ, businessId, name, id);
  return {
    async list(): Promise<T[]> {
      const snap = await getDocs(colRef());
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
    },
    async get(id: string): Promise<T | null> {
      const s = await getDoc(docRef(id));
      return s.exists() ? ({ id: s.id, ...s.data() } as T) : null;
    },
    async create(item: T): Promise<void> {
      const { id, ...rest } = item;
      await setDoc(docRef(id), { ...rest, businessId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    },
    async update(id: string, patch: Partial<T>): Promise<void> {
      await updateDoc(docRef(id), { ...patch, updatedAt: serverTimestamp() });
    },
    async remove(id: string): Promise<void> {
      await deleteDoc(docRef(id));
    },
  };
}

export const productsRepository = (db: Firestore, businessId: string) => bizSubcollection<Product>(db, businessId, COLLECTIONS.products);
export const aliasesRepository = (db: Firestore, businessId: string) => bizSubcollection<Alias>(db, businessId, COLLECTIONS.aliases);

/** auditLog is append-only (create + read only) under /businesses/{businessId}/auditLog. */
export function auditRepository(db: Firestore, businessId: string) {
  return {
    async list(): Promise<AuditEvent[]> {
      const snap = await getDocs(collection(db, BIZ, businessId, COLLECTIONS.auditLog));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AuditEvent);
    },
    async append(event: AuditEvent): Promise<void> {
      const { id, ...rest } = event;
      await setDoc(doc(db, BIZ, businessId, COLLECTIONS.auditLog, id), { ...rest, businessId, createdAt: serverTimestamp() });
    },
  };
}

/** Global shared catalog: client reads only (writes are server-only via Admin SDK). */
// `collectionName` lets the same repo read the tire catalog (default `catalogEntries`) OR the SEPARATE
// retail catalog (`retailCatalogEntries`) - kept in distinct collections, never mixed.
export function catalogRepository(db: Firestore, collectionName: string = COLLECTIONS.catalogEntries) {
  return {
    async getByBarcode(normalizedBarcode: string): Promise<CatalogEntry | null> {
      const snap = await getDocs(query(collection(db, collectionName), where("normalizedBarcode", "==", normalizedBarcode)));
      const d = snap.docs[0];
      return d ? ({ id: d.id, ...d.data() } as CatalogEntry) : null;
    },
  };
}
