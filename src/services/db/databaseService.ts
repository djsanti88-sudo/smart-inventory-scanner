// Everything the scan core needs from a durable backend, in one named contract.
//
// This port was not invented for this refactor - it was EXTRACTED. `ScanStoreDeps` in
// src/stores/scanStore.ts has always been a real dependency-injection seam with two implementations
// (MockDb locally, Firebase in the cloud). The problem was where it lived: the persistence contract
// for the whole application was buried inside a 9,000-line store file, interleaved with concerns that
// have nothing to do with storage (an id factory, a clock, a persistence key name).
//
// Splitting it means "what would a new backend have to provide?" is answerable by reading one small
// file. ScanStoreDeps now extends this, so the two cannot drift: adding a storage capability to the
// store without declaring it here is a type error.
//
// Every capability except `db` is OPTIONAL, and that is a load-bearing property, not laziness. The
// local mock backend supplies none of them, and the app is fully usable that way: scanning, counting
// and review all work with nothing but a write target. A backend that cannot load remote business
// data, cannot audit, and has no shared catalog degrades - it does not fail.

import type { SyncTarget } from "@/services/db/syncTarget";
import type { Product, Alias, InventorySession, InventoryCount, ScanEvent, UnknownCodeReview } from "@/types";
import type { CatalogEntry } from "@/services/catalog/catalogTypes";
import type { AuditEventInput } from "@/services/audit/audit";

/** A business's persisted state, as the local store models it. */
export interface LoadedBusinessData {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  counts: InventoryCount[];
  scanEvents?: ScanEvent[];
  reviews?: UnknownCodeReview[];
}

export interface DatabaseService {
  /**
   * The durable write target. Required: it is the only member without a working fallback, because
   * every scan must reach durable storage eventually. Writes are idempotency-keyed and applied
   * once, so any number of retries can never double-count.
   */
  db: SyncTarget;

  /**
   * True when `db` talks to a remote backend. Selects the asynchronous drain and requires a real
   * business context (businessId + userId) before any write.
   */
  cloudBackend?: boolean;

  /** Authenticated remote backends may probe the server-only trusted-exact corpus even when paid AI is off. */
  trustedExactProbeEnabled?: boolean;

  /**
   * Rehydrate a business from the backend so the deterministic resolver has its products and aliases,
   * and the active session plus its counts survive a refresh or a fresh device. Absent on backends
   * whose state is already local.
   */
  loadBusinessData?: (businessId: string, userId: string) => Promise<LoadedBusinessData>;

  /**
   * Fire-and-forget audit sink. Must never throw into the scanner path - an audit failure may not
   * cost the user a scan (TOP-LEVEL LAW). Absent means auditing is a no-op.
   */
  audit?: (event: AuditEventInput) => void;

  /**
   * Look up candidate codes in the shared cross-business catalog; the first verified entry wins.
   * Absent means the step is skipped and the scan falls through to decode or Needs Review.
   */
  lookupGlobalCatalog?: (codes: string[]) => Promise<CatalogEntry | null>;
}
