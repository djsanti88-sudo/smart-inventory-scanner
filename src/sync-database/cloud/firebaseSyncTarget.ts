import { type Firestore, collection, doc, getDocs, orderBy, query, runTransaction, serverTimestamp, where } from "firebase/firestore";
import type { PendingSyncItem, ScanEvent, Alias, UnknownCodeReview, Product, InventorySession } from "@/types";
import type { SyncResult, IncrementPayload } from "@/sync-database/mock/mockDb";
import type { SyncTarget } from "@/sync-database/syncTarget";
import { COLLECTIONS } from "@/sync-database/types";
import {
  appliedKeyDocumentId,
  canonicalPayloadHash,
  type FirebaseSyncErrorCode,
  validatePendingSyncItem,
} from "@/sync-database/cloud/firebaseSyncSafety";

// Firebase durable-write target. Drop-in for MockDb in the scan store's sync queue, so the optimistic
// local UI + retry logic are preserved. The ONLY hard promise: NO DOUBLE COUNT. Every apply() runs in a
// single Firestore transaction that (1) reads the per-business _appliedKeys/{idempotencyKey} doc, (2)
// returns alreadyApplied only when its complete envelope and payload hash match, else (3) creates the
// appliedKey doc, writes the entity, and updates the count line - all atomically. Concurrent retries of
// the same item therefore can never double-increment, while a key collision cannot suppress another write.

const APPLIED_KEYS = "_appliedKeys";
const FIREBASE_TRANSACTION_TIMEOUT_MS = 55_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export type FirebaseSyncResult = SyncResult & { errorCode?: FirebaseSyncErrorCode };

type AppliedMarkerEnvelope = {
  businessId: string;
  entityType: PendingSyncItem["entityType"];
  entityId: string;
  sessionId: string;
  targetId: string;
  operation: PendingSyncItem["operation"];
  scanEventId: string | null;
  payloadHash: string;
};

const MARKER_ENVELOPE_FIELDS: Array<keyof AppliedMarkerEnvelope> = [
  "businessId",
  "entityType",
  "entityId",
  "sessionId",
  "targetId",
  "operation",
  "scanEventId",
  "payloadHash",
];

