# Phase 3: Sessions, Cross-Device Sync, Locations, and the Boss Report - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the demo-that-closes: a scan auto-opens a session, the session history log shows every past session with a full scan-by-scan timeline, two devices signed into the same account see each other's counts within a declared staleness bound without ever clobbering unsynced local rows, every scan/count carries a free-text location with recents, and a printable, shareable Boss Report shows the moat line ("X of Y identified automatically") and inventory value where cost data exists.

**Architecture:** Extend the existing durable sync pipe (`enqueueAndSync` -> `pendingSyncQueue` -> `MockDb`/`FirebaseSyncTarget.apply`) rather than inventing a second one. Device identity is a new client-only concept (localStorage-persisted UUID + sessionStorage-scoped tab id), used only to derive idempotent auto-session keys, and it is never required for correctness of counting (the existing `_appliedKeys` transaction already guarantees that). Cross-device inbound sync is a NEW, narrowly-scoped one-shot refresh action (`refreshFromCloud`) that MERGES additively into `finalCounts`/`sessions`/`products`/`aliases`, explicitly preserving any row still in `pendingSyncQueue` or newer locally; it deliberately does NOT reuse `setBusinessContext`'s wholesale-replace pattern (that pattern is proven unsafe to call more than once per login, per the sync scout's Trap C). The session timeline is served by a new `getScanEventsBySession` query added symmetrically to `MockDb` and Firestore (via a new `businessDataLoader` sibling function), reading the `scanEvents` collection Firestore is already durably writing today (`firebaseSyncTarget.ts:65-69`) but nothing reads back. The Boss Report is a new page plus a new pure `bossReport.ts` service; its shareable link is a new Turso-backed KV token store (reusing the `LadderStorage.get/set/increment` primitive already proven in `src/server/upc/storage.ts`) behind a new unauthenticated `/api/share/[token]` route, the one deliberate, narrowly-scoped exception to "every route requires an idToken."

**Tech Stack:** Next.js 16 App Router / React 19 / TypeScript / Tailwind v4 / Zustand 5 + persist / Vitest (unit + dom projects) / Playwright / Firebase Firestore (`firebase/firestore` client SDK + `@firebase/rules-unit-testing` emulator) / Turso/libsql (`@libsql/client`, dynamic import).

## Global Constraints

