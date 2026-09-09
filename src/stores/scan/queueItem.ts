import type { PendingSyncItem, ScanEvent, SyncOperation } from "@/types";

/** Phase 3: stamp the current location + deviceId onto a freshly-built ScanEvent. Applied uniformly
 *  to every fresh ScanEvent literal inside processScan. Spread-built events inherit the stamp from
 *  their base; the markWrong residual literal outside processScan is deliberately unstamped. Pure -
 *  takes the values, does not read the store itself. */
// Stamp Phase 3 attribution onto a fresh ScanEvent. Concrete (not generic) so an inline object
// literal is type-checked against the full ScanEvent shape, not just the two stamped fields.
function stampScanEventLocation(
  event: ScanEvent,
  location: string,
  deviceId: string | null,
): ScanEvent {
  return { ...event, location, deviceId: deviceId ?? undefined };
}

function makeQueueItem(params: {
  idFactory: () => string;
  now: () => string;
  businessId: string;
  sessionId: string;
  entityType: PendingSyncItem["entityType"];
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  idempotencyKey: string;
  scanEventId: string | null;
  syncLane?: PendingSyncItem["syncLane"];
}): PendingSyncItem {
  return {
    id: params.idFactory(),
    businessId: params.businessId,
    sessionId: params.sessionId,
    entityType: params.entityType,
    entityId: params.entityId,
    operation: params.operation,
    payload: params.payload,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: params.now(),
    updatedAt: params.now(),
    idempotencyKey: params.idempotencyKey,
    scanEventId: params.scanEventId,
    syncLane: params.syncLane,
  };
}
export { makeQueueItem, stampScanEventLocation };
