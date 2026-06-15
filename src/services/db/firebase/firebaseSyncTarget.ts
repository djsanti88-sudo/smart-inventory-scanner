import { type Firestore, doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { PendingSyncItem, ScanEvent, Alias, UnknownCodeReview } from "@/types";
import type { SyncResult, FailureMode, IncrementPayload } from "@/services/mockDb";
import type { SyncTarget } from "@/services/db/syncTarget";
import { COLLECTIONS } from "@/services/db/types";

// Firebase durable-write target. Drop-in for MockDb in the scan store's sync queue, so the optimistic
// local UI + retry logic are preserved. The ONLY hard promise: NO DOUBLE COUNT. Every apply() runs in a
// single Firestore transaction that (1) reads the per-business _appliedKeys/{idempotencyKey} doc, (2)
// returns alreadyApplied without touching the count if it exists, else (3) creates the appliedKey doc,
// writes the entity, and updates the count line - all atomically. Concurrent retries of the same item
// therefore can never double-increment (one txn commits the key; the other re-reads it and no-ops).

const APPLIED_KEYS = "_appliedKeys";

export class FirebaseSyncTarget implements SyncTarget {
  constructor(
    private readonly db: Firestore,
    private readonly opts: { emulator: boolean } = { emulator: false },
  ) {}

  // Failure simulation is a mock/test concept; the real target has none.
  setFailure(_mode: FailureMode): void {}

  // Guarded: never destructively wipe real cloud data. Allowed only in emulator/test mode (no-op there;
  // tests clear Firestore via the emulator's clear endpoint / rules-unit-testing).
  reset(): void {
    if (!this.opts.emulator) {
      throw new Error("FirebaseSyncTarget.reset() is disabled against the real Firebase cloud (no destructive reset).");
    }
  }

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    const bid = item.businessId;
    if (!bid) return { ok: false, alreadyApplied: false, error: "missing businessId" };
    if (!item.idempotencyKey) return { ok: false, alreadyApplied: false, error: "missing idempotencyKey" };

    const sub = (name: string, id: string) => doc(this.db, COLLECTIONS.businesses, bid, name, id);
    const keyRef = doc(this.db, COLLECTIONS.businesses, bid, APPLIED_KEYS, item.idempotencyKey);

    try {
      const result = await runTransaction(this.db, async (tx) => {
        // ----- ALL READS FIRST (Firestore transaction rule) -----
        const keySnap = await tx.get(keyRef);
        if (keySnap.exists()) return { ok: true, alreadyApplied: true } as SyncResult;

        let countRef: ReturnType<typeof sub> | null = null;
        let prevQty = 0;
        let prevScanIds: string[] = [];
        if (item.operation === "INCREMENT_COUNT") {
          const p = item.payload as IncrementPayload;
          countRef = sub(COLLECTIONS.inventoryCounts, `${p.sessionId}_${p.productId}`);
          const countSnap = await tx.get(countRef);
          if (countSnap.exists()) {
            const d = countSnap.data() as { countedQuantity?: number; quantity?: number; scanEventIds?: string[] };
            prevQty = Number(d.countedQuantity ?? d.quantity ?? 0);
            prevScanIds = Array.isArray(d.scanEventIds) ? d.scanEventIds : [];
          }
        }

        // ----- THEN WRITES -----
        tx.set(keyRef, { operation: item.operation, scanEventId: item.scanEventId ?? null, at: serverTimestamp() });

        switch (item.operation) {
          case "SAVE_SCAN_EVENT": {
            const ev = item.payload as ScanEvent;
            tx.set(sub(COLLECTIONS.scanEvents, ev.id), { ...ev, businessId: bid, createdAt: serverTimestamp() });
            break;
          }
          case "SAVE_UNKNOWN_SCAN": {
            const r = item.payload as UnknownCodeReview;
            tx.set(sub(COLLECTIONS.unknownCodeReviews, r.id), { ...r, businessId: bid, createdAt: serverTimestamp() });
            break;
          }
          case "RESOLVE_ALIAS": {
            const a = item.payload as Alias;
            tx.set(sub(COLLECTIONS.aliases, a.id), { ...a, businessId: bid, updatedAt: serverTimestamp() });
            break;
          }
          case "INCREMENT_COUNT": {
            const p = item.payload as IncrementPayload;
            // The appliedKey check above already prevents a second apply of THIS scan event, so the
            // increment runs at most once. scanEventIds is kept for traceability (union, dedup-safe).
            const nextScanIds = prevScanIds.includes(p.scanEventId) ? prevScanIds : [...prevScanIds, p.scanEventId];
            tx.set(
              countRef!,
              {
                businessId: bid,
                countSessionId: p.sessionId,
                productId: p.productId,
                countedQuantity: prevQty + p.quantityDelta,
                scanEventIds: nextScanIds,
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            );
            break;
          }
          default:
            throw new Error(`Unknown operation ${item.operation}`);
        }

        return { ok: true, alreadyApplied: false } as SyncResult;
      });
      return result;
    } catch (e) {
      return { ok: false, alreadyApplied: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
