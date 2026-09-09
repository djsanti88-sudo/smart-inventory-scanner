import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { hashPin, verifyPin, isValidPinFormat } from "@/sessions/lock/pinLock";
import { getOrCreateDeviceId } from "@/sync-database/queue/deviceIdentity";
import { shouldReuseSession, buildAutoSessionName } from "@/sessions/auto/autoSession";
import { getMockDb } from "@/sync-database/mock/mockDb";
import { pruneFinalCountsForRotation } from "@/stores/scan/placeholders";
import { makeQueueItem } from "@/stores/scan/queueItem";
import { AUTO_SESSION_INACTIVITY_MINUTES } from "@/stores/scanStore";
import type { ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createSessionSlice(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
  idFactory: () => string;
  now: () => string;
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void;
  enqueueAndSync: (items: PendingSyncItem[]) => void;
  cloudBackend: boolean;
  clearTrustedExactProbes: () => void;
  archiveCurrentSessionIfAny: () => void;
}): Pick<ScanState,
  "startSession" | "finishSession" | "hasOwnerPin" | "setOwnerPin" | "resetOwnerPin" |
  "verifyOwnerPin" | "lockSession" | "unlockSession" | "listSessions" | "reopenSession" |
  "ensureAutoSession"> {
  const { set, get, idFactory, now, emitAudit, enqueueAndSync, cloudBackend, clearTrustedExactProbes, archiveCurrentSessionIfAny } = ctx;

  return {
      startSession: (name, location) => {
        clearTrustedExactProbes();
        // Owner feature (2026-07-22): archive the session being abandoned/rotated away from BEFORE
        // its scanFeed is wiped below - a session with at least one scan is never silently lost.
        archiveCurrentSessionIfAny();
        const previousSessionId = get().currentSession?.id;
        const id = `session-${idFactory()}`;
        const businessId = get().businessId;
        const session: InventorySession = {
          id,
          businessId,
          name: name || "Session",
          location: location || "Main",
          status: "active",
          startedAt: now(),
          completedAt: null,
          createdBy: get().userId ?? "demo",
          notes: "",
          syncStatus: "synced",
          locked: false,
          lockedAt: null,
        };
        set({
          sessionId: id,
          currentSession: session,
          scanFeed: [],
          finalCounts: pruneFinalCountsForRotation(get().finalCounts, previousSessionId),
          needsReviewQueue: [],
          // DATA-LOSS FIX (owner 4k campaign, 2026-08-05): pendingSyncQueue is deliberately NOT
          // wiped here. Rotating while the previous session's backlog is still draining was
          // silently discarding its unsynced cloud writes (measured live: 1,000 of 4,000 scan
          // events never reached Firestore). Queue items carry their own sessionId/businessId and
          // the drain is session-agnostic, so the backlog keeps draining under the new session -
          // same principle as setBusinessContext's "deliberately NOT filtered" tenant rule.
          // Guard: sessionRotationSyncSafety.store.test.ts.
          syncedScanEventIds: [],
          lastSyncError: null,
        });
        // Persist the session through the SAME durable queue as scans/counts (never blocks the UI).
        // Distinct idempotency key per lifecycle state ("active") so finishSession's write still applies.
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId,
            sessionId: id,
            entityType: "CountSession",
            entityId: id,
            operation: "SAVE_SESSION",
            payload: session,
            idempotencyKey: buildIdempotencyKey(businessId, id, `${id}-active`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: id, action: "session_started", metadata: { name: session.name, location: session.location } });
      },

      finishSession: () => {
        const cur = get().currentSession;
        if (!cur) return;
        const completed: InventorySession = { ...cur, status: "completed", completedAt: now() };
        set({ currentSession: completed });
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId: completed.businessId,
            sessionId: completed.id,
            entityType: "CountSession",
            entityId: completed.id,
            operation: "SAVE_SESSION",
            payload: completed,
            // Distinct key from the "active" write so the completed state is not deduped as alreadyApplied.
            idempotencyKey: buildIdempotencyKey(completed.businessId, completed.id, `${completed.id}-completed`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: completed.id, action: "session_completed", metadata: { completedAt: completed.completedAt } });
      },

      // --- Owner PIN lock -------------------------------------------------------------------------------
      hasOwnerPin: () => !!get().settings.ownerPinHash,

      setOwnerPin: async (pin) => {
        if (!isValidPinFormat(pin)) return false;
        const ownerPinHash = await hashPin(pin);
        set((s) => ({ settings: { ...s.settings, ownerPinHash } }));
        emitAudit({ entityType: "CountSession", entityId: "-", action: "owner_pin_set", metadata: {} });
        return true;
      },

      resetOwnerPin: () => {
        // Escape hatch: clear the PIN and UNLOCK every session (so a forgotten PIN can never trap a count).
        set((s) => ({
          settings: { ...s.settings, ownerPinHash: "" },
          currentSession: s.currentSession?.locked ? { ...s.currentSession, locked: false, lockedAt: null } : s.currentSession,
        }));
        emitAudit({ entityType: "CountSession", entityId: "-", action: "owner_pin_reset", metadata: {} });
      },

      verifyOwnerPin: async (pin) => verifyPin(pin, get().settings.ownerPinHash),

      lockSession: (sessionId) => {
        // A PIN must exist first (nothing to unlock with otherwise).
        if (!get().settings.ownerPinHash) return false;
        const cur = get().currentSession;
        if (!cur || cur.id !== sessionId || cur.locked) return false;
        const locked: InventorySession = { ...cur, locked: true, lockedAt: now() };
        set({ currentSession: locked });
        enqueueAndSync([
          makeQueueItem({
            idFactory, now, businessId: locked.businessId, sessionId: locked.id,
            entityType: "CountSession", entityId: locked.id, operation: "SAVE_SESSION", payload: locked,
            idempotencyKey: buildIdempotencyKey(locked.businessId, locked.id, `${locked.id}-locked-${locked.lockedAt}`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: locked.id, action: "session_locked", metadata: {} });
        return true;
      },

      unlockSession: async (sessionId, pin) => {
        const cur = get().currentSession;
        if (!cur || cur.id !== sessionId || !cur.locked) return false;
        if (!(await verifyPin(pin, get().settings.ownerPinHash))) return false;
        const unlocked: InventorySession = { ...cur, locked: false, lockedAt: null };
        set({ currentSession: unlocked });
        enqueueAndSync([
          makeQueueItem({
            idFactory, now, businessId: unlocked.businessId, sessionId: unlocked.id,
            entityType: "CountSession", entityId: unlocked.id, operation: "SAVE_SESSION", payload: unlocked,
            idempotencyKey: buildIdempotencyKey(unlocked.businessId, unlocked.id, `${unlocked.id}-unlocked-${now()}`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: unlocked.id, action: "session_unlocked", metadata: {} });
        return true;
      },

      // --- Browse + reopen saved sessions --------------------------------------------------------------
      // PHASE 3 FIX (scout-sessions gap #6): on the cloud backend these MUST NOT read getMockDb() directly
      // (that silently returns an empty/stale local mock DB for a Firebase-backed account). The mock/local
      // path is unchanged (still getMockDb(), which IS the real backing store there). Task 7's
      // refreshFromCloud populates `sessions`; before the first refresh, the current session is the
      // honest fallback. After refresh, the full cloud session history is the read source.
      listSessions: () => {
        if (cloudBackend) {
          const sessions = get().sessions;
          if (sessions.length > 0) return sessions;
          const cur = get().currentSession;
          return cur ? [cur] : [];
        }
        return getMockDb()
          .getSessions(get().businessId)
          .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      },

      reopenSession: (sessionId) => {
        if (cloudBackend) {
          // Cloud path: Task 7 refreshes full session history and counts into store state. Look up the
          // requested history row there, with currentSession only as the pre-refresh fallback.
          const state = get();
          const session =
            state.sessions.find((candidate) => candidate.id === sessionId) ??
            (state.currentSession?.id === sessionId ? state.currentSession : null);
          if (!session) return false;
          clearTrustedExactProbes();
          set({
            currentSession: session,
            sessionId: session.id,
            finalCounts: state.finalCounts.filter((c) => c.sessionId === session.id),
            scanFeed: [],
            needsReviewQueue: [],
          });
          emitAudit({ entityType: "CountSession", entityId: session.id, action: "session_reopened", metadata: {} });
          return true;
        }
        const db = getMockDb();
        const session = db.getSession(sessionId);
        if (!session || session.businessId !== get().businessId) return false;
        clearTrustedExactProbes();
        const finalCounts: InventoryCount[] = db.getSessionCounts(sessionId).map((c) => ({
          id: `count-${c.sessionId}-${c.productId}`,
          businessId: c.businessId,
          sessionId: c.sessionId,
          productId: c.productId,
          quantity: c.quantity,
          lastScannedAt: "",
          aliasesSeen: [],
          scanEventIds: c.scanEventIds,
          createdAt: session.startedAt,
          updatedAt: session.startedAt,
          syncStatus: "synced",
          syncError: null,
          appliedIdempotencyKeys: c.appliedIdempotencyKeys,
        }));
        set({ currentSession: session, sessionId: session.id, finalCounts, scanFeed: [], needsReviewQueue: [] });
        emitAudit({ entityType: "CountSession", entityId: session.id, action: "session_reopened", metadata: {} });
        return true;
      },

      ensureAutoSession: () => {
        if (typeof window === "undefined" || !window.localStorage) return; // non-browser/test context: no-op
        const deviceId = getOrCreateDeviceId(window.localStorage);
        set({ deviceId });
        const cur = get().currentSession;
        const nowIso = now();
        if (
          cur &&
          shouldReuseSession(
            { status: cur.status, deviceId: cur.deviceId, startedAt: cur.startedAt, locked: cur.locked },
            { deviceId, nowIso, inactivityMinutes: AUTO_SESSION_INACTIVITY_MINUTES },
          )
        ) {
          return; // idempotent: this device's session is still fresh and active, reuse it
        }
        // ADOPT an UNCLAIMED active session still within the window (a legacy/default/mock session with
        // no deviceId): claim it for this device and KEEP its counts, instead of rotating to a fresh
        // session and wiping the visible finalCounts. Rotating-with-wipe is correct only for a genuinely
        // new session (none active), a DIFFERENT device's session, or one past the inactivity window.
        // Without this, ensureAutoSession on scan-page mount would erase a hydrated in-progress count.
        // A LOCKED session is never adopted either (F1) - it must rotate to a fresh session, same as completed.
        if (cur && cur.status === "active" && !cur.locked && !cur.deviceId) {
          const startedMs = Date.parse(cur.startedAt);
          const withinWindow =
            !Number.isNaN(startedMs) &&
            (Date.parse(nowIso) - startedMs) / 60000 <= AUTO_SESSION_INACTIVITY_MINUTES;
          if (withinWindow) {
            // Adopt keeps id/counts, but the boot placeholder name ("Default Session") must NOT leak
            // to the UI - rename an unnamed/placeholder adopted session to a real auto-session name.
            const adopted: InventorySession = {
              ...cur,
              deviceId,
              name: cur.name === "Default Session" ? buildAutoSessionName(nowIso) : cur.name,
            };
            set({ currentSession: adopted });
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId: adopted.businessId,
                sessionId: adopted.id,
                entityType: "CountSession",
                entityId: adopted.id,
                operation: "SAVE_SESSION",
                payload: adopted,
                idempotencyKey: buildIdempotencyKey(adopted.businessId, adopted.id, `${adopted.id}-adopted-${deviceId}`, "SAVE_SESSION"),
                scanEventId: null,
              }),
            ]);
            emitAudit({ entityType: "CountSession", entityId: adopted.id, action: "session_adopted", metadata: { deviceId } });
            return;
          }
        }
        // A genuine rotation away from the prior session (fresh session below wipes scanFeed/
        // finalCounts) - archive it first, same as startSession.
        archiveCurrentSessionIfAny();
        clearTrustedExactProbes();
        const id = `session-${idFactory()}`;
        const businessId = get().businessId;
        const session: InventorySession = {
          id,
          businessId,
          name: buildAutoSessionName(nowIso),
          location: cur?.location || "Main",
          status: "active",
          startedAt: nowIso,
          completedAt: null,
          createdBy: get().userId ?? "demo",
          notes: "",
          syncStatus: "synced",
          locked: false,
          lockedAt: null,
          deviceId,
        };
        set({
          sessionId: id,
          currentSession: session,
          scanFeed: [],
          finalCounts: pruneFinalCountsForRotation(get().finalCounts, cur?.id),
          needsReviewQueue: [],
          lastSyncError: null,
        });
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId,
            sessionId: id,
            entityType: "CountSession",
            entityId: id,
            operation: "SAVE_SESSION",
            payload: session,
            idempotencyKey: buildIdempotencyKey(businessId, id, `${id}-active`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: id, action: "session_auto_started", metadata: { name: session.name, deviceId } });
      },
  };
}
