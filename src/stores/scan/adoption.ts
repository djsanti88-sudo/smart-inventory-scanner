import type { InventoryCount, PendingSyncItem, Product, ScanEvent, UnknownCodeReview } from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { makeQueueItem } from "@/stores/scan/queueItem";

// The ONE prefix-rewrite rule for every idempotencyKey-shaped string in this store: rewrite only the
// leading businessId segment (buildIdempotencyKey joins businessId:sessionId:...:operation with ":"),
// leaving every other segment byte-identical so retries of the exact same event keep deduping against
// the same identity. Hoisted (F-5, 2026-08-09) so rescopePlaceholderRecord and rescopePlaceholderQueueItem
// share the exact same rewrite - never duplicate this logic at a new call site.
const PLACEHOLDER_ID_PREFIX = `${DEMO_BUSINESS_ID}:`;
function rescopeKey(key: string, realBusinessId: string): string {
  return key.startsWith(PLACEHOLDER_ID_PREFIX) ? realBusinessId + key.slice(DEMO_BUSINESS_ID.length) : key;
}

// Fix #41 (data-loss race, 2026-08-06): re-point a placeholder-scoped record onto the real business
// once sign-in bootstrap resolves. Used by setBusinessContext's bootstrap-resolution branch below.
// F-5 class closure (2026-08-09): businessId was the only field rewritten here, but several entities
// also embed businessId-derived identity strings that stayed stale - ScanEvent/UnknownCodeReview/
// Alias.idempotencyKey and InventoryCount.appliedIdempotencyKeys[]. Several existing enqueue sites
// (~1792, 5341, 5361, 7137, 7519, 7683) rebuild a queue item straight from an entity's OWN stored
// idempotencyKey, and server-side reconciliation compares appliedIdempotencyKeys against _appliedKeys -
// either path would mis-dedupe (or permanently reject) if the entity's own embedded key still pointed
// at the placeholder tenant while the queue item's copy of the same key had already been rescoped.
// Generic over any embedded idempotencyKey-shaped field so every rescoped collection gets the same
// treatment from one place. Never regenerates a key: only the leading businessId segment changes.
function rescopePlaceholderRecord<T extends { businessId: string }>(entity: T, realBusinessId: string): T {
  if (entity.businessId !== DEMO_BUSINESS_ID) return entity;
  const next: T = { ...entity, businessId: realBusinessId };
  const record = next as unknown as Record<string, unknown>;
  if (typeof record.idempotencyKey === "string") {
    record.idempotencyKey = rescopeKey(record.idempotencyKey, realBusinessId);
  }
  if (Array.isArray(record.appliedIdempotencyKeys)) {
    record.appliedIdempotencyKeys = (record.appliedIdempotencyKeys as unknown[]).map((k) =>
      typeof k === "string" ? rescopeKey(k, realBusinessId) : k,
    );
  }
  return next;
}

// Same idea for a queued sync item: rewrite its own businessId, its payload's businessId (if the
// payload shape carries one), and the leading businessId segment of its idempotencyKey, reusing the
// exact same rescopeKey rewrite rescopePlaceholderRecord uses above.
// Bug fix (proven live 2026-08-09): some payload shapes (IncrementPayload for INCREMENT_COUNT,
// UnknownCodeReview for SAVE_UNKNOWN_SCAN) ALSO embed their own copy of idempotencyKey, which must
// stay byte-identical to the outer (queue item) idempotencyKey - firebaseSyncSafety.validatePendingSyncItem
// hard-rejects a mismatch as payload_idempotency_mismatch. Only the outer key was rewritten here
// before; the embedded copy kept the stale placeholder business prefix forever, so every rescoped
// INCREMENT_COUNT item was permanently rejected by the server and never synced. Rescope the embedded
// key with the exact same prefix-rewrite rule as the outer key so outer === payload after adoption.
function rescopePlaceholderQueueItem(item: PendingSyncItem, realBusinessId: string): PendingSyncItem {
  if (item.businessId !== DEMO_BUSINESS_ID) return item;
  const payload = item.payload;
  const rescopedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (() => {
          const record = payload as Record<string, unknown>;
          const next: Record<string, unknown> = { ...record };
          if ("businessId" in record) next.businessId = realBusinessId;
          if (typeof record.idempotencyKey === "string") next.idempotencyKey = rescopeKey(record.idempotencyKey, realBusinessId);
          if (Array.isArray(record.appliedIdempotencyKeys)) {
            next.appliedIdempotencyKeys = (record.appliedIdempotencyKeys as unknown[]).map((k) =>
              typeof k === "string" ? rescopeKey(k, realBusinessId) : k,
            );
          }
          return next;
        })()
      : payload;
  const idempotencyKey = rescopeKey(item.idempotencyKey, realBusinessId);
  return { ...item, businessId: realBusinessId, payload: rescopedPayload, idempotencyKey };
}

