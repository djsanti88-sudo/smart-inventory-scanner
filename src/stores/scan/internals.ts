import type { PendingSyncItem, UnknownCodeReview } from "@/types";
import { versionReviewDecision } from "@/review/reviewDecisionVersion";
import { makeQueueItem } from "@/stores/scan/queueItem";
import type { ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createStoreInternals(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
  idFactory: () => string;
  now: () => string;
}) {
  const { set, get, deps, idFactory, now } = ctx;

    const enqueueAndSync = (items: PendingSyncItem[]) => {
      set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...items] }));
      // Optimistic UI is already updated by the caller; attempt sync afterward.
      get().syncPending();
    };

    const nextReviewDecisionAt = (review: UnknownCodeReview, proposedAt: string) => {
      if (!review.decisionUpdatedAt || proposedAt > review.decisionUpdatedAt) return proposedAt;
      const previousMs = Date.parse(review.decisionUpdatedAt);
      return Number.isFinite(previousMs) ? new Date(previousMs + 1).toISOString() : proposedAt;
    };

    const buildReviewDecisionWrite = (review: UnknownCodeReview, decisionAt: string) => {
      const versioned = versionReviewDecision(review, decisionAt);
      return {
        review: versioned,
        item: makeQueueItem({
          idFactory,
          now,
          businessId: versioned.businessId,
          sessionId: versioned.sessionId,
          entityType: "UnknownCodeReview",
          entityId: versioned.id,
          operation: "SAVE_UNKNOWN_SCAN",
          payload: versioned,
          idempotencyKey: versioned.idempotencyKey,
          scanEventId: null,
        }),
      };
    };

    const persistReviewDecision = (reviewId: string, decisionAt?: string, allowOpen = false) => {
      const current = get().needsReviewQueue.find((review) => review.id === reviewId);
      if (!current || (!allowOpen && current.status !== "resolved" && current.status !== "ignored")) return;
      const at = decisionAt ?? current.decisionUpdatedAt ?? current.resolvedAt ?? now();
      const write = buildReviewDecisionWrite(current, at);
      set((state) => ({
        needsReviewQueue: state.needsReviewQueue.map((review) => review.id === reviewId ? write.review : review),
      }));
      if (!get().pendingSyncQueue.some((item) => item.idempotencyKey === write.item.idempotencyKey)) {
        enqueueAndSync([write.item]);
      }
    };

    // Fire-and-forget audit. NEVER blocks or throws into the scanner/UI. Only emits with a REAL business
    // context (no fake businessId/actor); a no-op when no audit sink is wired (mock/default path).
    const emitAudit = (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => {
      const { businessId, userId, businessContextReady } = get();
      if (!deps.audit || !businessContextReady || !userId || !businessId) return;
      try {
        deps.audit({ businessId, actorUserId: userId, ...e });
      } catch {
        // An audit failure must never break the scanner or any action. Swallow it.
      }
    };

  return { enqueueAndSync, emitAudit, nextReviewDecisionAt, buildReviewDecisionWrite, persistReviewDecision };
}