function markerMatches(
  stored: Record<string, unknown>,
  expected: AppliedMarkerEnvelope,
): boolean {
  return MARKER_ENVELOPE_FIELDS.every((field) => stored[field] === expected[field]);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export class FirebaseSyncTarget implements SyncTarget {
  constructor(
    private readonly db: Firestore,
    private readonly opts: { emulator: boolean } = { emulator: false },
  ) {}

  // Failure simulation is a mock/test concept; the real target has none.
  setFailure(): void {}

  // Guarded: never destructively wipe real cloud data. Allowed only in emulator/test mode (no-op there;
  // tests clear Firestore via the emulator's clear endpoint / rules-unit-testing).
  reset(): void {
    if (!this.opts.emulator) {
      throw new Error("FirebaseSyncTarget.reset() is disabled against the real Firebase cloud (no destructive reset).");
    }
  }

  /**
   * Phase 3: one-shot read of every ScanEvent for a session, oldest first. NOT part of the
   * transactional apply() - this is a plain query, matching loadBusinessData's one-shot getDocs
   * pattern (businessDataLoader.ts:27-33), not a live listener (no onSnapshot anywhere in this repo
   * by design - see the sync scout's Trap C on why a naive listener-replace is unsafe).
   */
  async getScanEventsBySession(businessId: string, sessionId: string): Promise<ScanEvent[]> {
    const col = collection(this.db, COLLECTIONS.businesses, businessId, COLLECTIONS.scanEvents);
    const q = query(col, where("sessionId", "==", sessionId), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as ScanEvent);
  }

  async apply(item: PendingSyncItem): Promise<FirebaseSyncResult> {
    const validationFailure = validatePendingSyncItem(item);
    if (validationFailure) {
      return {
        ok: false,
        alreadyApplied: false,
        errorCode: validationFailure.errorCode,
        error: `${validationFailure.errorCode}: ${validationFailure.message}`,
        retryable: false,
      };
    }

    const bid = item.businessId;

    const sub = (name: string, id: string) => doc(this.db, COLLECTIONS.businesses, bid, name, id);

    let physicalSettlement: Promise<void> | undefined;
    try {
      const keyId = await appliedKeyDocumentId(item.idempotencyKey);
      const payloadHash = await canonicalPayloadHash(item.payload);
      const markerTargetId =
        item.operation === "INCREMENT_COUNT"
          ? `${(item.payload as IncrementPayload).sessionId}_${(item.payload as IncrementPayload).productId}`
          : item.entityId;
      const expectedMarker: AppliedMarkerEnvelope = {
        businessId: bid,
        entityType: item.entityType,
        entityId: item.entityId,
        sessionId: item.sessionId,
        targetId: markerTargetId,
        operation: item.operation,
        scanEventId:
          item.operation === "INCREMENT_COUNT"
            ? (item.payload as IncrementPayload).scanEventId
            : item.scanEventId ?? null,
        payloadHash,
      };
      const keyRef = doc(this.db, COLLECTIONS.businesses, bid, APPLIED_KEYS, keyId);
      const transaction = runTransaction(this.db, async (tx) => {
        // ----- ALL READS FIRST (Firestore transaction rule) -----
        const keySnap = await tx.get(keyRef);
        if (keySnap.exists()) {
          if (markerMatches(keySnap.data(), expectedMarker)) {
            return { ok: true, alreadyApplied: true } as FirebaseSyncResult;
          }
          return {
            ok: false,
            alreadyApplied: false,
            errorCode: "idempotency_conflict",
            error: `idempotency_conflict: applied key ${keyId} belongs to a different sync operation`,
            retryable: false,
          } as FirebaseSyncResult;
        }

        // Decision clock (retry-reordering guard): a review-decision write that transiently failed and
        // retries on a LATER drain pass must never overwrite a newer decision that already landed. The
        // client-side merge (mergeReloadedReviews) only protects THIS device's local rows; the server
        // doc is what every other device reloads, so the recency check has to live in this transaction.
        // A stale item still settles (marker written, ok:true) so the queue never wedges on it.
        let staleReviewDecision = false;
        if (item.operation === "SAVE_UNKNOWN_SCAN") {
          const incoming = item.payload as UnknownCodeReview;
          const reviewSnap = await tx.get(sub(COLLECTIONS.unknownCodeReviews, incoming.id));
          if (reviewSnap.exists()) {
            const existingAt = (reviewSnap.data() as { decisionUpdatedAt?: string }).decisionUpdatedAt ?? "";
            const incomingAt = incoming.decisionUpdatedAt ?? "";
            staleReviewDecision = existingAt > incomingAt;
          }
        }

        let countRef: ReturnType<typeof sub> | null = null;
        let prevQty = 0;
        let prevScanIds: string[] = [];
        let scanEventAlreadyCounted = false;
        if (item.operation === "INCREMENT_COUNT") {
          const p = item.payload as IncrementPayload;
          countRef = sub(COLLECTIONS.inventoryCounts, `${p.sessionId}_${p.productId}`);
          const countSnap = await tx.get(countRef);
          if (countSnap.exists()) {
            const d = countSnap.data() as { countedQuantity?: number; quantity?: number; scanEventIds?: string[] };
            prevQty = Number(d.countedQuantity ?? d.quantity ?? 0);
            prevScanIds = Array.isArray(d.scanEventIds) ? d.scanEventIds : [];
            scanEventAlreadyCounted = prevScanIds.includes(p.scanEventId);
          }
        }

        // ----- THEN WRITES -----
        tx.set(keyRef, {
          ...expectedMarker,
          at: serverTimestamp(),
        });

        switch (item.operation) {
          case "SAVE_SCAN_EVENT": {
            const ev = item.payload as ScanEvent;
            tx.set(sub(COLLECTIONS.scanEvents, ev.id), withoutUndefined({ ...ev, businessId: bid, syncedAt: serverTimestamp() }));
            break;
          }
          case "SAVE_UNKNOWN_SCAN": {
            if (staleReviewDecision) break; // stale retry: settle the item, keep the newer decision
            const r = item.payload as UnknownCodeReview;
            tx.set(sub(COLLECTIONS.unknownCodeReviews, r.id), withoutUndefined({ ...r, businessId: bid, createdAt: serverTimestamp() }));
            break;
          }
          case "RESOLVE_ALIAS": {
            const a = item.payload as Alias;
            tx.set(sub(COLLECTIONS.aliases, a.id), withoutUndefined({ ...a, businessId: bid, updatedAt: serverTimestamp() }));
            break;
          }
          case "SAVE_PRODUCT": {
            const pr = item.payload as Product;
            tx.set(sub(COLLECTIONS.products, pr.id), withoutUndefined({ ...pr, businessId: bid, updatedAt: serverTimestamp() }), { merge: true });
            break;
          }
          case "SAVE_SESSION": {
            // Persist the count session (start AND finish funnel through here, each with a distinct
            // idempotency key so the completed-state write is not deduped). merge:true so finishing a
            // session updates status/completedAt without clobbering the original start metadata.
            const sess = item.payload as InventorySession;
            tx.set(
              sub(COLLECTIONS.countSessions, sess.id),
              withoutUndefined({ ...sess, businessId: bid, updatedAt: serverTimestamp() }),
              { merge: true },
            );
            break;
          }
          case "INCREMENT_COUNT": {
            const p = item.payload as IncrementPayload;
            // A legacy/reconstructed queue can carry a fresh idempotency key for an event already
            // present on the count row. Record the new marker and zero-delta metadata, but the event
            // itself is still one fact and must never increment quantity twice.
            const appliedDelta = scanEventAlreadyCounted ? 0 : p.quantityDelta;
            const nextScanIds = prevScanIds.includes(p.scanEventId) ? prevScanIds : [...prevScanIds, p.scanEventId];
            tx.set(
              countRef!,
              {
                businessId: bid,
                countSessionId: p.sessionId,
                productId: p.productId,
                countedQuantity: prevQty + appliedDelta,
                scanEventIds: nextScanIds,
                appliedKeyId: keyId,
                lastQuantityDelta: appliedDelta,
                lastScanEventId: p.scanEventId,
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            );
            break;
          }
          default:
            throw new Error(`Unknown operation ${item.operation}`);
        }

        return { ok: true, alreadyApplied: false } as FirebaseSyncResult;
      });
      physicalSettlement = transaction.then(() => undefined, () => undefined);
      const result = await withTimeout(transaction, FIREBASE_TRANSACTION_TIMEOUT_MS, "Firestore sync transaction");
      return result;
    } catch (e) {
      // A rules denial cannot become successful by replaying the identical queue item. In particular,
      // counters can create their own active-session rows but may not update them after settlement with
      // a fresh idempotency key. Surface that authorization boundary to the queue instead of retrying it
      // forever. Same-key retries never reach here: their applied marker returns alreadyApplied above.
      const firebaseCode =
        e && typeof e === "object" && "code" in e && typeof e.code === "string"
          ? e.code
          : undefined;
      const permissionDenied = firebaseCode === "permission-denied";
      return {
        ok: false,
        alreadyApplied: false,
        errorCode: permissionDenied ? "permission_denied" : "firestore_transaction_failed",
        error: e instanceof Error ? e.message : String(e),
        retryable: !permissionDenied,
        physicalSettlement,
      };
    }
  }
}