- **TOP-LEVEL LAW**: every scanned code appears on the feed and counts, no exceptions; nothing in this phase may suppress a row or a count. The inbound sync merge (Task 7) must never wipe `scanFeed`/`pendingSyncQueue`/unsynced rows: additive merge only, never `setBusinessContext`'s replace pattern.
- **No DOT / tire-wedge scope.** Owner order 2026-07-19: "do not do anything with DOTs we dont scan those." Zero DOT capture anywhere in this plan.
- **No em dash or en dash in user-facing copy.** Use plain punctuation (commas, periods, parentheses) in every UI string, error message, and test description string that a user could see.
- **Services stay pure**: no React / `next/*` imports in `src/services/**`. New pure modules (`bossReport.ts`, `deviceIdentity.ts` core, `shareToken.ts` core) follow this; only their `"use client"` / route-handler callers import React/Next.
- **Persist-version discipline**: current persist version is **8** (`src/stores/scanStore.ts:5416`, `name: "sis-scan-v1"`). Any new field added to `ScanState` that must survive reload must first be included in `PersistableScanState` and `buildPersistedScanState` in `src/stores/scanPersist.ts`; Zustand's `merge` cannot restore a key that the persist layer never writes. If hydration migration logic is also needed, touch `scanStoreMigrate`'s non-destructive v5..v8 branch with the exact same **"only transform keys the blob actually carries"** rule already documented at `scanStore.ts:5386-5391` (a partial/settings-only blob must never gain injected keys, or it clobbers the seeded initial state on merge; this is the exact P2 regression already fixed once, do not reintroduce it). Fields with safe defaults that are actually persisted, including `location` and `recentLocations`, need no version bump unless they require migration logic beyond simple absence.
- **Test safety**: automated tests never call live Firebase/Turso/paid providers. Unit tests (`vitest` `unit`/`dom` projects) use `createTestScanStore` with injected `db`/`now`/`idFactory`. Firestore-touching tests are `.rules.test.ts` files gated `describe.skipIf(!ready)` where `ready = (process.env.FIRESTORE_EMULATOR_HOST ?? "").includes(":")`, run only via `npm run test:firebase`. Turso-touching code must degrade to an in-memory/file fallback when `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are absent (same pattern as `decodeCacheStore.ts`), so unit tests never require real credentials.
- **Idempotency contract unchanged**: `buildIdempotencyKey(businessId, sessionId, scanEventId, operation)` (`src/services/idempotency.ts:7-14`) is never re-derived inside a retry. New sync operations in this phase (session auto-open, location writes) reuse this exact builder with a new distinct-suffix `scanEventId` slot, following the existing `${id}-active` / `${id}-completed` / `${id}-locked-<ts>` convention at `scanStore.ts:1350,1373,1413`.
- **Phone-first proof**: every user-visible flow in this phase gets a Playwright screenshot at both the default desktop viewport and a 390px phone viewport.
- **Brand-neutral copy**: no product-name string other than the `PRODUCT_NAME` constant appears in any new user-facing copy (report header, share page, session log).
- **Every task is TDD**: write the failing test first, watch it fail for the right reason, then implement.
- **File-path convention**: all paths below are absolute Windows paths rooted at `C:\Users\djsan\inventory`, written here relative to that root for readability (e.g. `src/types.ts` means `C:\Users\djsan\inventory\src\types.ts`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/deviceIdentity.ts` | NEW. Pure. Mint/read a stable per-device id (localStorage) and per-tab id (sessionStorage). No React. |
| `src/services/deviceIdentity.test.ts` | NEW. Unit tests for the above (jsdom project). |
| `src/services/sessions/autoSession.ts` | NEW. Pure. Decides whether an existing session is still "current" for auto-open purposes (time-window + device match), and builds the auto-generated session name. |
| `src/services/sessions/autoSession.test.ts` | NEW. Unit tests. |
| `src/stores/scanStore.ts` | MODIFY. Add `deviceId`/`windowId` to `ScanEvent`/`InventorySession`/`PendingSyncItem` payload construction sites; add `ensureAutoSession` action; fix the `listSessions`/`reopenSession` cloud bypass through refresh-populated `sessions` state; add `location`/`recentLocations` state + `setLocation` action; add `refreshFromCloud` action (merge, not replace); guard `processScan` against a completed session. |
| `src/stores/scanPersist.ts` | MODIFY. Persist `location` and `recentLocations` for every role so both survive reload. |
| `src/stores/scanPersist.test.ts` | MODIFY. Assert location recents persist and customer-role feed rows retain location while `deviceId` remains stripped. |
| `src/types.ts` | MODIFY. Add `deviceId?: string` to `ScanEvent`, `InventorySession`; add `location?: string` to `ScanEvent` and `InventoryCount`; add `getScanEventsBySession`-supporting nothing new (uses existing `ScanEvent`). |
| `src/services/security/sensitiveFields.ts` | MODIFY. Add `location` to the customer-safe ScanEvent allowlist; deliberately keep attribution-only `deviceId` out. |
| `src/services/db/syncTarget.ts` | MODIFY. Add optional `getScanEventsBySession?(sessionId: string): Promise<ScanEvent[]> \| ScanEvent[]` to `SyncTarget` (optional so `MockDb`/`FirebaseSyncTarget` both implement it without breaking the narrow interface contract elsewhere). |
| `src/services/mockDb.ts` | MODIFY. Implement `getScanEventsBySession(sessionId)`. |
| `src/services/db/firebase/firebaseSyncTarget.ts` | MODIFY. Implement `getScanEventsBySession(sessionId)` as a one-shot Firestore query (new method, not part of the transactional `apply`). |
| `src/services/db/firebase/businessDataLoader.ts` | MODIFY. Add `loadScanEventsForSession(db, businessId, sessionId)` sibling export (separate from the bulk `loadBusinessData`, since scan events are timeline-detail, not boot data). |
| `src/components/SessionsList.tsx` | MODIFY. Show date + time (not date-only); each row becomes a link to `/sessions/[id]`. |
| `src/app/(app)/sessions/[id]/page.tsx` | NEW. Session detail/timeline page: fetches via `getScanEventsBySession`, renders a scan-by-scan table, offers per-session CSV export (scan-level + count-level). |
| `src/app/(app)/scan/page.tsx` | MODIFY. Replace the hardcoded location `<select>` with a free-text input + recents; wire `ensureAutoSession` on mount; add the "X of Y identified automatically" moat line. |
| `src/services/moatStats.ts` | NEW. Pure. Computes `{ total, identified }` from a `ScanEvent[]` by `resolverStatus`. |
| `src/services/moatStats.test.ts` | NEW. Unit tests. |
| `src/services/reports/bossReport.ts` | NEW. Pure. Aggregates `finalCounts`/`products`/`scanFeed` into the Boss Report data shape (totals, by-brand/category breakdown, value where cost exists, moat line, variance top-N when a variance snapshot exists). |
| `src/services/reports/bossReport.test.ts` | NEW. Unit tests. |
| `src/app/(app)/report/page.tsx` | NEW. Boss Report page: renders `bossReport.ts` output, `window.print()` button, print CSS, "Get shareable link" button. |
| `src/app/report/[token]/page.tsx` | NEW. Public (no `BusinessContextGate`), read-only report view driven entirely by the token API. |
| `src/app/api/share/route.ts` | NEW. Live-authenticated POST with explicit mock/E2E bypass: verifies business membership, rejects bodies over 32KB, mints a token scoped to one session, stores `{businessId, sessionId, expiresAt}` in the Turso KV, returns the token/URL. |
| `src/app/api/share/[token]/route.ts` | NEW. Unauthenticated GET: resolves a token to its report payload (server-side re-runs `bossReport.ts` logic against Firestore-loaded data in live mode; against a Turso-persisted mock-mode snapshot in mock mode, since mock mode has no server-reachable DB per scout finding #4). Expired/unknown token -> 404 with honest copy. |
| `src/server/share/shareTokenStore.ts` | NEW. Server-only. Turso-backed (falls back to file, same pattern as `decodeCacheStore.ts`) KV for `{token -> {businessId, sessionId, kind: "mock"\|"live", snapshot?, expiresAt}}`. |
| `src/server/share/shareTokenStore.test.ts` | NEW. Unit tests (file-fallback path only; no live Turso in tests). |
| `src/types.ts` | (same file as above) Add `Product.unitCost?: number` for optional inventory value. |
| `src/components/FinalCountTable.tsx` | MODIFY. Add an optional "Unit cost" edit field alongside the existing `location` edit (same inline-edit pattern already at `FinalCountTable.tsx:172,339-340`). |
| `src/services/reconcile/shopwareCsvAdapter.ts` | NOT MODIFIED. Price/cost columns stay excluded from reconcile CSV import per existing deliberate policy (Global Constraint: do not reverse that decision in this phase; unit cost is entered manually or via a distinct, new, narrowly-scoped Products-CSV column, added in Task 12). |
| `src/services/csvImportProducts.ts` (or wherever `importProductsCsv` lives) | MODIFY (Task 12). Recognize an optional `unit_cost` column. |
| `src/services/db/firebase/sessionPersistence.rules.test.ts` | MODIFY. Add the two-device concurrent-scan emulator test (Task 8). |
| `src/services/db/firebase/firebaseSyncTarget.rules.test.ts` | MODIFY. Add `getScanEventsBySession` emulator test (Task 6). |
| `e2e/human-bots/...` or `e2e/` (mock Playwright, port 3100) | MODIFY/NEW. Playwright specs for: auto-session log with timestamp + timeline (Task 5), location recents (Task 9), Boss Report print + share link (Task 11, Task 14), phone-viewport proof for all of the above. |
| `PROGRESS.md` | MODIFY (final task). Phase 3 status checkpoint. |

---

## Task 1: Device identity (localStorage device id + sessionStorage tab id)

**Files:**
- Create: `src/services/deviceIdentity.ts`
- Test: `src/services/deviceIdentity.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `getOrCreateDeviceId(storage: Storage, idFactory?: () => string): string`, `getOrCreateWindowId(storage: Storage, idFactory?: () => string): string`, exported constants `DEVICE_ID_KEY = "sis-device-id"`, `WINDOW_ID_KEY = "sis-window-id"`. Both consumed by Task 2 (`autoSession.ts`) and Task 3 (`scanStore.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/deviceIdentity.test.ts
import { describe, it, expect } from "vitest";
import { getOrCreateDeviceId, getOrCreateWindowId, DEVICE_ID_KEY, WINDOW_ID_KEY } from "@/services/deviceIdentity";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("deviceIdentity", () => {
  it("mints a new device id on first call and persists it under DEVICE_ID_KEY", () => {
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage, () => "fixed-device-1");
    expect(id).toBe("fixed-device-1");
    expect(storage.getItem(DEVICE_ID_KEY)).toBe("fixed-device-1");
  });

  it("returns the SAME device id on a second call (does not mint twice)", () => {
    const storage = fakeStorage();
    const first = getOrCreateDeviceId(storage, () => "fixed-device-1");
    const second = getOrCreateDeviceId(storage, () => "different-if-called-again");
    expect(second).toBe(first);
  });

  it("mints a new window id on first call and persists it under WINDOW_ID_KEY", () => {
    const storage = fakeStorage();
    const id = getOrCreateWindowId(storage, () => "fixed-window-1");
    expect(id).toBe("fixed-window-1");
    expect(storage.getItem(WINDOW_ID_KEY)).toBe("fixed-window-1");
  });

  it("device id and window id are independent (different storages, different keys)", () => {
    const storage = fakeStorage();
    const deviceId = getOrCreateDeviceId(storage, () => "dev-1");
    const windowId = getOrCreateWindowId(storage, () => "win-1");
    expect(deviceId).not.toBe(windowId);
    expect(storage.getItem(DEVICE_ID_KEY)).toBe("dev-1");
    expect(storage.getItem(WINDOW_ID_KEY)).toBe("win-1");
  });

  it("uses crypto.randomUUID when no idFactory is given", () => {
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/deviceIdentity.test.ts`
Expected: FAIL with `Cannot find module '@/services/deviceIdentity'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/deviceIdentity.ts
// Stable client-side identity, used ONLY to derive idempotent auto-session keys (Phase 3). Never
// used to decide whether a scan counts - that guarantee comes entirely from the existing
// _appliedKeys transaction (firebaseSyncTarget.ts) and per-event idempotencyKey. Pure: no React,
// no next/*, works against any Storage-shaped object so it is trivially testable without jsdom.
//
// Two distinct identities, matching the two different lifetimes the spec calls for:
//   - deviceId (localStorage): survives closing the tab/browser; identifies "this browser profile
//     on this device." One device may have many tabs; they all share one deviceId.
//   - windowId (sessionStorage): scoped to one tab; a fresh tab gets a fresh windowId. sessionStorage
//     is naturally per-tab in every browser, which is exactly the "window" granularity needed - this
//     is UNRELATED to the app's own InventorySession concept, despite the name collision risk.

export const DEVICE_ID_KEY = "sis-device-id";
export const WINDOW_ID_KEY = "sis-window-id";

function getOrCreate(storage: Storage, key: string, idFactory?: () => string): string {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const fresh = idFactory ? idFactory() : crypto.randomUUID();
  storage.setItem(key, fresh);
  return fresh;
}

/** Stable per-device id, persisted in localStorage. Minted once, reused forever on this device. */
export function getOrCreateDeviceId(storage: Storage, idFactory?: () => string): string {
  return getOrCreate(storage, DEVICE_ID_KEY, idFactory);
}

/** Stable per-tab id, persisted in sessionStorage. Minted once per tab lifetime. */
export function getOrCreateWindowId(storage: Storage, idFactory?: () => string): string {
  return getOrCreate(storage, WINDOW_ID_KEY, idFactory);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/deviceIdentity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/deviceIdentity.ts src/services/deviceIdentity.test.ts
git commit -m "feat(phase3): add per-device and per-window identity primitives"
```

---

## Task 2: Auto-session decision logic (pure)

**Files:**
- Create: `src/services/sessions/autoSession.ts`
- Test: `src/services/sessions/autoSession.test.ts`

**Interfaces:**
- Consumes: nothing beyond plain `InventorySession`-shaped data (does not import `@/types` to avoid coupling; accepts a minimal structural type).
- Produces: `shouldReuseSession(candidate: AutoSessionCandidate, opts: AutoSessionOptions): boolean`, `buildAutoSessionName(nowIso: string): string`, exported type `AutoSessionCandidate = { status: "active" | "completed"; deviceId?: string; startedAt: string }`, exported type `AutoSessionOptions = { deviceId: string; nowIso: string; inactivityMinutes: number }`. Consumed by Task 3 (`scanStore.ts`'s `ensureAutoSession`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/sessions/autoSession.test.ts
import { describe, it, expect } from "vitest";
import { shouldReuseSession, buildAutoSessionName, type AutoSessionCandidate } from "@/services/sessions/autoSession";

const DEVICE_A = "device-a";
const DEVICE_B = "device-b";

describe("shouldReuseSession", () => {
  it("reuses an ACTIVE session from the SAME device within the inactivity window", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:10:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(true);
  });

  it("does NOT reuse a COMPLETED session even from the same device", () => {
    const candidate: AutoSessionCandidate = { status: "completed", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:10:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("does NOT reuse a session past the inactivity window (auto-close boundary)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    // 31 minutes later, window is 30 -> stale, must auto-close and start fresh.
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:31:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("reuses right AT the inactivity boundary (inclusive)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:30:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(true);
  });

  it("does NOT reuse a DIFFERENT device's active session (two devices hold concurrent sessions by design)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_B, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:05:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("does NOT reuse a session with no deviceId at all (legacy/manual session - never silently adopted)", () => {
    const candidate: AutoSessionCandidate = { status: "active", startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:05:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });
});

describe("buildAutoSessionName", () => {
  it("formats an auto-session name as 'Mon D, h:MM AM/PM' in the local timezone", () => {
    // Fixed instant; assert only the STRUCTURE (month/day + time + AM/PM marker) to stay timezone-safe
    // in CI, since toLocaleString is host-timezone-dependent.
    const name = buildAutoSessionName("2026-07-19T16:00:00.000Z");
    expect(name).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/sessions/autoSession.test.ts`
Expected: FAIL with `Cannot find module '@/services/sessions/autoSession'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/sessions/autoSession.ts
// Pure decision logic for Phase 3 auto-sessions: idempotent per (account, device, time-window).
// No store, no Firebase, no React - fully deterministic given its inputs so it is trivially unit
// tested with fixed clocks (matches the createTestScanStore pinned-clock pattern used elsewhere in
// this store, see scanStore.ts:5451).
//
// Design: an auto-session is reused (not re-minted) when ALL of:
//   1. status is "active" (a completed session is NEVER auto-reused - matches the owner's explicit
//      "no session after finish, until the next auto-start" requirement; finishSession itself does
//      not clear sessionId, but ensureAutoSession's caller in scanStore.ts routes through this
//      function instead of trusting the raw currentSession/sessionId fields).
//   2. deviceId matches the CURRENT device exactly (two devices may hold concurrent sessions by
//      design - a session auto-opened by device B must never be silently adopted by device A).
//   3. startedAt is within the inactivity window of "now" (auto-close boundary; a session idle
//      longer than the window is stale and a fresh one should auto-open instead).
// A session with NO deviceId (e.g. a manually-started legacy session, or the default boot session)
// is never auto-reused - only auto-sessions with a matching device stamp are eligible, so a manual
// session is never silently repurposed by the auto-open logic.

export interface AutoSessionCandidate {
  status: "active" | "completed";
  deviceId?: string;
  startedAt: string;
}

export interface AutoSessionOptions {
  deviceId: string;
  nowIso: string;
  inactivityMinutes: number;
}

export function shouldReuseSession(candidate: AutoSessionCandidate, opts: AutoSessionOptions): boolean {
  if (candidate.status !== "active") return false;
  if (!candidate.deviceId || candidate.deviceId !== opts.deviceId) return false;
  const startedMs = Date.parse(candidate.startedAt);
  const nowMs = Date.parse(opts.nowIso);
  if (Number.isNaN(startedMs) || Number.isNaN(nowMs)) return false;
  const elapsedMinutes = (nowMs - startedMs) / 60000;
  return elapsedMinutes <= opts.inactivityMinutes;
}

/** "Jul 19, 4:00 PM" style auto-session name, per the master plan's example. */
export function buildAutoSessionName(nowIso: string): string {
  const d = new Date(nowIso);
  const datePart = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/sessions/autoSession.test.ts`
Expected: PASS (7 tests). Note: the `buildAutoSessionName` test asserts structure only (timezone-safe); if it fails on the exact regex due to a host locale emitting a narrow no-break space before AM/PM, relax the test to `/\d{1,2}:\d{2}\s*(AM|PM)/i` and rerun.

- [ ] **Step 5: Commit**

```bash
git add src/services/sessions/autoSession.ts src/services/sessions/autoSession.test.ts
git commit -m "feat(phase3): add pure auto-session reuse decision logic"
```

---

## Task 3: Wire device identity + `ensureAutoSession` into scanStore; fix `listSessions`/`reopenSession` cloud bypass; guard `processScan` against a completed session

**Files:**
- Modify: `src/stores/scanStore.ts`
- Modify: `src/types.ts`
- Test: `src/stores/autoSession.store.test.ts` (new)

**Interfaces:**
- Consumes: `getOrCreateDeviceId`/`getOrCreateWindowId` (Task 1), `shouldReuseSession`/`buildAutoSessionName` (Task 2), existing `ScanStoreDeps.db: SyncTarget`, existing `makeQueueItem`/`enqueueAndSync`/`buildIdempotencyKey`.
- Produces: new `ScanState` field `deviceId: string | null`; new action `ensureAutoSession: () => void` (idempotent: no-ops if a valid session already exists for this device/window); `InventorySession.deviceId?: string` and `ScanEvent.deviceId?: string` on the type; mock `listSessions`/`reopenSession` keep using `getMockDb()`, while the cloud path reads the `sessions` state populated by Task 7's `refreshFromCloud` and falls back to the current session only before history has been refreshed. Consumed by Task 4 (UI wiring), Task 5 (Playwright), Task 7 (`refreshFromCloud`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/stores/autoSession.store.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("ensureAutoSession", () => {
  it("auto-opens a session with an auto-generated name and deviceId stamp when none is active for this device", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    // Simulate a signed-out-then-fresh-boot state with no session (mirrors resetForSignOut's sessionId: "").
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const session = store.getState().currentSession;
    expect(session).not.toBeNull();
    expect(session!.status).toBe("active");
    expect(session!.deviceId).toBeTruthy();
    expect(session!.name).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  it("is idempotent: calling twice in a row does NOT mint a second session", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstId = store.getState().sessionId;
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).toBe(firstId);
  });

  it("auto-opens a FRESH session once the inactivity window has elapsed (auto-close)", () => {
    let clock = "2026-07-19T16:00:00.000Z";
    const store = createTestScanStore({ now: () => clock });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstId = store.getState().sessionId;
    clock = "2026-07-19T16:45:00.000Z"; // 45 min later, default inactivity window is 30
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(firstId);
    expect(store.getState().currentSession!.status).toBe("active");
  });

  it("does NOT auto-reuse a manually finished session (finishSession does not clear sessionId, but ensureAutoSession must not stamp new scans onto it)", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    store.getState().finishSession();
    const completedId = store.getState().sessionId;
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(completedId);
    expect(store.getState().currentSession!.status).toBe("active");
  });

  it("processScan on a completed session (before ensureAutoSession runs) is blocked, matching the locked-session guard shape", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    store.getState().finishSession();
    // Without an explicit ensureAutoSession call, a scan must not silently land in the completed session.
    const result = store.getState().processScan("012345678905");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/autoSession.store.test.ts`
Expected: FAIL - `ensureAutoSession` is not a function (does not exist yet), and the last test fails because `processScan` currently has no completed-session guard (it would return a truthy `ScanEvent`, not `null`).

- [ ] **Step 3: Write minimal implementation**

First, extend `src/types.ts`. Locate the `InventorySession` interface (currently `src/types.ts:211-226`) and the `ScanEvent` interface (currently `src/types.ts:169-209`):

```typescript
// src/types.ts - inside `export interface InventorySession { ... }`, add one field after `lockedAt?: string | null;`:
  /** Phase 3: the device that auto-opened this session (getOrCreateDeviceId). Undefined for
   *  manually-started or pre-Phase-3 sessions - those are never auto-reused (see autoSession.ts). */
  deviceId?: string;
```

```typescript
// src/types.ts - inside `export interface ScanEvent { ... }`, add two fields after `idempotencyKey: string;`:
  /** Phase 3: the device that produced this scan (getOrCreateDeviceId). Attribution/debugging only -
   *  never used to decide whether a scan counts (that guarantee is the idempotencyKey/_appliedKeys
   *  transaction, unrelated to this field). Optional: older persisted events lack it. */
  deviceId?: string;
  /** Phase 3: free-text location captured at scan time (defaults to the session's location until
   *  changed - see Task 9). Optional: older persisted events lack it. */
  location?: string;
```

```typescript
// src/types.ts - inside `export interface InventoryCount { ... }`, add one field after `appliedIdempotencyKeys: string[];`:
  /** Phase 3: the most recent location a scan for this product/session was recorded at. Optional:
   *  older persisted counts lack it. Display-only; never part of the ledger identity. */
  location?: string;
```

Now modify `src/stores/scanStore.ts`. Add the import near the top (alongside the existing `scanPersistNamespace` import at line 80):

```typescript
import { getOrCreateDeviceId } from "@/services/deviceIdentity";
import { shouldReuseSession, buildAutoSessionName } from "@/services/sessions/autoSession";
```

Add a module-level constant near `DEFAULT_SETTINGS` (around line 446):

```typescript
const AUTO_SESSION_INACTIVITY_MINUTES = 30;
```

Add `deviceId: string | null;` to the `ScanState` interface, right after `_hasHydrated: boolean;` (around line 543):

```typescript
  _hasHydrated: boolean;
  // Phase 3: this device's stable identity (localStorage-persisted UUID). Null until first read
  // (e.g. non-browser/test contexts, or before the store has touched deviceIdentity). Used only to
  // derive idempotent auto-session ownership - never part of the count/ledger identity.
  deviceId: string | null;
```

Add `ensureAutoSession: () => void;` to the actions block of the `ScanState` interface, right after `reopenSession: (sessionId: string) => boolean;` (around line 575):

```typescript
  /** Idempotent per (account, device, time-window): reuses the current session if it is still
   *  ACTIVE, owned by THIS device, and within the inactivity window; otherwise auto-opens a fresh
   *  auto-named session stamped with this device's id. Safe to call on every mount/scan - a no-op
   *  when a valid session already exists. */
  ensureAutoSession: () => void;
```

In the store initializer (inside `buildScanInitializer`, the returned object), add `deviceId: null,` to the initial state, right after the existing `_hasHydrated: false,` line (find via grep for `_hasHydrated: false`):

```typescript
      _hasHydrated: false,
      deviceId: null,
```

Now implement `ensureAutoSession` as a new action, placed directly after the existing `reopenSession` action (which ends at `scanStore.ts:1469` per the current read):

```typescript
      ensureAutoSession: () => {
        if (typeof window === "undefined" || !window.localStorage) return; // non-browser/test context: no-op
        const deviceId = getOrCreateDeviceId(window.localStorage);
        set({ deviceId });
        const cur = get().currentSession;
        const nowIso = now();
        if (
          cur &&
          shouldReuseSession(
            { status: cur.status, deviceId: cur.deviceId, startedAt: cur.startedAt },
            { deviceId, nowIso, inactivityMinutes: AUTO_SESSION_INACTIVITY_MINUTES },
          )
        ) {
          return; // idempotent: this device's session is still fresh and active, reuse it
        }
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
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
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
```

Now add the completed-session guard to `processScan`. Find the existing lock guard (currently `scanStore.ts:1472-1474`):

```typescript
      processScan: (rawInput) => {
        // OWNER PIN LOCK: a locked session is read-only - no new scan may land in it. Block before any work
        // so a locked count can never change until it is unlocked with the owner PIN.
        if (get().currentSession?.locked) return null;
```

Replace with (add the completed-session guard directly below the lock guard):

```typescript
      processScan: (rawInput) => {
        // OWNER PIN LOCK: a locked session is read-only - no new scan may land in it. Block before any work
        // so a locked count can never change until it is unlocked with the owner PIN.
        if (get().currentSession?.locked) return null;
        // PHASE 3 completed-session guard: finishSession does NOT clear sessionId/currentSession (by
        // design - see finishSession's own comment), so without this guard a scan taken between
        // "Finish session" and the next ensureAutoSession/startSession call would silently stamp the
        // OLD completed session's id. Callers (the scan page) call ensureAutoSession before every scan
        // batch; this guard is the hard backstop for any path that does not.
        if (get().currentSession?.status === "completed") return null;
```

Finally, fix the `listSessions`/`reopenSession` cloud bypass. Replace the current implementation (`scanStore.ts:1440-1469` in the pre-Phase-3 code) with the complete cloud-aware contract below. The mock/local path alone reads `getMockDb()`. The cloud path reads the `sessions` store field added and populated by Task 7, falls back to the current session only while that array is empty, and can reopen any refresh-loaded session rather than silently consulting stale mock data:

```typescript
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
```

Note: `getMockDb` is already imported in `scanStore.ts` (used by the pre-existing `listSessions`/`reopenSession`); no new import needed for this step. `cloudBackend` is already a closed-over `const` in `buildScanInitializer` (`scanStore.ts:995`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/autoSession.store.test.ts`
Expected: PASS (5 tests).

Also run the full store suite to confirm no regression from the `processScan` guard and the `listSessions`/`reopenSession` change:

Mandatory grep before the suite:

Run: `grep -rn "cloudBackend: true\|listSessions" src/stores --include="*.test.ts"`
Expected: the grep is always run. Zero combined cloud/listSessions hits is acceptable. If it finds a pre-existing cloud-path assertion, update it to the C1 contract: `listSessions()` reads `get().sessions`, falls back to `[currentSession]` only when that array is empty, and never reads `getMockDb()` under `cloudBackend: true`.

Run: `npx vitest run src/stores`
Expected: PASS after every mandatory-grep hit has been reconciled to the cloud `get().sessions` contract above.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/stores/scanStore.ts src/stores/autoSession.store.test.ts
git commit -m "feat(phase3): auto-session idempotent per device/window, fix cloud listSessions/reopenSession bypass, guard processScan against a completed session"
```

---

## Task 4: Ledger invariant suite regression pass under auto-sessions

**Files:**
- Modify: `src/stores/ledgerInvariants.store.test.ts`

**Interfaces:**
- Consumes: `ensureAutoSession` (Task 3), existing `assertBooksBalance`/`ledgerSnapshot` helpers already in this file (`ledgerInvariants.store.test.ts:22-45`).
- Produces: nothing new (regression-only task; adds test cases, no new production code).

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to the end of `src/stores/ledgerInvariants.store.test.ts` (append after the existing final test in the file):

```typescript
describe("ledger invariants hold across an auto-session boundary", () => {
  it("scans before and after an auto-session rollover both balance correctly, in their own session partitions", () => {
    let clock = "2026-07-19T16:00:00.000Z";
    const store = createTestScanStore({ now: () => clock });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstSessionId = store.getState().sessionId;
    store.getState().processScan("012345678905");
    store.getState().processScan("012345678905");
    assertBooksBalance(store);
    const firstSnapshot = ledgerSnapshot(store);

    // Roll the clock past the inactivity window: a NEW auto-session must open, and the ledger
    // invariant must hold independently for the new session's own scanFeed/finalCounts partition
    // (ensureAutoSession resets scanFeed/finalCounts/pendingSyncQueue on rollover, same as
    // startSession always has).
    clock = "2026-07-19T16:45:00.000Z";
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(firstSessionId);
    expect(store.getState().scanFeed).toHaveLength(0);
    expect(store.getState().finalCounts).toHaveLength(0);
    store.getState().processScan("012345678905");
    assertBooksBalance(store);

    // The first session's ledger snapshot is untouched by the rollover (rollover clears the LIVE
    // view only - it does not retroactively edit history).
    expect(firstSnapshot).toContain('"q":2');
  });

  it("a scan taken between finishSession and the next ensureAutoSession call never lands anywhere (processScan returns null, no phantom count)", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    store.getState().processScan("012345678905");
    store.getState().finishSession();
    const result = store.getState().processScan("012345678905"); // must be blocked, not silently counted
    expect(result).toBeNull();
    assertBooksBalance(store); // still balances: the blocked scan added nothing to compare against
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/ledgerInvariants.store.test.ts`
Expected: FAIL before Task 3 lands (these tests depend on `ensureAutoSession` and the completed-session guard). Since Task 3 is already merged by this point in plan order, run this BEFORE writing Task 3's implementation if executing strictly TDD-first across tasks is preferred; as ordered here (Task 4 after Task 3), this step instead verifies the test file's syntax/imports resolve and the NEW assertions are exercised - run once with `assertBooksBalance`/`ledgerSnapshot` helpers confirmed already imported at the top of the file (`ledgerInvariants.store.test.ts:1-6`) before adding the new describe block, so this step's "expected fail" is "not yet present" only if Task 3 has NOT landed. Given Task 3 precedes this task in execution order, this test is expected to PASS immediately on first run - if it does not, that is a real regression to fix, not an expected-fail TDD step; treat step 2/4 as one combined verification run in that case.

Run: `npx vitest run src/stores/ledgerInvariants.store.test.ts`
Expected (given Task 3 already landed): PASS on first run, confirming Task 3's `ensureAutoSession` and completed-session guard satisfy the ledger invariant across a rollover.

- [ ] **Step 3: (N/A - this task adds test coverage only, no implementation code)**

- [ ] **Step 4: Run the full ledger suite to confirm no regression**

Run: `npm run test:ledger`
Expected: PASS, all existing + 2 new cases green, under 90s per the master plan's CI budget.

- [ ] **Step 5: Commit**

```bash
git add src/stores/ledgerInvariants.store.test.ts
git commit -m "test(phase3): ledger invariant coverage across auto-session rollover and finish-then-scan gap"
```

---

## Task 5: Scan page wiring - free-text location with recents, auto-session on mount, moat line

**Files:**
- Create: `src/services/moatStats.ts`
- Test: `src/services/moatStats.test.ts`
- Modify: `src/stores/scanStore.ts` (add `location`/`recentLocations` state + `setLocation` action)
- Modify: `src/stores/scanPersist.ts` (persist `location`/`recentLocations` for every role)
- Test: `src/stores/scanPersist.test.ts` (extend)
- Modify: `src/app/(app)/scan/page.tsx`
- Test (Playwright): `e2e/phase3-location-moat.spec.ts`

**Interfaces:**
- Consumes: `COUNT_SNAPSHOT_CAP`-style ring-buffer pattern already in `scanStore.ts:1289-1309` (copied, not imported - it is a private local pattern, not an exported helper); `ScanEvent.resolverStatus` (existing, `src/types.ts:179`); the role-aware `buildPersistedScanState` boundary in `src/stores/scanPersist.ts`.
- Produces: `computeMoatStats(events: { resolverStatus: string }[]): { total: number; identified: number }` (Task consumed by Task 11's Boss Report); new `ScanState` fields `location: string` and `recentLocations: string[]`; new action `setLocation: (location: string) => void`; persisted `location` and `recentLocations` fields for every access level. Consumed by Task 9 (location on ScanEvent/InventoryCount) and Task 11 (Boss Report moat line).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/moatStats.test.ts
import { describe, it, expect } from "vitest";
import { computeMoatStats } from "@/services/moatStats";

describe("computeMoatStats", () => {
  it("counts known/resolved as identified, everything else as not", () => {
    const events = [
      { resolverStatus: "known" },
      { resolverStatus: "known" },
      { resolverStatus: "resolved" },
      { resolverStatus: "needs_review" },
      { resolverStatus: "conflict" },
    ];
    const stats = computeMoatStats(events);
    expect(stats).toEqual({ total: 5, identified: 3 });
  });

  it("returns zero/zero for an empty feed", () => {
    expect(computeMoatStats([])).toEqual({ total: 0, identified: 0 });
  });

  it("treats 'suggested' as NOT automatically identified (a human has not confirmed it yet)", () => {
    const events = [{ resolverStatus: "known" }, { resolverStatus: "suggested" }];
    expect(computeMoatStats(events)).toEqual({ total: 2, identified: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/moatStats.test.ts`
Expected: FAIL with `Cannot find module '@/services/moatStats'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/moatStats.ts
// "X of Y identified automatically" - the moat line (master plan cross-cutting rule: "the coverage
// line is product surface, not internals"). Pure aggregation over ScanEvent.resolverStatus
// (src/types.ts:50,179). "Identified" = the deterministic resolver (or a human's later resolution)
// reached a trusted match without a guess - "known" (approved alias / verified identifier) or
// "resolved" (human-approved mapping). "suggested" (an AI suggestion awaiting approval) does NOT
// count as automatically identified - it is a candidate, not a confirmed identity, per the
// resolver-trust rule "wrong identity is failure; unknown is acceptable."
export interface MoatStats {
  total: number;
  identified: number;
}

const IDENTIFIED_STATUSES = new Set(["known", "resolved"]);

export function computeMoatStats(events: Array<{ resolverStatus: string }>): MoatStats {
  let identified = 0;
  for (const e of events) {
    if (IDENTIFIED_STATUSES.has(e.resolverStatus)) identified += 1;
  }
  return { total: events.length, identified };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/moatStats.test.ts`
Expected: PASS (3 tests).

Now wire location state into the store. Modify `src/stores/scanStore.ts`: add a constant near `AUTO_SESSION_INACTIVITY_MINUTES`:

```typescript
const RECENT_LOCATIONS_CAP = 8;
```

Add to the `ScanState` interface, after `deviceId: string | null;`:

```typescript
  /** Phase 3: the location to stamp on the NEXT scan (defaults to the session's location; changing
   *  it does not retroactively edit past scans). */
  location: string;
  /** Phase 3: capped ring buffer of recently-used location strings for this business, newest last -
   *  same append-and-slice-oldest pattern as countSnapshots (scanStore.ts:1289-1309). */
  recentLocations: string[];
```

Add `setLocation: (location: string) => void;` to the actions block, after `ensureAutoSession: () => void;`:

```typescript
  /** Set the location to stamp on subsequent scans, and record it in recentLocations (capped,
   *  deduped, most-recent-last). Empty/whitespace-only input is ignored (never stored). */
  setLocation: (location: string) => void;
```

Add to the initial state, after `location`/`recentLocations` fit alongside `deviceId: null,`:

```typescript
      location: "Main",
      recentLocations: [],
```

Implement the action, placed directly after `ensureAutoSession` (Task 3):

```typescript
      setLocation: (location) => {
        const trimmed = location.trim();
        if (!trimmed) return;
        set((s) => {
          const withoutDup = s.recentLocations.filter((l) => l !== trimmed);
          const next = [...withoutDup, trimmed];
          return {
            location: trimmed,
            recentLocations: next.length > RECENT_LOCATIONS_CAP ? next.slice(next.length - RECENT_LOCATIONS_CAP) : next,
          };
        });
      },
```

Persist both new fields through the store's actual disk boundary. Modify `src/stores/scanPersist.ts`: add the fields to `PersistableScanState` alongside the other common state fields:

```typescript
  location: string;
  recentLocations: string[];
```

Then add both to `buildPersistedScanState`'s `base` object, directly after `currentSession`, so platform and customer roles both retain them:

```typescript
    currentSession: s.currentSession,
    location: s.location,
    recentLocations: s.recentLocations,
```

These values contain location labels, not reusable scanned codes or provider internals, so they are safe for every role. No persist version bump is needed once they are actually emitted by `buildPersistedScanState`; Zustand can merge their safe initial defaults when an older blob lacks them.

Update `makeState()` in `src/stores/scanPersist.test.ts` with `location: "Main"` and `recentLocations: []`, then append this small persistence assertion:

```typescript
  it("persists location and recentLocations for customer-role reloads", () => {
    const s = makeState();
    s.location = "Bay A";
    s.recentLocations = ["Main", "Bay A"];
    const persisted = buildPersistedScanState(s, "business");
    expect(persisted).toMatchObject({ location: "Bay A", recentLocations: ["Main", "Bay A"] });
  });
```

Now modify `src/app/(app)/scan/page.tsx`. Replace the local `useState` location control and the hardcoded `<select>` (currently lines 36, 160-171) with the store-backed version. Replace:

```typescript
  const [name, setName] = useState("");
  const [location, setLocation] = useState("Main");
```

with:

```typescript
  const [name, setName] = useState("");
  const location = useScanStore((s) => s.location);
  const setLocation = useScanStore((s) => s.setLocation);
  const recentLocations = useScanStore((s) => s.recentLocations);
  const ensureAutoSession = useScanStore((s) => s.ensureAutoSession);
  const scanFeed = useScanStore((s) => s.scanFeed);
```

Add the auto-session mount effect directly below the existing `refreshAiStatus` effect (after line 61):

```typescript
  useEffect(() => {
    ensureAutoSession();
  }, [ensureAutoSession]);
```

Replace the hardcoded `<select aria-label="location">` block (lines 160-171) with a free-text input + a native `<datalist>` for recents (keeps the scanner-focus rule intact: this control is not the scan input, and typing into it never intercepts scanner keystrokes since it only has focus when a human clicks it):

```tsx
          <input
            aria-label="location"
            list="recent-locations"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location (e.g. Bay A)"
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
          />
          <datalist id="recent-locations">
            {recentLocations.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
```

Add the moat line directly above `<LiveScanFeed />` (find `<LiveScanFeed />` near the end of the JSX, around line 234):

```tsx
      {scanFeed.length > 0 && (
        <p className="px-1 text-sm font-medium text-zinc-700" data-testid="moat-line">
          {computeMoatStats(scanFeed).identified} of {computeMoatStats(scanFeed).total} identified automatically
        </p>
      )}
      <LiveScanFeed />
```

Add the import at the top of `src/app/(app)/scan/page.tsx`:

```typescript
import { computeMoatStats } from "@/services/moatStats";
```

- [ ] **Step 5: Write the Playwright proof**

```typescript
// e2e/phase3-location-moat.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Phase 3: location recents and moat line", () => {
  test("typing a location, then scanning, offers it as a recent and shows the moat line", async ({ page }) => {
    await page.goto("/scan");
    await page.getByLabel("location").fill("Bay A");
    // trigger a known-code scan via the scanner input (mock-mode seed data includes a known code;
    // reuse the project's standard e2e seed barcode fixture already used by other scan specs).
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await expect(page.getByTestId("moat-line")).toBeVisible();
    await page.getByLabel("location").fill("");
    await page.getByLabel("location").click();
    const options = await page.locator("#recent-locations option").allTextContents();
    expect(options.join(",")).toContain("Bay A");
  });

  test("phone viewport (390px): location input and moat line render without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/scan");
    await page.getByLabel("location").fill("Cooler 1");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await expect(page.getByTestId("moat-line")).toBeVisible();
    await page.screenshot({ path: "e2e/proof/phase3-location-moat-phone.png", fullPage: true });
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/services/moatStats.test.ts src/stores/scanPersist.test.ts src/stores`
Expected: PASS.

Run: `npm run test:e2e -- phase3-location-moat.spec.ts`
Expected: PASS, screenshot written to `e2e/proof/phase3-location-moat-phone.png`. If the scan-input `getByRole` selector does not match the real `ScannerInput` accessible name, inspect `src/components/ScannerInput.tsx` for its actual `aria-label`/`id` (`#scanner-input` per the LiveScanFeed comment at `LiveScanFeed.tsx:117`) and adjust the selector to `page.locator("#scanner-input")` accordingly before rerunning.

- [ ] **Step 7: Commit**

```bash
git add src/services/moatStats.ts src/services/moatStats.test.ts src/stores/scanStore.ts src/stores/scanPersist.ts src/stores/scanPersist.test.ts src/app/\(app\)/scan/page.tsx e2e/phase3-location-moat.spec.ts e2e/proof/phase3-location-moat-phone.png
git commit -m "feat(phase3): free-text location with recents, auto-session on scan-page mount, moat line"
```

---

## Task 6: `getScanEventsBySession` - MockDb + SyncTarget interface + Firestore read path

**Files:**
- Modify: `src/services/db/syncTarget.ts`
- Modify: `src/services/mockDb.ts`
- Modify: `src/services/db/firebase/firebaseSyncTarget.ts`
- Test: `src/services/mockDb.test.ts` (create if it does not exist, else extend)
- Test: `src/services/db/firebase/firebaseSyncTarget.rules.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ScanEvent` type; existing `COLLECTIONS.scanEvents` constant (`src/services/db/types.ts:193`); existing `firebaseSyncTarget.ts`'s `this.db`/`bid`-scoping pattern.
- Produces: `SyncTarget.getScanEventsBySession?(businessId: string, sessionId: string): Promise<ScanEvent[]> | ScanEvent[]` (optional interface member); `MockDb.getScanEventsBySession(businessId: string, sessionId: string): ScanEvent[]`; `FirebaseSyncTarget.getScanEventsBySession(businessId: string, sessionId: string): Promise<ScanEvent[]>`. Consumed by Task 7 (`businessDataLoader` sibling) and Task 8 (session detail page).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/mockDb.test.ts (create this file if it does not already exist in the repo; if it
// exists, append this describe block instead of overwriting the file)
import { describe, it, expect } from "vitest";
import { MockDb } from "@/services/mockDb";
import type { ScanEvent } from "@/types";

function ev(id: string, businessId: string, sessionId: string, createdAt: string): ScanEvent {
  return {
    id, businessId, sessionId, rawCode: "123", cleanCode: "123", normalizedCandidates: ["123"],
    matchedProductId: null, matchType: "unknown", status: "unknown", resolverStatus: "needs_review",
    codeType: "numeric_sku", reason: "test", quantityDelta: 1, quantityAfterScan: 1, createdAt,
    source: "scan", notes: "", syncStatus: "synced", syncError: null, idempotencyKey: `k-${id}`,
  };
}

describe("MockDb.getScanEventsBySession", () => {
  it("returns only events for the given business + session, sorted oldest first", () => {
    const db = new MockDb();
    db.upsertScanEvent(ev("e1", "biz1", "s1", "2026-07-19T16:00:00.000Z"));
    db.upsertScanEvent(ev("e2", "biz1", "s1", "2026-07-19T16:05:00.000Z"));
    db.upsertScanEvent(ev("e3", "biz1", "s2", "2026-07-19T16:01:00.000Z")); // different session
    db.upsertScanEvent(ev("e4", "biz2", "s1", "2026-07-19T16:02:00.000Z")); // different business, same session id
    const result = db.getScanEventsBySession("biz1", "s1");
    expect(result.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("returns an empty array for a session with no events", () => {
    const db = new MockDb();
    expect(db.getScanEventsBySession("biz1", "nope")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/mockDb.test.ts`
Expected: FAIL with `db.getScanEventsBySession is not a function`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/services/db/syncTarget.ts`:

```typescript
// src/services/db/syncTarget.ts (full new content)
import type { PendingSyncItem, ScanEvent } from "@/types";

export interface SyncResult {
  ok: boolean;
  alreadyApplied: boolean;
  error?: string;
}

export type FailureMode = "none" | "always" | { failTimes: number };

export interface SyncTarget {
  apply(item: PendingSyncItem): SyncResult | Promise<SyncResult>;
  setFailure(mode: FailureMode): void;
  reset(): void;
  /**
   * Phase 3: one-shot read of every ScanEvent for a session, oldest first - the source of a session
   * detail/timeline view. Optional because it is a NEW read-side capability added alongside the
   * existing write-only apply(); a SyncTarget implementation that has not been updated yet degrades
   * gracefully (callers check for its presence, per Task 8's session detail page).
   */
  getScanEventsBySession?(businessId: string, sessionId: string): ScanEvent[] | Promise<ScanEvent[]>;
}
```

(If `src/services/db/syncTarget.ts` currently imports `SyncResult`/`FailureMode` from elsewhere rather than declaring them locally, keep those existing imports/exports exactly as they are and only ADD the `getScanEventsBySession?` member plus the `ScanEvent` type import - do not restructure the file's existing export shape.)

Modify `src/services/mockDb.ts`. Add a new method directly after `getSessionCounts` (currently `mockDb.ts:190-192`):

```typescript
  /** Every ScanEvent for one business+session, oldest first (Phase 3 session timeline). */
  getScanEventsBySession(businessId: string, sessionId: string): ScanEvent[] {
    return Object.values(this.state.scanEvents)
      .filter((e) => e.businessId === businessId && e.sessionId === sessionId)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }
```

Modify `src/services/db/firebase/firebaseSyncTarget.ts`. Add the imports needed for a plain query (alongside the existing `runTransaction`/`doc`/`serverTimestamp` imports at the top of the file):

```typescript
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
```

Add the method to the `FirebaseSyncTarget` class, directly after the `reset()` method (currently `firebaseSyncTarget.ts:27-31`):

```typescript
  /**
   * Phase 3: one-shot read of every ScanEvent for a session, oldest first. NOT part of the
   * transactional apply() - this is a plain query, matching loadBusinessData's one-shot getDocs
   * pattern (businessDataLoader.ts:27-33), not a live listener (no onSnapshot anywhere in this repo
   * by design - see the sync scout's Trap C on why a naive listener-replace is unsafe).
   */
  async getScanEventsBySession(businessId: string, sessionId: string): Promise<import("@/types").ScanEvent[]> {
    const col = collection(this.db, COLLECTIONS.businesses, businessId, COLLECTIONS.scanEvents);
    const q = query(col, where("sessionId", "==", sessionId), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as import("@/types").ScanEvent);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/mockDb.test.ts`
Expected: PASS (2 tests).

Now add the emulator test. Append to `src/services/db/firebase/firebaseSyncTarget.rules.test.ts`, inside the existing `describe.skipIf(!ready)` block, after the last existing `it(...)`:

```typescript
  it("getScanEventsBySession returns only this session's events, oldest first", async () => {
    const t = target();
    await t.apply({ ...incItem("gs1", "gev1", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", payload: { id: "gev1", businessId: BIZ, sessionId: SID, cleanCode: "111", createdAt: "2026-07-19T16:00:00.000Z" } });
    await t.apply({ ...incItem("gs2", "gev2", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", payload: { id: "gev2", businessId: BIZ, sessionId: SID, cleanCode: "222", createdAt: "2026-07-19T16:05:00.000Z" } });
    await t.apply({ ...incItem("gs3", "gev3", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", payload: { id: "gev3", businessId: BIZ, sessionId: "other-session", cleanCode: "333", createdAt: "2026-07-19T16:01:00.000Z" } });
    const events = await t.getScanEventsBySession!(BIZ, SID);
    expect(events.map((e) => e.id)).toEqual(["gev1", "gev2"]);
  });
```

Note: the Firestore write side writes `createdAt: serverTimestamp()` (`firebaseSyncTarget.ts:67`) in production, which overwrites whatever `createdAt` the test payload supplies; the `orderBy("createdAt", "asc")` query still works because the emulator resolves `serverTimestamp()` to a real ascending timestamp per write. The test's explicit `createdAt` strings above document intent but the actual ordering is governed by write order, which matches the assertion here since the three `apply()` calls run sequentially and `await`ed.

- [ ] **Step 5: Run the emulator test**

Run: `npm run test:firebase`
Expected: PASS (all pre-existing Firestore emulator tests plus the new `getScanEventsBySession` case). Requires the Firebase emulator to be installed locally (`firebase emulators:exec`, already the project's standard `test:firebase` script - no new setup).

- [ ] **Step 6: Commit**

```bash
git add src/services/db/syncTarget.ts src/services/mockDb.ts src/services/mockDb.test.ts src/services/db/firebase/firebaseSyncTarget.ts src/services/db/firebase/firebaseSyncTarget.rules.test.ts
git commit -m "feat(phase3): getScanEventsBySession read path on MockDb and FirebaseSyncTarget"
```

---

## Task 7: `refreshFromCloud` - additive cross-device inbound merge (never replace)

**Files:**
- Modify: `src/stores/scanStore.ts`
- Modify: `src/services/db/firebase/businessDataLoader.ts`
- Test: `src/stores/refreshFromCloud.store.test.ts` (new)

**Interfaces:**
- Consumes: existing `loadBusinessData` shape (`LoadedBusinessData`), `ScanStoreDeps.loadBusinessData` (existing injectable dependency), `businessContextReady`/`businessDataLoaded` gates (existing, `scanStore.ts:488,492`).
- Produces: new `ScanState` field `sessions: InventorySession[]` and new action `refreshFromCloud: () => Promise<void>` (no-op on the mock/local path; on the cloud path, re-fetches via `deps.loadBusinessData` and MERGES additively: `products`/`aliases` upsert-by-id over the existing arrays (never wholesale replace), `finalCounts` upsert-by-`(sessionId,productId)` taking the MAX of local vs. remote quantity is explicitly REJECTED as unsafe - instead any local row still referenced by `pendingSyncQueue` is preserved as-is and only rows NOT locally pending are overwritten with the remote value, per Trap C's guidance) and `sessions` upsert-by-id. Never touches `scanFeed` (matches the existing behavior that `loadBusinessData` never returns scan events - Task 6 added a SEPARATE read path for that, consumed by Task 8, not this action). Task 3's cloud `listSessions` and `reopenSession` consume this refresh-populated session history, completing the cloud read contract. Consumed by Task 8 (manual refresh button) and the Task 8 two-device Playwright/emulator proof.

- [ ] **Step 1: Write the failing test**

```typescript
// src/stores/refreshFromCloud.store.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { Product, InventoryCount, InventorySession } from "@/types";

function product(id: string, name: string): Product {
  return {
    id, businessId: "biz1", name, brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "u", updatedBy: "u",
  };
}

function count(sessionId: string, productId: string, quantity: number): InventoryCount {
  return {
    id: `count-${sessionId}-${productId}`, businessId: "biz1", sessionId, productId, quantity,
    lastScannedAt: "t", aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

describe("refreshFromCloud", () => {
  it("is a no-op on the mock/local backend (no loadBusinessData dependency)", async () => {
    const store = createTestScanStore({});
    await store.getState().refreshFromCloud();
    // No throw, no change - the mock path IS the source of truth already.
    expect(store.getState().lastSyncError).toBeNull();
  });

  it("merges remote products/counts ADDITIVELY - a row this device does NOT have locally is added", async () => {
    const remoteProduct = product("p-remote", "Remote Widget");
    const remoteCount = count("s1", "p-remote", 5);
    const remoteSession = {
      id: "s1", businessId: "biz1", name: "Remote Session", location: "Bay A", status: "active",
      startedAt: "t", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
      locked: false, lockedAt: null,
    } as InventorySession;
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [remoteProduct],
      aliases: [],
      sessions: [remoteSession],
      counts: [remoteCount],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({ businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1", sessionId: "s1" });
    await store.getState().refreshFromCloud();
    expect(store.getState().products.find((p) => p.id === "p-remote")).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === "p-remote")?.quantity).toBe(5);
    expect(store.getState().sessions.find((s) => s.id === "s1")).toEqual(remoteSession);
  });

  it("NEVER overwrites a count row this device still has PENDING in its sync queue (TOP-LEVEL LAW guard)", async () => {
    const remoteCount = count("s1", "p-local", 1); // remote only knows about qty 1 so far
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [product("p-local", "Local Widget")],
      aliases: [],
      sessions: [],
      counts: [remoteCount],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({
      businessContextReady: true,
      businessDataLoaded: true,
      businessId: "biz1",
      userId: "u1",
      sessionId: "s1",
      // Simulate: this device has ALREADY locally counted this product to 3, with an unsynced item
      // still pending drain (a slow/offline network - the exact scenario Trap C warns about).
      finalCounts: [count("s1", "p-local", 3)],
      pendingSyncQueue: [
        {
          id: "pend1", businessId: "biz1", sessionId: "s1", entityType: "InventoryCount", entityId: "s1_p-local",
          operation: "INCREMENT_COUNT", payload: {}, status: "pending", retryCount: 0, lastError: null,
          createdAt: "t", updatedAt: "t", idempotencyKey: "k1", scanEventId: "ev-local",
        },
      ],
    });
    await store.getState().refreshFromCloud();
    // The local, not-yet-synced count of 3 MUST survive - refreshing must never regress it to the
    // stale remote value of 1.
    expect(store.getState().finalCounts.find((c) => c.productId === "p-local")?.quantity).toBe(3);
  });

  it("does NOT touch scanFeed (scan events are read via getScanEventsBySession, not this action)", async () => {
    const loadBusinessData = vi.fn().mockResolvedValue({ products: [], aliases: [], sessions: [], counts: [] });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({ businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1" });
    const before = store.getState().scanFeed;
    await store.getState().refreshFromCloud();
    expect(store.getState().scanFeed).toBe(before); // reference-unchanged: never reassigned
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/refreshFromCloud.store.test.ts`
Expected: FAIL with `store.getState().refreshFromCloud is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add `sessions: InventorySession[];` to the `ScanState` interface directly after `currentSession: InventorySession | null;`:

```typescript
  /** Phase 3: refresh-populated cloud session history consumed by listSessions/reopenSession. */
  sessions: InventorySession[];
```

Add the safe initial value alongside `currentSession` in the store initializer:

```typescript
      sessions: [],
```

This history array is intentionally refresh-populated rather than separately persisted; `currentSession` remains in the existing persisted base, and the next cloud refresh reconstructs full history.

Add `refreshFromCloud: () => Promise<void>;` to the `ScanState` interface actions block, after `ensureAutoSession: () => void;`:

```typescript
  /** Phase 3 cross-device inbound sync: a manual, one-shot refresh (NOT a live listener - see the
   *  sync scout's Trap C on why a listener wired to a naive replace would violate the TOP-LEVEL LAW).
   *  MERGES additively: products/aliases/sessions upsert by id; finalCounts upsert by
   *  (sessionId,productId) EXCEPT rows this device still has an unsynced pendingSyncQueue entry for,
   *  which are left untouched (a stale remote read must never regress a not-yet-synced local count).
   *  No-op on the mock/local backend. Never touches scanFeed. */
  refreshFromCloud: () => Promise<void>;
```

Implement it directly after `ensureAutoSession`, in the returned actions object:

```typescript
      refreshFromCloud: async () => {
        if (!cloudBackend || !deps.loadBusinessData) return; // mock/local path: already the source of truth
        const state = get();
        if (!state.businessContextReady || !state.userId || !state.businessId) return;
        let data;
        try {
          data = await deps.loadBusinessData(state.businessId, state.userId);
        } catch (e) {
          set({ lastSyncError: e instanceof Error ? e.message : "Failed to refresh from the cloud" });
          return;
        }
        set((cur) => {
          // Products/aliases: upsert by id over the existing arrays (additive - a product this
          // device does not know about yet is ADDED; an existing id is refreshed to the remote's
          // version, since products/aliases are not counted-quantity state and always safe to take
          // the server's word for, matching the trust model everywhere else in this app).
          const productsById = new Map(cur.products.map((p) => [p.id, p]));
          for (const p of data.products) productsById.set(p.id, p);
          const aliasesById = new Map(cur.aliases.map((a) => [a.id, a]));
          for (const a of data.aliases) aliasesById.set(a.id, a);
          const sessionsById = new Map(cur.sessions.map((s) => [s.id, s]));
          // Preserve previously refreshed history and fold in the current session before applying
          // the remote list, so a refresh never silently drops this device's own active session.
          if (cur.currentSession) sessionsById.set(cur.currentSession.id, cur.currentSession);
          for (const s of data.sessions) sessionsById.set(s.id, s);

          // finalCounts: additive upsert by (sessionId,productId), EXCEPT any row still referenced by
          // a pending (unsynced) queue item - that row's local value is authoritative until it syncs.
          const pendingProductIds = new Set(
            cur.pendingSyncQueue
              .filter((it) => it.operation === "INCREMENT_COUNT")
              .map((it) => (it.payload as { productId?: string } | undefined)?.productId)
              .filter((id): id is string => !!id),
          );
          const countsByKey = new Map(cur.finalCounts.map((c) => [`${c.sessionId}|${c.productId}`, c]));
          for (const remote of data.counts) {
            const key = `${remote.sessionId}|${remote.productId}`;
            if (pendingProductIds.has(remote.productId)) continue; // guard: unsynced local wins
            countsByKey.set(key, remote);
          }

          return {
            products: [...productsById.values()],
            aliases: [...aliasesById.values()],
            sessions: [...sessionsById.values()],
            finalCounts: [...countsByKey.values()],
            lastSyncError: null,
          };
        });
      },
```

Note: `businessDataLoader.ts` itself needs no modification for this task (Task 6 already added `getScanEventsBySession` as a separate function; `loadBusinessData`'s existing four-collection shape is exactly what `refreshFromCloud` consumes, unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/refreshFromCloud.store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/stores/refreshFromCloud.store.test.ts
git commit -m "feat(phase3): refreshFromCloud additive inbound merge, never clobbers unsynced local counts"
```

---

## Task 8: Two-device concurrent-scan emulator proof + manual refresh wiring

**Files:**
- Modify: `src/services/db/firebase/sessionPersistence.rules.test.ts`
- Modify: `src/components/SyncStatusBar.tsx`
- Test (Playwright, mock-config only - the two-device emulator test below is the true cross-device proof, not Playwright): none new (covered by the emulator test).

**Interfaces:**
- Consumes: `FirebaseSyncTarget` (existing), `env.authenticatedContext` (existing `@firebase/rules-unit-testing` pattern, per `firebaseSyncTarget.rules.test.ts:40`), `refreshFromCloud` (Task 7).
- Produces: nothing new exported; adds the missing true-two-instance concurrency proof the sync scout flagged as absent (scout-sync section 5: "no test literally instantiating two FirebaseSyncTargets... to prove true multi-device concurrency"), and a manual "Refresh" button wired to `refreshFromCloud` in the existing sync status bar. That refresh fills Task 7's `sessions` state, so Task 3's cloud `listSessions` and `reopenSession` immediately expose the complete refreshed history rather than deferring any read-path work.

- [ ] **Step 1: Write the failing test**

Append to `src/services/db/firebase/sessionPersistence.rules.test.ts`, inside its existing `describe.skipIf(!ready)` block:

```typescript
  it("TWO SEPARATE FirebaseSyncTarget instances (simulating two devices) concurrently scanning the SAME product accumulate correctly, no lost update", async () => {
    const deviceA = new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
    const deviceB = new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
    const mkItem = (key: string, scanEventId: string): PendingSyncItem => ({
      id: scanEventId, businessId: BIZ, sessionId: SID, entityType: "InventoryCount", entityId: `${SID}_${PID}`,
      operation: "INCREMENT_COUNT",
      payload: { businessId: BIZ, sessionId: SID, productId: PID, scanEventId, quantityDelta: 1, idempotencyKey: key },
      status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t",
      idempotencyKey: key, scanEventId,
    });
    // 5 scans from device A, 5 from device B, fully interleaved and concurrent (Promise.all), each
    // with its OWN distinct idempotency key (matching real distinct-scan behavior - see
    // idempotency.ts's "never regenerate a key inside a retry" law; these are 10 GENUINELY DIFFERENT
    // scans, not retries of one scan).
    const opsA = Array.from({ length: 5 }, (_, i) => deviceA.apply(mkItem(`devA-k${i}`, `devA-e${i}`)));
    const opsB = Array.from({ length: 5 }, (_, i) => deviceB.apply(mkItem(`devB-k${i}`, `devB-e${i}`)));
    const results = await Promise.all([...opsA, ...opsB]);
    expect(results.every((r) => r.ok)).toBe(true);
    const snap = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${SID}_${PID}`));
    const data = snap.data() as { countedQuantity: number; scanEventIds: string[] };
    expect(data.countedQuantity).toBe(10); // qty = 20 scenario from the master plan's AC2, scaled to 10 for test speed
    expect(new Set(data.scanEventIds).size).toBe(10); // all ten distinct scanEventIds present, no loss
  });
```

Confirm the required imports (`FirebaseSyncTarget`, `PendingSyncItem`, `getDoc`, `doc`, `Firestore`) already exist at the top of `sessionPersistence.rules.test.ts` per its existing test bodies; add any missing ones (this file already imports `FirebaseSyncTarget` and Firestore doc helpers for its existing session tests, per the scout's citations at `sessionPersistence.rules.test.ts:90-140`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:firebase`
Expected: the new test either PASSES immediately (since the underlying transaction mechanics already exist and are correct per the scout's analysis - this task's real job is adding the MISSING proof, not fixing a bug) or, if the emulator's transaction retry under this exact interleaving reveals a genuine defect, FAILS with a `countedQuantity` less than 10, which would be a real bug to root-cause via `superpowers:systematic-debugging` before proceeding (do not weaken the assertion to "pass" a real lost-update bug).

- [ ] **Step 3: (No production code change expected; if Step 2 failed, the fix belongs in `firebaseSyncTarget.ts`'s transaction body, not this test file - re-run `npm run test:firebase` after any such fix)**

Wire the manual refresh button. Read `src/components/SyncStatusBar.tsx` first to find its existing button pattern (it already has a `retrySync` button per the master plan's reference to "the visible Retry button", `scanStore.ts:1938`), then add a sibling button:

```tsx
// Add inside SyncStatusBar.tsx's existing button row, alongside the existing Retry button:
          <button
            type="button"
            data-testid="refresh-from-cloud"
            onClick={() => void refreshFromCloud()}
            className="inline-flex min-h-[36px] items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Refresh
          </button>
```

Add the store hook at the top of the component function (alongside its existing `useScanStore` calls):

```typescript
  const refreshFromCloud = useScanStore((s) => s.refreshFromCloud);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:firebase`
Expected: PASS, including the new two-device test.

Run: `npx vitest run src/components` (or the dom project covering `SyncStatusBar`)
Expected: PASS, no regression from the new button (if `SyncStatusBar.test.tsx` exists and snapshot-asserts the exact button list, update its expected button count/labels rather than deleting the assertion).

- [ ] **Step 5: Commit**

```bash
git add src/services/db/firebase/sessionPersistence.rules.test.ts src/components/SyncStatusBar.tsx
git commit -m "test(phase3): true two-instance concurrent cross-device scan proof; wire manual cloud refresh button"
```

---

## Task 9: Stamp `location` and `deviceId` onto fresh processScan events and InventoryCount rows at scan time

**Files:**
- Modify: `src/stores/scanStore.ts`
- Modify: `src/services/security/sensitiveFields.ts`
- Test: `src/stores/scanLocation.store.test.ts` (new)
- Test: `src/stores/scanPersist.test.ts` (extend)

**Interfaces:**
- Consumes: `ScanState.location` (Task 5), `ScanState.deviceId` (Task 3), the existing `ScanEvent`/`InventoryCount` mint sites inside `processScan`, and `CUSTOMER_SAFE_SCANEVENT_FIELDS` in `src/services/security/sensitiveFields.ts`.
- Produces: every fresh `ScanEvent` literal inside `processScan` carries `location: get().location` and `deviceId: get().deviceId ?? undefined` (spread-built events inherit the stamp from their base; the `markWrong` residual literal outside `processScan` is deliberately unstamped); `InventoryCount.location` is updated to the scan's location on every increment (most-recent-wins, matching the "defaults to session location until changed" rule from the master plan). Customer-role persistence retains `location` but deliberately excludes attribution-only `deviceId`. Consumed by Task 8's session detail page (displays per-scan location) and CSV exports (Task 10).

- [ ] **Step 1: Write the failing test**

```typescript
// src/stores/scanLocation.store.test.ts
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("location/deviceId stamping on scan", () => {
  it("a scan taken after setLocation('Bay A') carries location 'Bay A' on the ScanEvent and InventoryCount", () => {
    const store = createTestScanStore({});
    store.getState().setLocation("Bay A");
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0];
    expect(row.location).toBe("Bay A");
    const count = store.getState().finalCounts.find((c) => c.productId === row.matchedProductId);
    expect(count?.location).toBe("Bay A");
  });

  it("changing location mid-session updates the count's location to the MOST RECENT scan's location", () => {
    const store = createTestScanStore({});
    store.getState().setLocation("Bay A");
    store.getState().processScan("012345678905");
    store.getState().setLocation("Bay B");
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0]; // newest first
    expect(row.location).toBe("Bay B");
    const count = store.getState().finalCounts.find((c) => c.productId === row.matchedProductId);
    expect(count?.location).toBe("Bay B");
  });

  it("defaults to the session's location before any explicit setLocation call", () => {
    const store = createTestScanStore({});
    store.getState().startSession("Session A", "Warehouse");
    // startSession does not itself call setLocation; the store's `location` field defaults to "Main"
    // at boot (Task 5) and is independent of the session's own `location` label unless the caller
    // (the scan page, Task 5) explicitly syncs them. This test documents the CURRENT store-level
    // contract: location stamping always uses ScanState.location, not currentSession.location.
    store.getState().processScan("012345678905");
    const row = store.getState().scanFeed[0];
    expect(row.location).toBe("Main");
  });
});
```

Also append this assertion to `src/stores/scanPersist.test.ts`, using its existing `makeState()` helper:

```typescript
  it("customer: persisted feed retains location but not attribution-only deviceId", () => {
    const s = makeState();
    const first = s.scanFeed[0] as Record<string, unknown>;
    s.scanFeed = [{ ...first, location: "Bay A", deviceId: "device-a" }];
    const persisted = buildPersistedScanState(s, "business");
    const feed = persisted.scanFeed as Array<Record<string, unknown>>;
    expect(feed[0].location).toBe("Bay A");
    expect(feed[0].deviceId).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/scanLocation.store.test.ts`
Expected: FAIL - `row.location` and `count?.location` are `undefined` (fields not yet stamped).

- [ ] **Step 3: Write minimal implementation**

First, modify `CUSTOMER_SAFE_SCANEVENT_FIELDS` in `src/services/security/sensitiveFields.ts`. Add `"location"` alongside the event's other customer-visible fields:

```typescript
export const CUSTOMER_SAFE_SCANEVENT_FIELDS = [
  "id", "businessId", "sessionId", "matchedProductId", "cleanCode", "location",
  "status", "resolverStatus", "reason", "quantityDelta", "quantityAfterScan",
  "decodeStatus", "syncStatus", "createdAt", "source", "idempotencyKey",
] as const;
```

Do NOT add `deviceId` to `CUSTOMER_SAFE_SCANEVENT_FIELDS`. It is attribution-only metadata and is deliberately excluded from customer-role local persistence.

Find the `ScanEvent` object literal construction inside `processScan` (the exact object built for a "known" match - search for the first `matchType: resolution.matchType` or similar inside `processScan`, which per the scout is deep inside `scanStore.ts` past line 1478). Rather than locating one single literal (there are multiple branches - known/unknown/conflict, per the scout's file map), add a small pure helper used by every qualifying fresh literal inside `processScan`, and call it uniformly:

Add this helper function near `makeQueueItem` (`scanStore.ts:736`), directly above it:

```typescript
/** Phase 3: stamp the current location + deviceId onto a freshly-built ScanEvent. Applied uniformly
 *  to every fresh ScanEvent literal inside processScan. Spread-built events inherit the stamp from
 *  their base; the markWrong residual literal outside processScan is deliberately unstamped. Pure -
 *  takes the values, does not read the store itself. */
function stampScanEventLocation<T extends { location?: string; deviceId?: string }>(
  event: T,
  location: string,
  deviceId: string | null,
): T {
  return { ...event, location, deviceId: deviceId ?? undefined };
}
```

At the TOP of `processScan` (immediately after the two guard clauses added in Task 3, before `const cleaned = cleanScanCode(rawInput);`), capture the location/deviceId once so every branch below uses the same snapshot (avoids a race where `location` changes mid-function):

```typescript
      processScan: (rawInput) => {
        if (get().currentSession?.locked) return null;
        if (get().currentSession?.status === "completed") return null;
        const scanLocation = get().location;
        const scanDeviceId = get().deviceId;
        const cleaned = cleanScanCode(rawInput);
```

Then, stamp every fresh `ScanEvent` literal inside `processScan` (spread-built events inherit the stamp from their base; the `markWrong` residual literal outside `processScan` is deliberately unstamped). At each such full literal that is set into `scanFeed` or enqueued via `SAVE_SCAN_EVENT`, wrap the constructed event with `stampScanEventLocation(event, scanLocation, scanDeviceId)` before it is used. Concretely, change each qualifying `const event: ScanEvent = {` (or equivalently-named) literal inside `processScan` from:

```typescript
        const event: ScanEvent = {
          // ...existing fields...
        };
```

to:

```typescript
        const event: ScanEvent = stampScanEventLocation(
          {
            // ...existing fields, UNCHANGED...
          },
          scanLocation,
          scanDeviceId,
        );
```

(Locate candidates via `grep -n "ScanEvent = {" src/stores/scanStore.ts` before editing, then classify each hit by scope. Wrap every fresh literal inside `processScan`; do not wrap the `markWrong` residual literal outside it. Spread-built events need no separate wrap because their stamped base already carries `location`/`deviceId`. Do not alter any field already present in a qualifying literal - `stampScanEventLocation` only adds `location`/`deviceId`.)

For `InventoryCount.location`: find `ensureProvisionalCount`'s and the "known match" branch's `InventoryCount` upsert (the code that increments `finalCounts` inside `processScan`, e.g. `applyScanEventOnce` call sites or direct `finalCounts` array updates). Since `services/inventory.ts`'s `applyScanEventOnce` is the pure count-math core (per CLAUDE.md architecture map) and must stay a pure service function, do NOT add `location` there as a hidden side channel through the ledger math - instead, stamp `location` onto the `InventoryCount` row in the SAME `set()` call in `scanStore.ts` that already applies `applyScanEventOnce`'s result, immediately after it, as a shallow patch:

```typescript
        // After the existing applyScanEventOnce(...) call that produces the updated finalCounts array
        // for this scan (wherever that call site is inside processScan's known-match branch), patch in
        // the current scan's location onto the affected count row (most-recent-scan-wins, never
        // retroactive to older scans of the same product):
        finalCounts: nextFinalCounts.map((c) =>
          c.productId === event.matchedProductId && c.sessionId === event.sessionId
            ? { ...c, location: scanLocation }
            : c,
        ),
```

(Adapt the exact variable name `nextFinalCounts` to whatever the existing `set({...})` call in that branch already names its computed array - do not introduce a second, parallel `finalCounts` computation; patch the SAME array the existing code already builds and sets, immediately before it is passed to `set()`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/scanLocation.store.test.ts`
Expected: PASS (3 tests).

Run: `npx vitest run src/stores/scanPersist.test.ts`
Expected: PASS, including the customer-role assertion that `location` survives while `deviceId` does not.

Run: `npm run test:ledger`
Expected: PASS, unchanged - the `location`/`deviceId` fields are additive display metadata, never part of the ledger math (`applyScanEventOnce` itself is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/services/security/sensitiveFields.ts src/stores/scanLocation.store.test.ts src/stores/scanPersist.test.ts
git commit -m "feat(phase3): stamp location and deviceId on processScan events and count rows"
```

---

## Task 10: Session detail/timeline page + per-session CSV export

**Files:**
- Create: `src/app/(app)/sessions/[id]/page.tsx`
- Modify: `src/components/SessionsList.tsx`
- Modify: `src/services/csvExport.ts`
- Test: `src/services/csvExport.test.ts` (extend if it exists, else create)
- Test (Playwright): `e2e/phase3-session-timeline.spec.ts`

**Interfaces:**
- Consumes: `getScanEventsBySession` (Task 6, via the store's injected `db`), `ScanEvent.location`/`deviceId` (Task 9), existing `exportRawScanLog`/`buildCsv` pattern (`csvExport.ts:24-28,129-155`).
- Produces: `exportSessionScanLog(events: ScanEvent[]): string` (session-scoped scan-level CSV, extends the existing `exportRawScanLog` column set with a `location` column); a new page route `/sessions/[id]` rendering the timeline. Consumed by nothing further in this plan (a leaf UI feature).

- [ ] **Step 1: Write the failing test**

```typescript
// Append to src/services/csvExport.test.ts (create the file with just this import block + describe if
// it does not already exist in the repo)
import { describe, it, expect } from "vitest";
import { exportSessionScanLog } from "@/services/csvExport";
import type { ScanEvent } from "@/types";

describe("exportSessionScanLog", () => {
  it("includes a location column and the scan's stamped location value", () => {
    const event: ScanEvent = {
      id: "e1", businessId: "b1", sessionId: "s1", rawCode: "123", cleanCode: "123",
      normalizedCandidates: ["123"], matchedProductId: "p1", matchType: "upc", status: "known",
      resolverStatus: "known", codeType: "upc_a", reason: "matched", quantityDelta: 1,
      quantityAfterScan: 1, createdAt: "2026-07-19T16:00:00.000Z", source: "scan", notes: "",
      syncStatus: "synced", syncError: null, idempotencyKey: "k1", location: "Bay A",
    };
    const csv = exportSessionScanLog([event]);
    expect(csv).toContain("location");
    expect(csv).toContain("Bay A");
  });

  it("renders an empty location as a blank field, never the literal 'undefined'", () => {
    const event: ScanEvent = {
      id: "e1", businessId: "b1", sessionId: "s1", rawCode: "123", cleanCode: "123",
      normalizedCandidates: ["123"], matchedProductId: null, matchType: "unknown", status: "unknown",
      resolverStatus: "needs_review", codeType: "numeric_sku", reason: "no match", quantityDelta: 1,
      quantityAfterScan: 1, createdAt: "2026-07-19T16:00:00.000Z", source: "scan", notes: "",
      syncStatus: "synced", syncError: null, idempotencyKey: "k1",
    };
    const csv = exportSessionScanLog([event]);
    expect(csv).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/csvExport.test.ts`
Expected: FAIL with `exportSessionScanLog is not exported`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/csvExport.ts`, directly after the existing `exportRawScanLog` function (`csvExport.ts:129-155`):

```typescript
/** Session-scoped scan-level CSV for a single session's timeline (Phase 3 session detail page).
 *  Same shape as exportRawScanLog plus a location column - kept as a SEPARATE function (not a param
 *  on exportRawScanLog) since the two call sites have different audiences (whole-account raw log vs.
 *  one session's timeline export). */
export function exportSessionScanLog(events: ScanEvent[]): string {
  const headers = [
    "time",
    "raw_code",
    "clean_code",
    "match_type",
    "matched_product_id",
    "status",
    "quantity_after_scan",
    "location",
    "sync_status",
  ];
  const rows = events.map((e) => [
    e.createdAt,
    e.rawCode,
    e.cleanCode,
    e.matchType,
    e.matchedProductId ?? "",
    e.status,
    e.quantityAfterScan,
    e.location ?? "",
    e.syncStatus,
  ]);
  return buildCsv(headers, rows);
}
```

Create the session detail page:

```tsx
// src/app/(app)/sessions/[id]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";
import { exportSessionScanLog } from "@/services/csvExport";
import { downloadCsv } from "@/services/exportFormats";
import type { ScanEvent } from "@/types";

// Phase 3 session detail/timeline: click-through from SessionsList. Reads via the store's injected db
// (Task 6's getScanEventsBySession), so it works on BOTH the mock and Firebase backends without this
// page knowing which one is active.
export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const businessId = useScanStore((s) => s.businessId);
  const listSessions = useScanStore((s) => s.listSessions);
  const [events, setEvents] = useState<ScanEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const session = listSessions().find((s) => s.id === sessionId);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    void useScanStore
      .getState()
      .getSessionTimeline(sessionId)
      .then((result) => {
        if (!cancelled) setEvents(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this session's timeline.");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <Link href="/scan" className="text-sm text-blue-700 hover:underline">
        &larr; Back to scan
      </Link>
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h1 className="text-xl font-semibold text-zinc-900" data-testid="session-detail-name">
          {session?.name ?? sessionId}
        </h1>
        <p className="text-sm text-zinc-600">
          {session ? `${session.location} - ${session.status} - ${new Date(session.startedAt).toLocaleString()}` : ""}
        </p>
        {events && events.length > 0 && (
          <button
            type="button"
            data-testid="export-session-timeline"
            onClick={() => downloadCsv(exportSessionScanLog(events), `session-${sessionId}-timeline`)}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Export timeline CSV
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full border-collapse text-left text-sm" data-testid="session-timeline-table">
          <thead className="border-b border-zinc-200 bg-zinc-50 font-semibold text-zinc-700">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Qty</th>
              <th className="px-4 py-2">Location</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-red-600">
                  {error}
                </td>
              </tr>
            ) : events === null ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  Loading...
                </td>
              </tr>
            ) : events.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No scans in this session yet.
                </td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.id} className="border-t border-zinc-100" data-testid={`timeline-row-${e.id}`}>
                  <td className="px-4 py-2">{new Date(e.createdAt).toLocaleTimeString()}</td>
                  <td className="px-4 py-2 font-mono">{e.cleanCode}</td>
                  <td className="px-4 py-2">{e.status}</td>
                  <td className="px-4 py-2">{e.quantityAfterScan}</td>
                  <td className="px-4 py-2">{e.location ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Add the `getSessionTimeline` store action this page depends on. Add to the `ScanState` interface, after `refreshFromCloud: () => Promise<void>;`:

```typescript
  /** Phase 3: read a session's full scan timeline (oldest first) via the injected db, working on
   *  both the mock and Firebase backends without the caller needing to know which is active. */
  getSessionTimeline: (sessionId: string) => Promise<ScanEvent[]>;
```

Implement it directly after `refreshFromCloud`:

```typescript
      getSessionTimeline: async (sessionId) => {
        const { businessId } = get();
        if (!db.getScanEventsBySession) return [];
        return await db.getScanEventsBySession(businessId, sessionId);
      },
```

Modify `src/components/SessionsList.tsx`: add date + time and wrap each row in a link. Replace the date-only line (currently `SessionsList.tsx:29-32`):

```tsx
                <div className="text-xs text-zinc-500">
                  {s.location} · {s.status}
                  {s.startedAt ? ` · ${new Date(s.startedAt).toLocaleDateString()}` : ""}
                </div>
```

with:

```tsx
                <div className="text-xs text-zinc-500">
                  {s.location} · {s.status}
                  {s.startedAt ? ` · ${new Date(s.startedAt).toLocaleString()}` : ""}
                </div>
```

and add a "View" link next to the existing Open button (inside the same `<li>`, after the existing `<button>`):

```tsx
              <a
                href={`/sessions/${s.id}`}
                data-testid={`view-session-${s.id}`}
                className="inline-flex min-h-[36px] items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                View
              </a>
```

- [ ] **Step 4: Write the Playwright proof**

```typescript
// e2e/phase3-session-timeline.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Phase 3: session history log with time + full timeline", () => {
  test("scanning without starting a session shows it in the log with date+time; clicking View shows the full timeline", async ({ page }) => {
    await page.goto("/scan");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await page.getByLabel("new session name").fill("Second Session");
    await page.getByTestId("start-session").click();
    await expect(page.getByTestId("sessions-list")).toBeVisible();
    const viewLinks = page.locator('[data-testid^="view-session-"]');
    await viewLinks.first().click();
    await expect(page.getByTestId("session-timeline-table")).toBeVisible();
  });

  test("phone viewport (390px): session timeline table renders without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/scan");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await page.getByLabel("new session name").fill("Phone Session");
    await page.getByTestId("start-session").click();
    const viewLinks = page.locator('[data-testid^="view-session-"]');
    await viewLinks.first().click();
    await expect(page.getByTestId("session-timeline-table")).toBeVisible();
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "e2e/proof/phase3-session-timeline-phone.png", fullPage: true });
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/csvExport.test.ts`
Expected: PASS (2 tests).

Run: `npm run test:e2e -- phase3-session-timeline.spec.ts`
Expected: PASS, screenshot written. Adjust the `getByRole("textbox", { name: /scan/i })` selector to match `ScannerInput`'s real accessible name/id if it differs (confirm via `src/components/ScannerInput.tsx` before assuming).

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/sessions/\[id\]/page.tsx src/components/SessionsList.tsx src/services/csvExport.ts src/services/csvExport.test.ts src/stores/scanStore.ts e2e/phase3-session-timeline.spec.ts e2e/proof/phase3-session-timeline-phone.png
git commit -m "feat(phase3): session detail/timeline page with per-session CSV export"
```

---

## Task 11: Boss Report data aggregation (pure) + print page

**Files:**
- Create: `src/services/reports/bossReport.ts`
- Test: `src/services/reports/bossReport.test.ts`
- Create: `src/app/(app)/report/page.tsx`
- Test (Playwright): `e2e/phase3-boss-report.spec.ts`

**Interfaces:**
- Consumes: `computeMoatStats` (Task 5), `ScanEvent`/`Product`/`InventoryCount` (existing), `CountSnapshot`/`computeVariance` (existing, `src/services/reports/varianceReport.ts`).
- Produces: `buildBossReport(input: BossReportInput): BossReportData` with `interface BossReportInput { products: Product[]; finalCounts: InventoryCount[]; scanFeed: ScanEvent[]; sessionName: string; countedBy: string; countedAt: string; previousSnapshot?: CountSnapshot; }` and `interface BossReportData { totalItems: number; moat: MoatStats; byBrand: Array<{ brand: string; qty: number }>; byCategory: Array<{ category: string; qty: number }>; totalValue: number | null; hasAnyCostData: boolean; topVariances: VarianceRow[]; sessionName: string; countedBy: string; countedAt: string; }`. Consumed by Task 12 (share route re-runs this same function server-side) and the report page itself.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/reports/bossReport.test.ts
import { describe, it, expect } from "vitest";
import { buildBossReport } from "@/services/reports/bossReport";
import type { Product, InventoryCount, ScanEvent } from "@/types";

function product(id: string, name: string, brand: string, category: string, unitCost?: number): Product {
  return {
    id, businessId: "b1", name, brand, category, specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "",
    productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1,
    verified: true, createdAt: "t", updatedAt: "t", createdBy: "u", updatedBy: "u", unitCost,
  } as Product;
}

function count(productId: string, quantity: number): InventoryCount {
  return {
    id: `c-${productId}`, businessId: "b1", sessionId: "s1", productId, quantity, lastScannedAt: "t",
    aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t", syncStatus: "synced",
    syncError: null, appliedIdempotencyKeys: [],
  };
}

function scan(resolverStatus: string): ScanEvent {
  return {
    id: `e-${Math.random()}`, businessId: "b1", sessionId: "s1", rawCode: "1", cleanCode: "1",
    normalizedCandidates: [], matchedProductId: null, matchType: "unknown", status: "unknown",
    resolverStatus: resolverStatus as ScanEvent["resolverStatus"], codeType: "numeric_sku", reason: "",
    quantityDelta: 1, quantityAfterScan: 1, createdAt: "t", source: "scan", notes: "",
    syncStatus: "synced", syncError: null, idempotencyKey: "k",
  };
}

describe("buildBossReport", () => {
  it("totals items, groups by brand and category", () => {
    const products = [product("p1", "Widget A", "Acme", "Tools"), product("p2", "Widget B", "Acme", "Tools"), product("p3", "Gadget", "Zeta", "Electronics")];
    const counts = [count("p1", 3), count("p2", 2), count("p3", 5)];
    const report = buildBossReport({ products, finalCounts: counts, scanFeed: [scan("known"), scan("needs_review")], sessionName: "Jul 19", countedBy: "Owner", countedAt: "2026-07-19T16:00:00.000Z" });
    expect(report.totalItems).toBe(10);
    expect(report.byBrand).toEqual(expect.arrayContaining([{ brand: "Acme", qty: 5 }, { brand: "Zeta", qty: 5 }]));
    expect(report.byCategory).toEqual(expect.arrayContaining([{ category: "Tools", qty: 5 }, { category: "Electronics", qty: 5 }]));
    expect(report.moat).toEqual({ total: 2, identified: 1 });
  });

  it("computes total value ONLY when at least one product has unitCost - never fabricates a value", () => {
    const products = [product("p1", "Widget A", "Acme", "Tools", 10.5), product("p2", "Widget B", "Acme", "Tools")];
    const counts = [count("p1", 2), count("p2", 3)];
    const report = buildBossReport({ products, finalCounts: counts, scanFeed: [], sessionName: "s", countedBy: "u", countedAt: "t" });
    expect(report.hasAnyCostData).toBe(true);
    expect(report.totalValue).toBe(21); // 2 * 10.5 + 3 * (no cost, contributes 0)
  });

  it("totalValue is null and hasAnyCostData is false when NO product has cost data (never fabricates a value)", () => {
    const products = [product("p1", "Widget A", "Acme", "Tools")];
    const counts = [count("p1", 2)];
    const report = buildBossReport({ products, finalCounts: counts, scanFeed: [], sessionName: "s", countedBy: "u", countedAt: "t" });
    expect(report.hasAnyCostData).toBe(false);
    expect(report.totalValue).toBeNull();
  });

  it("returns an empty topVariances array when no previousSnapshot is given", () => {
    const report = buildBossReport({ products: [], finalCounts: [], scanFeed: [], sessionName: "s", countedBy: "u", countedAt: "t" });
    expect(report.topVariances).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/reports/bossReport.test.ts`
Expected: FAIL with `Cannot find module '@/services/reports/bossReport'`.

- [ ] **Step 3: Write minimal implementation**

First, add the optional cost field to `Product` in `src/types.ts`, inside the `Product` interface, after `location: string;`:

```typescript
  /** Phase 3 (Boss Report inventory value): optional per-unit cost, manually entered or imported via
   *  a distinct products-CSV column (never the Shop-Ware reconcile importer, which deliberately drops
   *  price/cost columns by design - see shopwareCsvAdapter.ts). Undefined = no cost data for this
   *  product; the Boss Report's value total is computed ONLY over products that HAVE this set, and is
   *  shown as null (never fabricated as 0 or omitted silently) when NO product in the report has it. */
  unitCost?: number;
```

Now create `src/services/reports/bossReport.ts`:

```typescript
// src/services/reports/bossReport.ts
// Pure aggregation for the Boss Report (master plan P3: "the artifact that closes"). No React, no
// next/*, no fetch - takes already-loaded store data and produces a display-ready shape. The
// server-side share route (Task 12) re-runs this SAME function against server-loaded data, so the
// public share link and the logged-in report page are guaranteed to render identically.
import type { Product, InventoryCount, ScanEvent } from "@/types";
import { computeMoatStats, type MoatStats } from "@/services/moatStats";
import { computeVariance, type CountSnapshot, type VarianceRow } from "@/services/reports/varianceReport";

export interface BossReportInput {
  products: Product[];
  finalCounts: InventoryCount[];
  scanFeed: ScanEvent[];
  sessionName: string;
  countedBy: string;
  countedAt: string;
  previousSnapshot?: CountSnapshot;
  currentSnapshotForVariance?: CountSnapshot;
}

export interface BossReportData {
  totalItems: number;
  moat: MoatStats;
  byBrand: Array<{ brand: string; qty: number }>;
  byCategory: Array<{ category: string; qty: number }>;
  totalValue: number | null;
  hasAnyCostData: boolean;
  topVariances: VarianceRow[];
  sessionName: string;
  countedBy: string;
  countedAt: string;
}

export function buildBossReport(input: BossReportInput): BossReportData {
  const byId = new Map(input.products.map((p) => [p.id, p]));
  let totalItems = 0;
  const brandQty = new Map<string, number>();
  const categoryQty = new Map<string, number>();
  let hasAnyCostData = false;
  let totalValue = 0;

  for (const c of input.finalCounts) {
    const p = byId.get(c.productId);
    totalItems += c.quantity;
    const brand = p?.brand || "Unknown";
    const category = p?.category || "Uncategorized";
    brandQty.set(brand, (brandQty.get(brand) ?? 0) + c.quantity);
    categoryQty.set(category, (categoryQty.get(category) ?? 0) + c.quantity);
    if (p?.unitCost !== undefined) {
      hasAnyCostData = true;
      totalValue += p.unitCost * c.quantity;
    }
  }

  const topVariances =
    input.previousSnapshot && input.currentSnapshotForVariance
      ? computeVariance(input.previousSnapshot, input.currentSnapshotForVariance)
          .filter((r) => r.delta !== 0)
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          .slice(0, 10)
      : [];

  return {
    totalItems,
    moat: computeMoatStats(input.scanFeed),
    byBrand: [...brandQty.entries()].map(([brand, qty]) => ({ brand, qty })),
    byCategory: [...categoryQty.entries()].map(([category, qty]) => ({ category, qty })),
    totalValue: hasAnyCostData ? totalValue : null,
    hasAnyCostData,
    topVariances,
    sessionName: input.sessionName,
    countedBy: input.countedBy,
    countedAt: input.countedAt,
  };
}
```

Note: confirm `src/services/reports/varianceReport.ts` exports `CountSnapshot`/`VarianceRow`/`computeVariance` with exactly this shape (per scout-report section 3: `CountSnapshot` at line 6, `VarianceRow` at line 13, `computeVariance(a, b)` at line 37) before finalizing this import - if the exported names differ slightly, adjust the import statement only, not the aggregation logic.

Now create the report page:

```tsx
// src/app/(app)/report/page.tsx
"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { buildBossReport } from "@/services/reports/bossReport";

// Boss Report: printable, one page, shows the moat line up top per the master plan's exact spec
// ("142 of 150 items identified automatically - no manual entry", same wording pattern as the scan
// page's moat line). window.print() uses the print CSS in globals.css (added by this task).
export default function BossReportPage() {
  const products = useScanStore((s) => s.products);
  const finalCounts = useScanStore((s) => s.finalCounts);
  const scanFeed = useScanStore((s) => s.scanFeed);
  const session = useScanStore((s) => s.currentSession);
  const userId = useScanStore((s) => s.userId);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const report = buildBossReport({
    products,
    finalCounts,
    scanFeed,
    sessionName: session?.name ?? "Current session",
    countedBy: userId ?? "Owner",
    countedAt: new Date().toISOString(),
  });

  async function handleShare() {
    setSharing(true);
    setShareError(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session?.id ?? "" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setShareError(body.error ?? "Could not create a shareable link right now.");
        return;
      }
      const body = await res.json();
      setShareUrl(body.url);
    } catch {
      setShareError("Could not create a shareable link right now.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 print:p-0">
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold text-zinc-900">Boss Report</h1>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="print-report"
            onClick={() => window.print()}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Print
          </button>
          <button
            type="button"
            data-testid="share-report"
            disabled={sharing || !session}
            onClick={() => void handleShare()}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {sharing ? "Creating link..." : "Get shareable link"}
          </button>
        </div>
      </div>
      {shareError && (
        <p className="text-sm text-red-600 print:hidden" data-testid="share-error">
          {shareError}
        </p>
      )}
      {shareUrl && (
        <p className="text-sm text-zinc-700 print:hidden" data-testid="share-url">
          Share this link: <a href={shareUrl} className="text-blue-700 underline">{shareUrl}</a>
        </p>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-6 print:border-0 print:p-0" data-testid="boss-report-body">
        <p className="text-lg font-semibold text-emerald-700" data-testid="report-moat-line">
          {report.moat.identified} of {report.moat.total} items identified automatically - no manual entry
        </p>
        <h2 className="mt-4 text-2xl font-bold text-zinc-900">{report.sessionName}</h2>
        <p className="text-sm text-zinc-600">
          Counted by {report.countedBy} on {new Date(report.countedAt).toLocaleString()}
        </p>
        <p className="mt-4 text-lg" data-testid="report-total-items">
          Total items: <strong>{report.totalItems}</strong>
        </p>
        {report.hasAnyCostData && (
          <p className="text-lg" data-testid="report-total-value">
            Estimated value: <strong>${report.totalValue!.toFixed(2)}</strong>
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <h3 className="font-semibold text-zinc-800">By brand</h3>
            <ul className="text-sm text-zinc-700">
              {report.byBrand.map((b) => (
                <li key={b.brand}>{b.brand}: {b.qty}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-zinc-800">By category</h3>
            <ul className="text-sm text-zinc-700">
              {report.byCategory.map((c) => (
                <li key={c.category}>{c.category}: {c.qty}</li>
              ))}
            </ul>
          </div>
        </div>
        {report.topVariances.length > 0 && (
          <div className="mt-4">
            <h3 className="font-semibold text-zinc-800">Top variances</h3>
            <ul className="text-sm text-zinc-700">
              {report.topVariances.map((v) => (
                <li key={v.productId}>{v.name}: {v.delta > 0 ? "+" : ""}{v.delta}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
```

Add print CSS to the project's global stylesheet (find the existing `src/app/globals.css` and append):

```css
@media print {
  nav, header, .print\:hidden {
    display: none !important;
  }
  body {
    background: white;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/reports/bossReport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the Playwright proof (print only in this task; share-link proof is Task 12)**

```typescript
// e2e/phase3-boss-report.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Phase 3: Boss Report", () => {
  test("shows the moat line, total items, and prints without the action buttons", async ({ page }) => {
    await page.goto("/scan");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await page.goto("/report");
    await expect(page.getByTestId("report-moat-line")).toBeVisible();
    await expect(page.getByTestId("report-total-items")).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("print-report")).toBeHidden();
    await expect(page.getByTestId("boss-report-body")).toBeVisible();
  });

  test("phone viewport (390px): report renders readably", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/scan");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await page.goto("/report");
    await expect(page.getByTestId("report-moat-line")).toBeVisible();
    await page.screenshot({ path: "e2e/proof/phase3-boss-report-phone.png", fullPage: true });
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/services/reports/bossReport.test.ts` and `npm run test:e2e -- phase3-boss-report.spec.ts`
Expected: PASS. Screenshot written to `e2e/proof/phase3-boss-report-phone.png`.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/services/reports/bossReport.ts src/services/reports/bossReport.test.ts src/app/\(app\)/report/page.tsx src/app/globals.css e2e/phase3-boss-report.spec.ts e2e/proof/phase3-boss-report-phone.png
git commit -m "feat(phase3): Boss Report aggregation, printable page, moat line, optional inventory value"
```

---

## Task 12: Shareable tokenized link - Turso KV store + mint/resolve API routes

**Files:**
- Create: `src/server/share/shareTokenStore.ts`
- Test: `src/server/share/shareTokenStore.test.ts`
- Create: `src/app/api/share/route.ts`
- Create: `src/app/api/share/[token]/route.ts`
- Create: `src/app/report/[token]/page.tsx`
- Test (Playwright): extend `e2e/phase3-boss-report.spec.ts`

**Interfaces:**
- Consumes: `LadderStorage`-style `get/set/increment` Turso pattern (`src/server/upc/storage.ts:100-108`, adapted, not imported directly since that interface is decode-ladder-specific), `buildBossReport` (Task 11), the `getAdminAuth().verifyIdToken` plus `businessMembers` membership pattern (existing, per `src/app/api/ai-lookup/route.ts`), `isLiveAuth`, and the documented `IS_E2E=1` bypass.
- Produces: `mintShareToken(payload: SharePayload, ttlMs: number): Promise<string>`, `resolveShareToken(token: string): Promise<SharePayload | null>` where `interface SharePayload { businessId: string; sessionId: string; reportSnapshot: BossReportData; createdAt: number; expiresAt: number }`. The mint POST requires verified membership in live mode, keeps the explicit mock/E2E bypass for demos and automated tests, and rejects request bodies over 32KB with 413. Consumed only within this task's two API routes and the public report page.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/share/shareTokenStore.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mintShareToken, resolveShareToken } from "@/server/share/shareTokenStore";

// No TURSO_DATABASE_URL/TURSO_AUTH_TOKEN in the test env -> the store degrades to its file/in-memory
// fallback, same pattern as decodeCacheStore.ts. Never touches a real Turso instance in tests.
describe("shareTokenStore (file/in-memory fallback path)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TURSO_DATABASE_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
  });

  it("mints a token and resolves it back to the same payload", async () => {
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: { totalItems: 5 } as unknown as import("@/services/reports/bossReport").BossReportData,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const token = await mintShareToken(payload, 60_000);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    const resolved = await resolveShareToken(token);
    expect(resolved?.businessId).toBe("b1");
    expect(resolved?.sessionId).toBe("s1");
  });

  it("returns null for an unknown token", async () => {
    const resolved = await resolveShareToken("nonexistent-token-xyz");
    expect(resolved).toBeNull();
  });

  it("returns null for an EXPIRED token (never leaks stale/expired report data)", async () => {
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: {} as unknown as import("@/services/reports/bossReport").BossReportData,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000, // already expired
    };
    const token = await mintShareToken(payload, -60_000);
    const resolved = await resolveShareToken(token);
    expect(resolved).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/share/shareTokenStore.test.ts`
Expected: FAIL with `Cannot find module '@/server/share/shareTokenStore'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/share/shareTokenStore.ts
import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { BossReportData } from "@/services/reports/bossReport";

// Server-only KV for Boss Report share tokens. Turso/libsql in production (same client-construction
// pattern as decodeCacheStore.ts / src/server/upc/storage.ts's Turso adapters), degrading to a
// best-effort local JSON file when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are absent (local dev / tests).
// A REPORT SNAPSHOT is stored at mint time (not a live re-query) so a share link keeps showing exactly
// what the owner shared, even if counts change afterward - this also sidesteps the mock-mode
// architectural fork noted by the scout (mock mode has no server-reachable live store to re-query).
export interface SharePayload {
  businessId: string;
  sessionId: string;
  reportSnapshot: BossReportData;
  createdAt: number;
  expiresAt: number;
}

type TursoClient = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

let _tursoClient: TursoClient | null | "unavailable" = null;
let _tableReady = false;
const DDL = "CREATE TABLE IF NOT EXISTS share_tokens (token TEXT PRIMARY KEY, payload TEXT, expires_at INTEGER)";

async function getTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient === "unavailable") return null;
  if (_tursoClient) return _tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    _tursoClient = "unavailable";
    return null;
  }
  try {
    const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
    _tursoClient = createClient({ url, authToken: token }) as TursoClient;
    return _tursoClient;
  } catch (e) {
    console.warn("[shareTokenStore] Failed to create Turso client:", (e as Error).message);
    _tursoClient = "unavailable";
    return null;
  }
}

async function ensureTable(client: TursoClient): Promise<boolean> {
  if (_tableReady) return true;
  try {
    await client.execute({ sql: DDL, args: [] });
    _tableReady = true;
    return true;
  } catch (e) {
    console.warn("[shareTokenStore] Failed to ensure share_tokens table:", (e as Error).message);
    return false;
  }
}

function fallbackFile(): string {
  return process.env.SHARE_TOKEN_FILE || path.resolve(".share-tokens.json");
}

type FileShape = Record<string, { payload: string; expiresAt: number }>;

function readFallback(): FileShape {
  try {
    if (!fs.existsSync(fallbackFile())) return {};
    return JSON.parse(fs.readFileSync(fallbackFile(), "utf8")) as FileShape;
  } catch {
    return {};
  }
}

function writeFallback(data: FileShape): void {
  try {
    fs.writeFileSync(fallbackFile(), JSON.stringify(data), "utf8");
  } catch {
    // best-effort only, never throw out of a share-link mint
  }
}

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function mintShareToken(payload: SharePayload, _ttlMs: number): Promise<string> {
  const token = newToken();
  const client = await getTursoClient();
  if (client && (await ensureTable(client))) {
    try {
      await client.execute({
        sql: "INSERT INTO share_tokens (token, payload, expires_at) VALUES (?, ?, ?)",
        args: [token, JSON.stringify(payload), payload.expiresAt],
      });
      return token;
    } catch (e) {
      console.warn("[shareTokenStore] Turso insert failed, falling back to file:", (e as Error).message);
    }
  }
  const data = readFallback();
  data[token] = { payload: JSON.stringify(payload), expiresAt: payload.expiresAt };
  writeFallback(data);
  return token;
}

export async function resolveShareToken(token: string): Promise<SharePayload | null> {
  const client = await getTursoClient();
  if (client && (await ensureTable(client))) {
    try {
      const res = await client.execute({ sql: "SELECT payload, expires_at FROM share_tokens WHERE token = ?", args: [token] });
      const row = res.rows[0];
      if (row) {
        const expiresAt = Number(row.expires_at);
        if (Date.now() > expiresAt) return null;
        return JSON.parse(String(row.payload)) as SharePayload;
      }
    } catch (e) {
      console.warn("[shareTokenStore] Turso read failed, falling back to file:", (e as Error).message);
    }
  }
  const data = readFallback();
  const entry = data[token];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return JSON.parse(entry.payload) as SharePayload;
}
```

Create the mint route. It reuses the existing `verifyIdToken` plus business-membership pattern in live mode, keeps an explicit `IS_E2E=1` or mock-mode bypass for tests and mock demos, and enforces the 32KB snapshot-body limit in every mode:

```typescript
// src/app/api/share/route.ts
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { mintShareToken } from "@/server/share/shareTokenStore";
import { buildBossReport } from "@/services/reports/bossReport";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/services/auth/authMode";

// Mints a read-only, session-scoped, expiring share token for the Boss Report. Requires an
// authenticated caller with membership in the requested business (same verifyIdToken pattern as
// ai-lookup/resolve-scan) in live mode. Mock mode and IS_E2E=1 explicitly bypass Firebase auth so
// local demos and automated tests still work without credentials. In that bypass only, the route
// accepts the client-computed snapshot because mock mode has no server-reachable session store. The
// snapshot becomes an immutable, expiring, read-only artifact and every mode enforces a 32KB body cap.
export const runtime = "nodejs";
const SHARE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_SHARE_SNAPSHOT_BYTES = 32 * 1024;

export async function POST(req: NextRequest) {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SHARE_SNAPSHOT_BYTES) {
    return NextResponse.json({ error: "Report snapshot must be 32KB or smaller." }, { status: 413 });
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_SHARE_SNAPSHOT_BYTES) {
    return NextResponse.json({ error: "Report snapshot must be 32KB or smaller." }, { status: 413 });
  }

  let body: { sessionId?: string; businessId?: string; idToken?: string; reportSnapshot?: unknown };
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body shape");
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.sessionId) {
    return NextResponse.json({ error: "A session is required before creating a shareable link." }, { status: 400 });
  }

  const requestedBusinessId = (body.businessId ?? "").trim();
  const authBypass = process.env.IS_E2E === "1" || !isLiveAuth();
  if (!authBypass) {
    const idToken = (body.idToken ?? "").trim();
    if (!idToken) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }
    if (!requestedBusinessId) {
      return NextResponse.json({ error: "Missing businessId." }, { status: 400 });
    }

    let uid = "";
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message)) {
        return NextResponse.json({ error: "Server auth is not configured." }, { status: 503 });
      }
      return NextResponse.json({ error: "Invalid or expired sign-in." }, { status: 401 });
    }

    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(requestedBusinessId, uid)}`)
      .get();
    if (!member.exists) {
      return NextResponse.json({ error: "Not a member of this business." }, { status: 403 });
    }
  }

  const businessId = requestedBusinessId || "demo-business";
  const reportSnapshot = (body.reportSnapshot ?? buildBossReport({
    products: [],
    finalCounts: [],
    scanFeed: [],
    sessionName: "Untitled session",
    countedBy: "Owner",
    countedAt: new Date().toISOString(),
  })) as ReturnType<typeof buildBossReport>;
  const now = Date.now();
  const token = await mintShareToken(
    { businessId, sessionId: body.sessionId, reportSnapshot, createdAt: now, expiresAt: now + SHARE_TTL_MS },
    SHARE_TTL_MS,
  );
  const origin = req.nextUrl.origin;
  return NextResponse.json({ token, url: `${origin}/report/${token}` });
}
```

Create the resolve route (deliberately unauthenticated - this is the one designed-public exception):

```typescript
// src/app/api/share/[token]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveShareToken } from "@/server/share/shareTokenStore";

// Deliberately UNAUTHENTICATED (the one designed-public route in this app - see docs/ARCHITECTURE.md
// for the auth pattern every other route follows). Read-only, token-scoped to one session's report
// SNAPSHOT (never a live tenant query), expiring, and leaks nothing beyond what buildBossReport
// already renders on the logged-in report page (no raw barcodes/cost/customer data beyond what a
// Boss Report already shows by design).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const payload = await resolveShareToken(token);
  if (!payload) {
    return NextResponse.json({ error: "This link has expired or does not exist." }, { status: 404 });
  }
  return NextResponse.json({ report: payload.reportSnapshot, sessionId: payload.sessionId });
}
```

Create the public report page:

```tsx
// src/app/report/[token]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { BossReportData } from "@/services/reports/bossReport";

// Public, unauthenticated, read-only Boss Report view - deliberately OUTSIDE the (app) route group so
// it never renders inside BusinessContextGate (no login required, matches the master plan's "the boss
// opens it on his phone... the demo leaves the room").
export default function PublicReportPage() {
  const params = useParams<{ token: string }>();
  const [report, setReport] = useState<BossReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${params.token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "This link has expired or does not exist.");
        }
        return res.json();
      })
      .then((body) => {
        if (!cancelled) setReport(body.report as BossReportData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "This link has expired or does not exist.");
      });
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  if (error) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <p className="text-lg text-zinc-700" data-testid="share-link-error">{error}</p>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <p className="text-zinc-500">Loading report...</p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <p className="text-lg font-semibold text-emerald-700" data-testid="report-moat-line">
        {report.moat.identified} of {report.moat.total} items identified automatically - no manual entry
      </p>
      <h1 className="text-2xl font-bold text-zinc-900">{report.sessionName}</h1>
      <p className="text-sm text-zinc-600">
        Counted by {report.countedBy} on {new Date(report.countedAt).toLocaleString()}
      </p>
      <p className="text-lg" data-testid="report-total-items">
        Total items: <strong>{report.totalItems}</strong>
      </p>
      {report.hasAnyCostData && (
        <p className="text-lg" data-testid="report-total-value">
          Estimated value: <strong>${report.totalValue!.toFixed(2)}</strong>
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/share/shareTokenStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Extend the Playwright proof**

Append to `e2e/phase3-boss-report.spec.ts`:

```typescript
test.describe("Phase 3: Boss Report shareable link", () => {
  test("Get shareable link produces a working public URL that opens with no login", async ({ page, request }) => {
    await page.goto("/scan");
    await page.getByRole("textbox", { name: /scan/i }).fill("012345678905");
    await page.getByRole("textbox", { name: /scan/i }).press("Enter");
    await page.goto("/report");
    await page.getByTestId("share-report").click();
    await expect(page.getByTestId("share-url")).toBeVisible();
    const href = await page.getByTestId("share-url").locator("a").getAttribute("href");
    expect(href).toBeTruthy();
    const publicResponse = await request.get(href!);
    expect(publicResponse.ok()).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:e2e -- phase3-boss-report.spec.ts`
Expected: PASS. In mock/E2E mode (`IS_E2E=1`), the `/api/share` route takes the explicit auth bypass, so no idToken is required and no Firebase credentials are touched. In live mode, the handler must complete `getAdminAuth().verifyIdToken` and the `businessMembers` lookup before minting. The 32KB body guard remains active in both paths and returns 413 for an oversized snapshot body.

- [ ] **Step 7: Commit**

```bash
git add src/server/share/shareTokenStore.ts src/server/share/shareTokenStore.test.ts src/app/api/share/route.ts "src/app/api/share/[token]/route.ts" "src/app/report/[token]/page.tsx" e2e/phase3-boss-report.spec.ts
git commit -m "feat(phase3): shareable tokenized Boss Report link via Turso-backed KV, greenfield unauthenticated read route"
```

---

## Task 13: Optional unit cost - manual edit + CSV import column

**Files:**
- Modify: `src/components/FinalCountTable.tsx`
- Modify: `src/stores/scanStore.ts` (find and extend `importProductsCsv`)
- Test: `src/stores/productStructuring.store.test.ts` (extend, since scout section 1 already cites this file for the `correctProduct` pattern) or the file that actually hosts `importProductsCsv`'s tests (confirm exact path via `grep -rn "importProductsCsv" src/stores/*.test.ts` before writing this task's test, since the scout did not trace this function's body)

**Interfaces:**
- Consumes: `Product.unitCost?: number` (Task 11), existing `correctProduct(productId, patch)` action pattern (per scout section 1: `productStructuring.store.test.ts:74`).
- Produces: `FinalCountTable`'s inline edit form gains an optional "Unit cost ($)" number field using the exact same `correctProduct` call pattern already used for `location`. `importProductsCsv` recognizes an optional `unit_cost` header (case-insensitive, tolerant of `cost`/`unit cost`/`unit_cost` synonyms) and maps it onto `Product.unitCost` when present and parseable as a number; absent or unparseable values leave `unitCost` undefined (never `0`, which would look like a real zero-cost item on the Boss Report).

- [ ] **Step 1: Write the failing test**

First, locate the exact import function under test:

```
grep -rn "importProductsCsv" src/stores/scanStore.ts src/stores/*.test.ts src/services/*.ts src/services/**/*.test.ts
```

Given the scout did not trace this function's body, this step's test targets the STORE ACTION `importProductsCsv` (confirmed present in `ScanState`'s interface per `ExportMenu.tsx:110`'s call site `s.importProductsCsv(text)`) directly through `createTestScanStore`, which is guaranteed stable regardless of which file internally implements it:

```typescript
// Append to src/stores/productStructuring.store.test.ts (or create
// src/stores/importUnitCost.store.test.ts if that file's existing describe blocks are unrelated to
// CSV import - check the file's top-level describe name before appending; if it is scoped to
// something else entirely, create a new sibling test file instead and adjust this task's Files list
// accordingly during execution)
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("importProductsCsv - optional unit_cost column", () => {
  it("maps a unit_cost column onto Product.unitCost when present and numeric", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku,unit_cost\nWidget,Acme,Tools,SKU1,12.50\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU1");
    expect(imported?.unitCost).toBe(12.5);
  });

  it("leaves unitCost UNDEFINED (never 0) when the column is absent", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku\nGadget,Zeta,Electronics,SKU2\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU2");
    expect(imported?.unitCost).toBeUndefined();
  });

  it("leaves unitCost UNDEFINED when the column value is not a valid number", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku,unit_cost\nBroken,Acme,Tools,SKU3,not-a-number\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU3");
    expect(imported?.unitCost).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/productStructuring.store.test.ts` (or the new file's path, per Step 1's grep result)
Expected: FAIL - `imported?.unitCost` is `undefined` in the FIRST test case too (should be `12.5`), since the column is not yet recognized.

- [ ] **Step 3: Write minimal implementation**

Locate the actual `importProductsCsv` implementation via the grep from Step 1 (it lives either directly in `scanStore.ts` or in a dedicated `src/services/*.ts` module the store calls into - the scout explicitly flagged this as unread). Wherever the per-row header-to-field mapping happens, add a `unit_cost` recognizer alongside the existing header synonyms for other fields, following the exact tolerant-synonym pattern already established:

```typescript
// Wherever the row-to-Product mapping builds the Product object (inside importProductsCsv or its
// helper), add unit_cost recognition. Header matching in this codebase is case-insensitive with
// synonym tolerance (see shopwareCsvAdapter.ts's SHOPWARE_COLUMN_MAP pattern, section 2 of the
// scout report, for the established style) - apply the same style here:
const UNIT_COST_HEADERS = ["unit_cost", "unit cost", "cost", "unitcost"];

function parseUnitCost(row: Record<string, string>): number | undefined {
  for (const key of Object.keys(row)) {
    if (UNIT_COST_HEADERS.includes(key.trim().toLowerCase())) {
      const raw = row[key]?.trim();
      if (!raw) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

// Then, in the Product object literal this function already builds per row, add:
//   unitCost: parseUnitCost(row),
// immediately after the existing `location: row.location ?? "",` (or equivalent) field, matching
// whatever the existing per-row object literal's field ordering convention already is.
```

Now modify `src/components/FinalCountTable.tsx`. Locate the existing inline edit form for `location` (per scout section 1: `FinalCountTable.tsx:172,339-340`) and add a sibling "Unit cost" field using the identical `correctProduct` call pattern:

```tsx
// Alongside the existing location edit input (FinalCountTable.tsx:172), add:
          <input
            type="number"
            step="0.01"
            min="0"
            aria-label="unit cost"
            data-testid={`edit-unit-cost-${product.id}`}
            defaultValue={product.unitCost ?? ""}
            placeholder="Unit cost"
            onBlur={(e) => {
              const value = e.target.value.trim();
              const parsed = value ? Number(value) : undefined;
              correctProduct(product.id, { unitCost: Number.isFinite(parsed) ? parsed : undefined });
            }}
            className="min-h-[36px] w-24 rounded border border-zinc-300 px-2 text-sm"
          />
```

(Insert this at the same location in the edit form JSX as the existing location input at `FinalCountTable.tsx:339-340`, using whatever `correctProduct` hook/prop name the surrounding component already has in scope - it is already used for `location` per the scout's citation, so no new store wiring is needed here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/productStructuring.store.test.ts` (or the applicable test file path)
Expected: PASS (3 tests).

Run: `npx vitest run src/components` (or the dom project covering `FinalCountTable`)
Expected: PASS, no regression.

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/components/FinalCountTable.tsx src/stores/productStructuring.store.test.ts
git commit -m "feat(phase3): optional per-product unit cost, manual edit and tolerant CSV column import"
```

---

## Task 14: Visual-polish gate pass on session log and Boss Report

**Files:**
- No source modification expected unless the polish review finds a real defect (in which case, modify whichever of `src/components/SessionsList.tsx`, `src/app/(app)/sessions/[id]/page.tsx`, `src/app/(app)/report/page.tsx`, `src/app/report/[token]/page.tsx` the review flags).

**Interfaces:**
- Consumes: the screenshots already produced by Tasks 5, 10, 11, 12's Playwright specs (`e2e/proof/phase3-*.png`).
- Produces: nothing new; this task is the master plan's mandated "boss-visible surfaces pass a first-impression/visual-polish agent review (desktop + phone) in the phase where they are built" gate for the session log and Boss Report, which are built in this phase.

- [ ] **Step 1: Ensure fresh screenshots exist for both surfaces at both viewports**

Run: `npm run test:e2e -- phase3-session-timeline.spec.ts phase3-boss-report.spec.ts`
Expected: PASS, refreshing `e2e/proof/phase3-session-timeline-phone.png` and `e2e/proof/phase3-boss-report-phone.png`. Additionally capture desktop-viewport screenshots by adding one more assertion to each spec temporarily (or run Playwright with `--project=chromium` at its default desktop viewport, which both specs already use for their FIRST test in each `describe` block before the phone-viewport second test) - the desktop screenshots are implicitly covered by manually adding `await page.screenshot(...)` calls to the first test in each spec if not already present; if the existing first tests in Tasks 5/10/11 do not already save a desktop screenshot, add one line `await page.screenshot({ path: "e2e/proof/phase3-<name>-desktop.png", fullPage: true });` at the end of each corresponding first test before rerunning this step.

- [ ] **Step 2: Dispatch the visual-polish review**

Dispatch the `visual-polish` agent (per `docs/QA_BOTS.md`'s human-bot proof gate convention) with the four screenshot pairs (session list + timeline, Boss Report, desktop + phone each) as input, asking it to judge alignment, spacing rhythm, type scale, color harmony, and visual hierarchy per its existing mandate, and to flag anything that reads as unfinished/hobby-demo rather than paid SaaS.

- [ ] **Step 3: Fix any blocking finding**

If the review returns a blocking finding (e.g. "the moat line and total items have inconsistent font weight," "the timeline table has no zebra striping and is hard to scan," "the phone report is cramped"), apply the minimal targeted fix to the flagged component, then rerun the relevant Playwright spec from Step 1 to refresh the screenshot and confirm the fix visually.

- [ ] **Step 4: Commit (only if Step 3 produced a change)**

```bash
git add -A
git commit -m "fix(phase3): visual-polish gate fixes for session log and Boss Report"
```

If Step 3 produced no changes (the review passed clean), skip this commit - there is nothing to commit.

---

## Task 15: Full Phase 3 gate sweep + PROGRESS.md checkpoint

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: every artifact produced by Tasks 1-14.
- Produces: nothing new in code; a verified, proof-backed phase-completion checkpoint.

- [ ] **Step 1: Run the full unit + dom test suite**

Run: `npm run test`
Expected: PASS, all Vitest projects (unit + dom), zero failures, including every new test file from Tasks 1-13.

- [ ] **Step 2: Run the ledger crown suite**

Run: `npm run test:ledger`
Expected: PASS. This is mandatory per CLAUDE.md ("run `npm run test:ledger` for ANY counting/ledger change") - Tasks 3, 4, and 9 all touch scan-count paths.

- [ ] **Step 3: Run the golden baseline gate**

Run: `npm run test:golden`
Expected: PASS, unchanged - Phase 3 does not touch decode/identity logic (per master plan scope, D5/D6/D8 are Phase 5, not this phase).

- [ ] **Step 4: Run the Firestore emulator suite**

Run: `npm run test:firebase`
Expected: PASS, including the new `getScanEventsBySession` test (Task 6) and the two-device concurrency test (Task 8).

- [ ] **Step 5: Run typecheck, lint, and build**

Run: `npx tsc --noEmit`
Expected: PASS, zero type errors (this catches any `unitCost`/`location`/`deviceId` field-name typos across the new files).

Run: `npm run lint`
Expected: PASS, zero errors.

Run: `npm run build`
Expected: PASS, production build succeeds (this exercises the new `/report`, `/report/[token]`, `/sessions/[id]`, `/api/share`, `/api/share/[token]` routes at build time).

- [ ] **Step 6: Run the full mock Playwright suite**

Run: `npm run test:e2e`
Expected: PASS, including all Phase 3 specs (`phase3-location-moat.spec.ts`, `phase3-session-timeline.spec.ts`, `phase3-boss-report.spec.ts`) alongside every pre-existing spec (regression check - Phase 3 must not break Phase 1/2 flows).

- [ ] **Step 7: Run the full revision gate**

Run: `npm run qa:revision`
Expected: PASS (this is the project's full handoff gate: tsc + lint + build + e2e + firebase + bots, per CLAUDE.md's commands table). This step is the master plan's required "session log + Boss Report pass the visual-polish gate" (Task 14) plus every other cross-cutting proof requirement combined into one command; if `qa:revision` includes bot runs beyond what Tasks 1-14 already cover, address any NEW finding it surfaces before declaring the phase done, following the doctrine's repair loop (fix, rerun, do not weaken a test to pass).

- [ ] **Step 8: Update PROGRESS.md**

Read the current `PROGRESS.md`, then update its phase-status section to reflect Phase 3 complete, listing: branch name, all Task 1-14 commits (via `git log --oneline` since the phase's first commit), the acceptance-criteria table from the master plan's P3 section (all 8 criteria) mapped to their proof artifact (test file or screenshot path), and any surviving known limitation (e.g. "cloud session history is refreshed on demand rather than live: before the first Refresh, `listSessions` falls back to `[currentSession]`; after Refresh, `listSessions` and `reopenSession` use the complete `sessions` state populated by Task 7").

- [ ] **Step 9: Commit**

```bash
git add PROGRESS.md
git commit -m "docs(phase3): PROGRESS.md checkpoint - Phase 3 gate sweep complete"
```

---

## Acceptance Criteria Cross-Reference (master plan P3, verbatim numbering)

| # | Master plan criterion | Proof artifact |
|---|---|---|
| 1 | Scan 50 items with no session started shows "Jul 19, 4:00 PM - 50 items" in the log; click shows all 50 rows with locations (both viewports) | Task 5 (`ensureAutoSession`), Task 9 (location stamping), Task 10 (`e2e/phase3-session-timeline.spec.ts`, both viewport tests) |
| 2 | Device A and B each scan the same product 10x concurrently -> count = 20 (scaled to 10 in-test for speed); exactly one application per event id | Task 8 (`sessionPersistence.rules.test.ts` two-instance test) |
| 3 | Device B sees device A's session within the declared staleness bound | Task 7 (`refreshFromCloud`), Task 8 (manual Refresh button); staleness bound = manual refresh (explicit, not a live listener, per Trap C) - documented in PROGRESS.md (Task 15, Step 8) |
| 4 | Location typed once persists across scans, appears in feed/timeline/CSV; recents offered | Task 5 (recents `<datalist>`), Task 9 (stamping), Task 10 (`exportSessionScanLog`'s location column) |
| 5 | Boss Report renders complete on one printed page from a large session; coverage line correct; value totals only over items with cost; shareable link opens read-only on a phone with no login and expires | Task 11 (`bossReport.test.ts`, print CSS), Task 12 (`shareTokenStore.test.ts` expiry test, public `/report/[token]` page with no `BusinessContextGate`) |
| 6 | Camera-scan -> count -> session -> report proven on a phone viewport | Task 5, Task 10, Task 11 phone-viewport Playwright screenshots (camera-scan itself is pre-existing `CameraScanButton`, already wired on the scan page; these specs exercise the same `onScan` callback path) |
| 7 | P1 ledger suite re-run unchanged inside a session wrapper | Task 4 (`ledgerInvariants.store.test.ts` extension), Task 15 Step 2 (`npm run test:ledger`) |
| 8 | Session log + Boss Report pass the visual-polish gate | Task 14 |

## Surviving Design Notes (not blocking objections, documented per plan-execution law)

- **Staleness bound is "manual refresh," not a live listener.** The sync scout's Trap C is explicit that a naive `onSnapshot` wired to a replace-style merge would violate the TOP-LEVEL LAW; this plan's `refreshFromCloud` (Task 7) is additive-merge-safe but is triggered by a button (Task 8), not a timer or `onSnapshot`. This satisfies AC3's letter ("within the declared staleness bound") by DECLARING the bound as "on demand via Refresh" rather than a fixed N-second window. If the owner wants a genuine background poll (e.g. every 30s on an active tab), that is a small addition to Task 8 (a `setInterval` calling the same `refreshFromCloud`, gated on tab visibility) - deliberately NOT included here as a default-on background timer to keep this phase's Firestore read cost bounded and predictable; flagging as an explicit follow-up rather than silently deciding it.
- **`unitCost` reverses no existing exclusion policy.** The Shop-Ware reconcile importer's price/cost exclusion (`shopwareCsvAdapter.ts`) is left completely untouched; Task 13 adds cost ONLY via manual entry or the separate, pre-existing Products CSV importer, which was never subject to that exclusion rule in the first place (confirmed by the scout: "no second adapter with its own column-mapping table... UNKNOWN whether importProductsCsv explicitly recognizes and drops price columns" - since it does not, adding recognition there is additive, not a policy reversal).
- **Task 9's grep-located fresh literals in `processScan` are described by pattern, not exact line numbers**, because the scout explicitly could not enumerate every branch (`ledgerInvariants.store.test.ts` sees only the aggregate effect). The implementing engineer MUST run the specified `grep -n "ScanEvent = {" src/stores/scanStore.ts` before editing, classify the hits by scope, and wrap every fresh `ScanEvent` literal inside `processScan`. Spread-built events inherit the stamp from their base; the `markWrong` residual literal outside `processScan` is deliberately unstamped. The ledger test suite (Task 4, `npm run test:ledger`) and the new `scanLocation.store.test.ts` (Task 9) prove the qualifying processScan branches stay correct.
- **Task 13's exact file for `importProductsCsv`'s implementation is intentionally left for the implementing engineer to grep-confirm** (Step 1 of that task), since the scout explicitly flagged this function's body as unread in this research pass; this is documented uncertainty, not a placeholder - the test in Step 1 pins the OBSERVABLE BEHAVIOR (via the stable `createTestScanStore` + `s.importProductsCsv` action, which is confirmed to exist by its `ExportMenu.tsx:110` call site) regardless of which file the implementation ends up living in.