// ADOPTION RE-SYNC (verified live on the Firebase emulator, 2026-08-09 - proof in
// e2e/proof/adopt-emulator-spotcheck/): the pre-auth cohort's anonymous session ran against the MOCK
// backend, which marks every local write "synced" the instant it is applied and leaves
// pendingSyncQueue EMPTY. When that blob is adopted into a signed-in LIVE Firebase account, the
// bootstrap-resolution branch below re-scopes the rows correctly but there is nothing left in the
// queue to re-scope, so the real cloud sync engine never pushes the adopted rows: local total 4,
// Firestore holds only the 1 post-sign-in scan, and the UI honestly reports "All saved: 0". A silent
// local-vs-cloud divergence.
//
// So adoption must REBUILD the sync work those adopted entities would have enqueued had they been
// scanned under the live tenant. Two rules make this safe:
//  1. Reuse each entity's OWN (already-rescoped) idempotencyKey - never regenerate one. Server-side
//     `_appliedKeys` dedupe then swallows anything that genuinely HAD reached THIS backend before, so
//     re-enqueueing can never double-count. Re-sending is idempotent BY DESIGN; not re-sending is
//     unrecoverable data loss.
//  2. Skip any key already present in the queue, so the ordinary fix-#41 shape (nothing drained yet,
//     every write still queued under the placeholder) only gets re-scoped, never duplicated.
// The rebuilt set mirrors exactly what the live scan path enqueues: SAVE_SCAN_EVENT + INCREMENT_COUNT
// per counted event (processScan ~3147-3170), SAVE_UNKNOWN_SCAN per open review, and the provisional
// SAVE_PRODUCT that ensureProvisionalCount mints (~5467). Catalog/seed products and sessions are NOT
// pushed - a live scan of a known catalog product does not push the product either.
function buildAdoptionResyncItems(params: {
  businessId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  products: Product[];
  existingQueue: PendingSyncItem[];
  adoptedEventIds: Set<string>;
  adoptedReviewIds: Set<string>;
  idFactory: () => string;
  now: () => string;
}): PendingSyncItem[] {
  const { businessId, idFactory, now } = params;
  const seenKeys = new Set(params.existingQueue.map((item) => item.idempotencyKey));
  const items: PendingSyncItem[] = [];
  const push = (item: PendingSyncItem) => {
    if (seenKeys.has(item.idempotencyKey)) return;
    seenKeys.add(item.idempotencyKey);
    items.push(item);
  };
  const provisionalById = new Map(
    params.products.filter((p) => p.provisional === true).map((p) => [p.id, p]),
  );
  const pushedProductIds = new Set<string>();

  for (const event of params.scanFeed) {
    if (!params.adoptedEventIds.has(event.id) || !event.idempotencyKey) continue;
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: event.sessionId,
        entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: event,
        // Deterministic reconstruction of the key the scan path mints for this same event id
        // (buildIdempotencyKey(businessId, sessionId, eventId, "SAVE_SCAN_EVENT")). SAVE_SCAN_EVENT is
        // an upsert-by-id with no counting semantics, so even a key that differs from the original
        // (e.g. a `:transfer:`-suffixed one) can only rewrite the same document, never add a count.
        idempotencyKey: buildIdempotencyKey(businessId, event.sessionId, event.id, "SAVE_SCAN_EVENT"),
        scanEventId: event.id,
      }),
    );
    const productId = event.matchedProductId;
    if (!productId || event.quantityDelta <= 0) continue;
    const count = params.finalCounts.find(
      (c) => c.productId === productId && c.sessionId === event.sessionId,
    );
    if (!count) continue;
    const provisional = provisionalById.get(productId);
    if (provisional && !pushedProductIds.has(productId)) {
      pushedProductIds.add(productId);
      push(
        makeQueueItem({
          idFactory, now, businessId, sessionId: event.sessionId,
          entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: provisional,
          idempotencyKey: buildIdempotencyKey(businessId, event.sessionId, `${productId}:provisional`, "SAVE_PRODUCT"),
          scanEventId: null,
        }),
      );
    }
    const incPayload: IncrementPayload = {
      businessId,
      sessionId: event.sessionId,
      productId,
      scanEventId: event.id,
      quantityDelta: event.quantityDelta,
      // The event's OWN counting key, verbatim (its INCREMENT_COUNT identity since it was minted).
      idempotencyKey: event.idempotencyKey,
    };
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: event.sessionId,
        entityType: "InventoryCount", entityId: count.id, operation: "INCREMENT_COUNT", payload: incPayload,
        idempotencyKey: event.idempotencyKey, scanEventId: event.id,
      }),
    );
  }

  for (const review of params.needsReviewQueue) {
    if (!params.adoptedReviewIds.has(review.id) || !review.idempotencyKey) continue;
    push(
      makeQueueItem({
        idFactory, now, businessId, sessionId: review.sessionId,
        entityType: "UnknownCodeReview", entityId: review.id, operation: "SAVE_UNKNOWN_SCAN", payload: review,
        idempotencyKey: review.idempotencyKey, scanEventId: null,
      }),
    );
  }

  return items;
}
export { buildAdoptionResyncItems, rescopeKey, rescopePlaceholderQueueItem, rescopePlaceholderRecord };
