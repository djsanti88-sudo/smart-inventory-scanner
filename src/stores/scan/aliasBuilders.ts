import type { Alias, InventoryCount, PendingSyncItem, Product, ScanEvent } from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { normalizeCode } from "@/scanning/clean/codeNormalizer";
import { detectCodeType, codeTypeToAliasType } from "@/products/match/codeTypeDetector";
import { makeQueueItem } from "@/stores/scan/queueItem";

// F-03 (audit remediation 2026-07-29): transferOrphanCount above is PURE local-state math - it never
// enqueues a sync op, so an orphan merge that mutates finalCounts locally leaves the backend holding
// the old (oid) InventoryCount row forever. The next refreshFromCloud/second-device load re-adds it
// ALONGSIDE the repointed target row, silently doubling the quantity - the same class of bug
// deleteProductsInternal's "SYNC THE REPOINT" fix (reviewed defect 2026-07-22, ~:6809) already closed
// for product deletes. Mirror that EXACT balanced-pair pattern here: a zero-out INCREMENT_COUNT on the
// orphan's identity plus a re-add INCREMENT_COUNT on the target's identity, per affected session row,
// both using FRESH per-transfer idempotency keys (never the original counting key) so the Firestore
// applied-key dedupe cannot reject the corrected write as an idempotency_conflict (the FirebaseSyncTarget
// marker's targetId is derived from the payload's own productId, so reusing an old counting key that was
// stamped against a different productId's marker collides). Called by every transferOrphanCount call
// site with the counts snapshot from BEFORE the transfer (so the moved quantity/session/count-id are
// still visible), immediately followed by transferOrphanCount itself for the local state update. The
// affected ScanEvents are also durably re-pointed with fresh SAVE_SCAN_EVENT keys: a cloud reload must
// not retain their former identity even though the count pair itself has already balanced quantity.
function buildOrphanTransferSyncOps(params: {
  finalCountsBeforeTransfer: InventoryCount[];
  scanFeedBeforeTransfer: ScanEvent[];
  oid: string;
  targetId: string;
  businessId: string;
  idFactory: () => string;
  now: () => string;
}): PendingSyncItem[] {
  const { finalCountsBeforeTransfer, scanFeedBeforeTransfer, oid, targetId, businessId, idFactory, now } = params;
  const ops: PendingSyncItem[] = [];
  for (const c of finalCountsBeforeTransfer) {
    if (c.productId !== oid || c.quantity <= 0) continue;
    const outKey = buildIdempotencyKey(businessId, c.sessionId, `${c.id}:orphan-transfer-out`, "INCREMENT_COUNT");
    const outPayload: IncrementPayload = {
      businessId,
      sessionId: c.sessionId,
      productId: oid,
      scanEventId: `${c.id}:orphan-transfer`,
      quantityDelta: -c.quantity,
      idempotencyKey: outKey,
    };
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
    );
    const inKey = buildIdempotencyKey(businessId, c.sessionId, `${c.id}:orphan-transfer-in`, "INCREMENT_COUNT");
    const inPayload: IncrementPayload = {
      businessId,
      sessionId: c.sessionId,
      productId: targetId,
      scanEventId: `${c.id}:orphan-transfer`,
      quantityDelta: c.quantity,
      idempotencyKey: inKey,
    };
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
    );
  }
  for (const event of scanFeedBeforeTransfer) {
    if (event.matchedProductId !== oid) continue;
    const repointedEvent: ScanEvent = { ...event, matchedProductId: targetId };
    const saveKey = buildIdempotencyKey(
      businessId,
      event.sessionId,
      `${event.id}:orphan-transfer:${targetId}`,
      "SAVE_SCAN_EVENT",
    );
    ops.push(
      makeQueueItem({ idFactory, now, businessId, sessionId: event.sessionId, entityType: "ScanEvent", entityId: event.id, operation: "SAVE_SCAN_EVENT", payload: repointedEvent, idempotencyKey: saveKey, scanEventId: event.id }),
    );
  }
  return ops;
}

/**
 * Multi-code: build an APPROVED alias for every OTHER scannable code on a product (part number / SKU /
 * GTIN / UPC / EAN / vendor codes), beyond the code(s) already aliased. This is what makes a tire's
 * barcode AND its part-number QR both resolve to the same product. Pure builder; caller commits to state.
 */
function buildProductCodeAliases(params: {
  product: Product;
  alreadyAliasedCleanCodes: string[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
}): { aliases: Alias[]; queued: PendingSyncItem[] } {
  const { product, alreadyAliasedCleanCodes, businessId, sessionId, idFactory, now } = params;
  const rawCodes = [
    product.primaryBarcode,
    product.primarySku,
    product.gtin,
    product.upc,
    product.ean,
    ...(product.vendorCodes ?? []),
  ];
  const seen = new Set(alreadyAliasedCleanCodes.filter(Boolean));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  for (const code of rawCodes) {
    if (!code) continue;
    const n = normalizeCode(code);
    const cleanCode = n.clean;
    if (!cleanCode || seen.has(cleanCode)) continue;
    seen.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: code,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: product.source ?? "human_review",
      confidence: 1,
      approved: true,
      createdAt: now(),
      updatedAt: now(),
      createdBy: "multi_code",
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued };
}

/**
 * W2: build APPROVED aliases for an EXPLICIT list of human-selected discovered identifier codes, onto a
 * target product (new or existing). Dedupes against codes already aliased for that product (idempotent),
 * and NEVER overwrites a code that is an approved alias of a DIFFERENT product - those are returned as
 * conflicts for the caller to surface. Pure builder; caller commits to state.
 */
function buildAliasesForCodes(params: {
  product: Product;
  codes: string[];
  existingAliases: Alias[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
  approved?: boolean; // default true; pass false to persist a DISCOVERED (un-trusted) alias suggestion
  source?: Alias["source"];
  createdBy?: string;
}): { aliases: Alias[]; queued: PendingSyncItem[]; conflicts: { code: string; otherProductId: string }[] } {
  const { product, codes, existingAliases, businessId, sessionId, idFactory, now } = params;
  const approved = params.approved ?? true;
  const aliasSource = params.source ?? "human_review";
  const aliasCreatedBy = params.createdBy ?? "human";
  const ownCleanCodes = new Set(existingAliases.filter((a) => a.productId === product.id).map((a) => a.cleanCode));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  const conflicts: { code: string; otherProductId: string }[] = [];
  for (const raw of codes) {
    if (!raw) continue;
    const n = normalizeCode(raw);
    const cleanCode = n.clean;
    if (!cleanCode) continue;
    if (ownCleanCodes.has(cleanCode)) continue; // already aliased to THIS product -> idempotent skip
    const other = existingAliases.find((a) => a.cleanCode === cleanCode && a.productId !== product.id && a.approved);
    if (other) {
      conflicts.push({ code: cleanCode, otherProductId: other.productId });
      continue; // belongs to a DIFFERENT product -> never overwrite
    }
    ownCleanCodes.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: raw,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: aliasSource,
      confidence: 1,
      approved,
      createdAt: now(),
      updatedAt: now(),
      createdBy: aliasCreatedBy,
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued, conflicts };
}
export { buildAliasesForCodes, buildOrphanTransferSyncOps, buildProductCodeAliases };
