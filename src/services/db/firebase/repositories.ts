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
  memberDocId,
  type Business,
  type BusinessMember,
  type UserProfile,
  type Product,
  type Alias,
  type ScanEvent,
  type CountSession,
  type InventoryCountLine,
  type UnknownCodeReview,
  type Settings,
  type CatalogEntry,
  type ShopOverride,
  type AuditEvent,
} from "@/services/db/types";

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
export const scanEventsRepository = (db: Firestore, businessId: string) => bizSubcollection<ScanEvent>(db, businessId, COLLECTIONS.scanEvents);
export const countSessionsRepository = (db: Firestore, businessId: string) => bizSubcollection<CountSession>(db, businessId, COLLECTIONS.countSessions);
export const inventoryCountsRepository = (db: Firestore, businessId: string) => bizSubcollection<InventoryCountLine>(db, businessId, COLLECTIONS.inventoryCounts);
export const unknownReviewsRepository = (db: Firestore, businessId: string) => bizSubcollection<UnknownCodeReview>(db, businessId, COLLECTIONS.unknownCodeReviews);
export const settingsRepository = (db: Firestore, businessId: string) => bizSubcollection<Settings>(db, businessId, COLLECTIONS.settings);
export const shopOverridesRepository = (db: Firestore, businessId: string) => bizSubcollection<ShopOverride>(db, businessId, COLLECTIONS.shopOverrides);

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

export function businessesRepository(db: Firestore) {
  return {
    async get(id: string): Promise<Business | null> {
      const s = await getDoc(doc(db, BIZ, id));
      return s.exists() ? ({ id: s.id, ...s.data() } as Business) : null;
    },
    async create(business: Business): Promise<void> {
      const { id, ...rest } = business;
      await setDoc(doc(db, BIZ, id), { ...rest, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    },
  };
}

export function membersRepository(db: Firestore) {
  return {
    async get(businessId: string, userId: string): Promise<BusinessMember | null> {
      const s = await getDoc(doc(db, COLLECTIONS.businessMembers, memberDocId(businessId, userId)));
      return s.exists() ? ({ id: s.id, ...s.data() } as BusinessMember) : null;
    },
    async listForBusiness(businessId: string): Promise<BusinessMember[]> {
      const snap = await getDocs(query(collection(db, COLLECTIONS.businessMembers), where("businessId", "==", businessId)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BusinessMember);
    },
    async listMine(userId: string): Promise<BusinessMember[]> {
      const snap = await getDocs(query(collection(db, COLLECTIONS.businessMembers), where("userId", "==", userId)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BusinessMember);
    },
    async add(member: Omit<BusinessMember, "id">): Promise<void> {
      const id = memberDocId(member.businessId, member.userId);
      await setDoc(doc(db, COLLECTIONS.businessMembers, id), { ...member, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    },
    async setRole(businessId: string, userId: string, role: BusinessMember["role"]): Promise<void> {
      await updateDoc(doc(db, COLLECTIONS.businessMembers, memberDocId(businessId, userId)), { role, updatedAt: serverTimestamp() });
    },
  };
}

export function userProfilesRepository(db: Firestore) {
  return {
    async get(uid: string): Promise<UserProfile | null> {
      const s = await getDoc(doc(db, COLLECTIONS.userProfiles, uid));
      return s.exists() ? ({ id: s.id, ...s.data() } as UserProfile) : null;
    },
    async upsert(profile: UserProfile): Promise<void> {
      const { id, ...rest } = profile;
      await setDoc(doc(db, COLLECTIONS.userProfiles, id), { ...rest, updatedAt: serverTimestamp() }, { merge: true });
    },
  };
}

/** Global shared catalog: client reads only (writes are server-only via Admin SDK). */
export function catalogRepository(db: Firestore) {
  return {
    async getByBarcode(normalizedBarcode: string): Promise<CatalogEntry | null> {
      const snap = await getDocs(query(collection(db, COLLECTIONS.catalogEntries), where("normalizedBarcode", "==", normalizedBarcode)));
      const d = snap.docs[0];
      return d ? ({ id: d.id, ...d.data() } as CatalogEntry) : null;
    },
  };
}
