// Provider-neutral data-access ports.
//
// The concrete implementations in ./firebase/ already spoke in neutral domain shapes (Product, Alias,
// CatalogEntry, ScanEvent from ./types) - what was missing was any statement of the CONTRACT
// independent of Firestore. Without it, "what does this app need from a database?" could only be
// answered by reading the Firestore code and mentally subtracting the vendor.
//
// These are TYPES ONLY - same approach as @/authentication/service/authService, for the same reason: a runtime
// registry with exactly one implementation is indirection nobody can follow. Conformance is proved by
// ./repositories.contract.test.ts, which fails `tsc --noEmit` if an implementation drifts.
//
// Where a port is narrower than its Firestore implementation, that is deliberate. CatalogRepository
// declares only getByBarcode because that is the only catalog operation the client performs; catalog
// WRITES are server-side through the Admin SDK and are not part of this surface.

import type { Product, Alias, CatalogEntry, AuditEvent } from "@/sync-database/types";
// NOT ./types's ScanEvent. This codebase carries TWO ScanEvent shapes: the persisted Firestore
// document (./types, `matchedProductId?: string`) and the in-store event (@/types,
// `matchedProductId: string | null`), converted by ./firebase/storeMappers. The session read side
// hands back the STORE shape - it feeds the timeline and the count rebuild directly - so that is what
// this port declares. Writing the other one here compiles into a lie the mappers then have to
// contradict. (The duplication itself is pre-existing debt, recorded in docs/ARCHITECTURE.md.)
import type { ScanEvent } from "@/types";

/**
 * The CRUD shape shared by the business-scoped collections. Implementations are expected to be
 * pre-bound to one business: tenancy is not a parameter here, because passing a businessId per call
 * is exactly the mistake that lets one leak. The Firestore implementation binds it into the document
 * path, so a forged id cannot reach another tenant's data.
 */
export interface CrudRepository<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  create(item: T): Promise<void>;
  update(id: string, patch: Partial<T>): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Products for one business - the identities a scan resolves to and counts accumulate against. */
export type InventoryRepository = CrudRepository<Product>;

/**
 * Barcode-to-product aliases for one business: the many-codes-to-one-product table that makes
 * resolution deterministic. Every code here is TEXT, never a number - numeric coercion drops leading
 * zeros and corrupts long GTINs, which is a data-corruption bug at every layer of this app.
 */
export type BarcodeRepository = CrudRepository<Alias>;

/**
 * The shared cross-business catalog. Read-only from the client by design: writes go through the
 * server's moderated append path, so one shop can never publish identity to every other shop.
 */
export interface CatalogRepository {
  getByBarcode(normalizedBarcode: string): Promise<CatalogEntry | null>;
}

/**
 * Append-only audit trail for one business. No update, no remove: an audit log that can be edited is
 * not an audit log.
 */
export interface AuditRepository {
  list(): Promise<AuditEvent[]>;
  append(event: AuditEvent): Promise<void>;
}

/**
 * Read side of a counting session's scan history, oldest first - the source of a session timeline and
 * of counts rebuilt from events.
 *
 * Optional on the write target (see SyncTarget) because it was added after the write-only interface
 * shipped; callers feature-detect it rather than assume it.
 */
export interface ScanSessionRepository {
  getScanEventsBySession(businessId: string, sessionId: string): Promise<ScanEvent[]>;
}
