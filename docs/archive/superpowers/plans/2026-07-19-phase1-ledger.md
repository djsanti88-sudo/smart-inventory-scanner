# Phase 1 - Bulletproof the Count Ledger (+ never-hang) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the count ledger provably balanced across every scan path (fix D1 ghost events, D2 quantity-destroying corrections, D3 replay-double-apply merges) and guarantee a scan's identity work can never hang the demo (fix D7 unbounded in-flight rungs), proven by a net-new ledger-invariant suite.

**Architecture:** The scan hot path (`processScan` in `src/stores/scanStore.ts`) is already synchronous and dispatches decode async, so the fixes never touch the "scan appears and counts instantly" guarantee. Phase 1 changes only (a) how the ledger records/enqueues each counted event, (b) how identity corrections move quantity instead of destroying it, and (c) how the decode ladder bounds a single in-flight rung. A new Vitest suite drives `processScan` across all 13 paths and asserts the two book-balancing invariants; the ladder timeout is proven with fake timers and an AbortController spy.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Zustand (+persist) / Vitest (projects: `unit`=node, `dom`=jsdom) / Playwright (`IS_E2E=1`, `page.route` mocks, proof screenshots in `e2e/proof/`).

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the master plan and CLAUDE.md.

- **North-star #1 (every scan appears and counts):** No gate, verdict, cap, breaker, error, or fix may suppress a scanned row from the feed or the session count. Scan 10 = count 10. An unidentifiable code still counts as an "Unidentified item" row. A change that makes a scanned code vanish from the feed or the totals is a defect, full stop.
- **North-star #2 (the books balance):** For every product, `sum(feed deltas) === finalCounts.quantity`, and the set of `scanEventIds` per count is identical across replay. Always.
- **North-star #3 (wrong identity is failure; unknown is acceptable):** Never guess. Conflicts and ambiguity go to review.
- **North-star #5 (cost-ordered ladder, first settled stops, honest reasons):** A hard-timeout ladder settles on best-so-far and records an `aborted` reason - that is a settle, not a bypass. Every rung that ran records its reason.
- **North-star #6 (tests never call live paid providers):** Mock-first (`fetch` mock / `page.route`); the Playwright webServer runs with `IS_E2E=1` which forces `/api/ai-lookup` to mock-only. Live proofs are explicit, owner-gated. This suite runs $0.
- **North-star #7 (a scan never hangs the screen):** Hard decode ceiling; identity work stays off the count path. `processScan` is synchronous today; decode is dispatched async - do not change that.
- **Idempotency key contract is DONE:** `buildIdempotencyKey(businessId, sessionId, scanEventId, operation)` (`src/services/idempotency.ts:7-13`) already carries `businessId` as segment 0. Do NOT re-key anything. P2 fills the businessId slot; Phase 1 invents no key work.
- **Keep services pure:** No React / `next/*` imports in `src/services`. The store (`src/stores`) may import React; `src/server/upc/ladder.ts` stays framework-free and env-free.
- **No em dash or en dash in user-facing copy.** Use normal punctuation. (Applies to any `reason`/label string a user sees.)
- **Suite cost/speed gate:** the net-new ledger suite + extended golden fixtures run in CI at $0 and complete in under 90s. Existing 2294+ unit tests and all Playwright specs stay green.
- **Test commands:** `npm run test` (all Vitest, run once), `npm run test:e2e` (Playwright), `npm run lint` (eslint), `npx tsc --noEmit` (typecheck). Single-file Vitest: `npx vitest run <path>`. Single Playwright: `npx playwright test <path>`.
- **Git:** work on branch `feat/phase1-ledger` off `feat/decode-ladder-goupc`. LOCAL commits only. NEVER push (owner gate). NEVER deploy.
- **Not in scope:** Firestore/cloud changes (queue SHAPE only - P3 consumes it), UI redesign, auth. Do not build cross-tier conflict logic (D5, P5) or GPT demotion (D6, P5) here.

---

## File Structure

Before defining tasks, the created/modified files and their single responsibilities:

**Created:**
- `src/stores/ledgerInvariants.store.test.ts` - the crown net-new Vitest suite. Drives `processScan` (and correction/merge actions) across the scan paths; asserts per-product `sum(feed deltas) === finalCounts.quantity`, ledger-replay reproduces every quantity AND exact `scanEventIds` set, and N sync retries change nothing. Pure store test (jsdom project). Home of the shared `assertBooksBalance` + `assertRetryIsNoOp` helpers.
- `src/services/inventory.replay.ts` - pure ledger-replay helper (`replayLedgerCounts`): given a scanFeed (event list) and a session id, reconstruct the `InventoryCount[]` purely from event deltas + `scanEventIds` dedupe, so a test can assert the live `finalCounts` equals the replay. Lives in `src/services` (pure, no React) so both the suite and future phases reuse it.
- `src/services/inventory.replay.test.ts` - unit tests for `replayLedgerCounts` (node project).
- `src/stores/markWrongTransfer.store.test.ts` - TDD suite for D2 (markWrong quantity transfer + example-gate regression lock).
- `src/stores/mergeUnion.store.test.ts` - TDD suite for D3, covering ALL THREE live orphan-transfer sites: the `resolveUnknown` merge, the `runLiveDecodeOnce` fast-decode auto-link merge, and the `backgroundVerifyDeep` deep-verify merge.
- `src/stores/unknownEnqueue.store.test.ts` - TDD suite for D1 (every unknown/provisional path enqueues + no fake `synced` + the same-fact `quantityDelta: 1` stamp) and the `provenanceTier` birth assertion.
- `src/stores/provenanceTier.store.test.ts` - Task 3: static + behavioral lock that every provisional product mint carries `provenanceTier` from birth.
- `src/server/upc/ladderTimeout.test.ts` - TDD suite for D7 (per-rung AbortController timeout + total wall-clock ceiling + late-resolve mutation guard, fake timers).
- `src/stores/goldenClasses.store.test.ts` - extends the golden fixture concept with misread/example/vendor/conflict CODE CLASSES; identity-outcome assertions only (decodeStatus/resolverStatus per class), no ledger assertions.
- `e2e/ledger-markwrong.spec.ts` - Playwright ledger proof (desktop + 390px phone viewport): markWrong keeps total quantity constant, asserted in BOTH the store and the rendered DOM; screenshots to `e2e/proof/`.

**Modified:**
- `src/types.ts` - add `ProvenanceTier` type + `Product.provenanceTier?` (added in Task 2 so the mint compiles in the same commit; no other type changes).
- `src/stores/scanStore.ts` - the defect fixes:
  - `ensureProvisionalCount` (~:2929): enqueue SAVE_PRODUCT + SAVE_SCAN_EVENT + INCREMENT_COUNT; kill the fake `syncStatus: "synced"` stamp (~:2993); stamp `quantityDelta: 1` on the counted feed row (the stored event and the counted delta are the same fact); stamp `provenanceTier` on the minted provisional.
  - `markWrong` (count-delete at ~:4561-4565): transfer quantity to an "Unidentified item" provisional instead of deleting the count row; preserve example/test classification.
  - New module-level pure helper `transferOrphanCount(finalCounts, oid, targetId, nowIso)` replacing the copy-pasted orphan-transfer fragment at ALL THREE sites: `runLiveDecodeOnce` (~:2569-2594), `backgroundVerifyDeep` (~:3363-3390), `resolveUnknown` (~:3886-3910) - each now unions `scanEventIds` / `aliasesSeen` / `appliedIdempotencyKeys`.
  - `provenanceTier` stamped at all three `provisional: true` product mint sites (:2614 in `runLiveDecodeOnce`, :2887 in the failed-decode mint, :2954 in `ensureProvisionalCount`).
- `src/server/upc/ladder.ts` - `runLadder` per-rung AbortController + wall-clock ceiling; `LadderRung.run` gains a `{ signal }` context arg.
- `src/server/decode/pipeline.ts` - thread `perRungTimeoutMs` into the 3 `runLadder` calls (:1127, :1250, :1266).
- `src/services/inventory.ts` - no logic change expected; `applyScanEventOnce` is the replay reference. (Only touched if a test reveals a gap; do not pre-emptively edit.)
- `package.json` - add `test:ledger` script for CI visibility (the suites are already picked up by `vitest run`).

Note on CI: this repo has NO `.github/workflows/` directory. "CI gates" are the npm scripts (`npm run test`, `npm run lint`, `npx tsc --noEmit`, `npm run proof:full`, `npm run test:e2e`). "Wire into CI" therefore means: the new Vitest suites are picked up by `vitest run` (they match the `dom`/`unit` project `include` globs automatically) and a named `test:ledger` script exists for targeted runs. Do not author a GitHub Actions file (none exists to extend).

---

## Task 1: Phase branch + ledger-replay helper

**Files:**
- Create: `src/services/inventory.replay.ts`
- Test: `src/services/inventory.replay.test.ts`

**Interfaces:**
- Consumes: `InventoryCount`, `ScanEvent` from `@/types`; `applyScanEventOnce` from `@/services/inventory`.
- Produces: `replayLedgerCounts(events: ScanEvent[], sessionId: string): InventoryCount[]` - rebuilds counts purely from the event stream, deduping by `scanEventIds` exactly as `applyScanEventOnce` does. Later tasks and the ledger suite import this.

- [ ] **Step 1: Create the branch**

Run:
```bash
git checkout feat/decode-ladder-goupc
git checkout -b feat/phase1-ledger
git status
```
Expected: on branch `feat/phase1-ledger`, clean-ish tree (the pre-existing modified files from the master-plan session may show; do not touch them).

- [ ] **Step 2: Write the failing test**

Create `src/services/inventory.replay.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { ScanEvent } from "@/types";
import { replayLedgerCounts } from "@/services/inventory.replay";

function ev(over: Partial<ScanEvent>): ScanEvent {
  return {
    id: "e1", businessId: "b", sessionId: "s", rawCode: "1", cleanCode: "1",
    normalizedCandidates: [], matchedProductId: "p1", matchType: "unknown",
    status: "known", resolverStatus: "known", codeType: "upc_a", reason: "",
    quantityDelta: 1, quantityAfterScan: 0, createdAt: "2026-07-19T00:00:00.000Z",
    source: "scan", notes: "", syncStatus: "pending", syncError: null,
    idempotencyKey: "b:s:e1:INCREMENT_COUNT", ...over,
  };
}

describe("replayLedgerCounts", () => {
  it("sums deltas per product and records exact scanEventIds", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: "p1" }),
      ev({ id: "e2", matchedProductId: "p1" }),
      ev({ id: "e3", matchedProductId: "p2" }),
    ];
    const counts = replayLedgerCounts(events, "s");
    const p1 = counts.find((c) => c.productId === "p1")!;
    const p2 = counts.find((c) => c.productId === "p2")!;
    expect(p1.quantity).toBe(2);
    expect(new Set(p1.scanEventIds)).toEqual(new Set(["e1", "e2"]));
    expect(p2.quantity).toBe(1);
  });

  it("is a no-op on a duplicate event id (replay dedupe = applyScanEventOnce)", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: "p1" }),
      ev({ id: "e1", matchedProductId: "p1" }), // same id replayed
    ];
    const counts = replayLedgerCounts(events, "s");
    expect(counts.find((c) => c.productId === "p1")!.quantity).toBe(1);
  });

  it("ignores events with no matchedProductId and events from other sessions", () => {
    const events: ScanEvent[] = [
      ev({ id: "e1", matchedProductId: null, status: "needs_review", quantityDelta: 0 }),
      ev({ id: "e2", matchedProductId: "p1", sessionId: "other" }),
      ev({ id: "e3", matchedProductId: "p1", sessionId: "s" }),
    ];
    const counts = replayLedgerCounts(events, "s");
    expect(counts.length).toBe(1);
    expect(counts[0].quantity).toBe(1);
    expect(counts[0].scanEventIds).toEqual(["e3"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/inventory.replay.test.ts`
Expected: FAIL - `Failed to resolve import "@/services/inventory.replay"` (module does not exist).

- [ ] **Step 4: Write minimal implementation**

Create `src/services/inventory.replay.ts`:
```ts
import type { InventoryCount, ScanEvent } from "@/types";
import { createInventoryCount, applyScanEventOnce } from "@/services/inventory";

// Pure ledger replay. Given the raw scan-event stream for a session, reconstruct the
// InventoryCount[] purely from event deltas, deduping by event id exactly as the live
// applyScanEventOnce does. A count's replayed quantity AND its scanEventIds set are the
// book-balancing ground truth: the live finalCounts must equal this replay on every path.
export function replayLedgerCounts(events: ScanEvent[], sessionId: string): InventoryCount[] {
  const byProduct = new Map<string, InventoryCount>();
  let seq = 0;
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    if (!e.matchedProductId) continue; // uncounted feed rows (needs_review) carry no count
    const base =
      byProduct.get(e.matchedProductId) ??
      createInventoryCount({
        id: `replay-${seq++}`,
        businessId: e.businessId,
        sessionId: e.sessionId,
        productId: e.matchedProductId,
        createdAt: e.createdAt,
      });
    const { count } = applyScanEventOnce(base, e);
    byProduct.set(e.matchedProductId, count);
  }
  return [...byProduct.values()];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/inventory.replay.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**
```bash
git add src/services/inventory.replay.ts src/services/inventory.replay.test.ts
git commit -m "feat(ledger): pure replayLedgerCounts helper (P1 book-balance basis)"
```

---

## Task 2: D1 - every unknown/provisional scan enqueues; kill the fake `synced`; `ProvenanceTier` born

**Files:**
- Modify: `src/types.ts` (add `ProvenanceTier` + the `Product` field - added HERE so this task's mint compiles and typechecks in the same commit)
- Modify: `src/stores/scanStore.ts` (`ensureProvisionalCount`, ~:2929-2999)
- Test: `src/stores/unknownEnqueue.store.test.ts`

**Interfaces:**
- Consumes: `createTestScanStore` from `@/stores/scanStore`, `MockDb` from `@/services/mockDb`, `buildIdempotencyKey` from `@/services/idempotency`.
- Produces:
  - `type ProvenanceTier = "provisional" | "ai_suggested" | "ladder_verified_strong" | "corpus_verified" | "human_verified"` and `Product.provenanceTier?: ProvenanceTier` in `src/types.ts`. P2's resolver tier interface reads this field - it becomes a fill-in, not a data migration.
  - After this task, `ensureProvisionalCount(code, reason)` enqueues `SAVE_PRODUCT` (for the new provisional), `SAVE_SCAN_EVENT`, and `INCREMENT_COUNT` to `pendingSyncQueue`; the counted feed row carries `quantityDelta: 1` (the stored event and the counted delta are the same fact, not a patched copy); and the row's `syncStatus` is NOT forced to `"synced"` (it stays derived-`"pending"` until a real sync ack). `applyDecodeFallback` and the context-conflict branch inherit this because they both route through `ensureProvisionalCount`.

**Ground truth (verified 2026-07-19):** `ensureProvisionalCount` mints `provProduct` + increments the count locally, then in the `scanFeed.map` sets `syncStatus: "synced" as const` (scanStore.ts:2993) and pushes NOTHING to `pendingSyncQueue`. The countable branch of `processScan` (scanStore.ts:1379-1424) enqueues exactly TWO ops per scan: `SAVE_SCAN_EVENT` + `INCREMENT_COUNT` (:1397-1422; the count item's entityId is `count.id`); there is NO `SAVE_PRODUCT` on today's scan path anywhere - the `SAVE_PRODUCT` this task adds for the freshly minted provisional is a NEW operation for the scan flow (its precedent is `resolveUnknown`'s SAVE_PRODUCT enqueue at scanStore.ts:3912-3930), not a copy of the countable branch. The unknown/provisional path only pushes to `scanFeed` then calls `ensureProvisionalCount` (scanStore.ts:1565-1571). The counted feed row today keeps its birth `quantityDelta: 0` (processScan :1369 mints unknowns with delta 0 and `ensureProvisionalCount`'s row update never stamps the delta) - the master plan's D1 language ("every physical scan event is born with quantityDelta: 1 ... the stored feed event and the counted delta are the same fact") requires the row to carry delta 1 once counted, or the ledger invariant `sum(feed deltas) === quantity` can never hold. `makeQueueItem` and the `enqueueAndSync` closure are the existing enqueue mechanism (scanStore.ts:712, :944); both are in scope where `ensureProvisionalCount` is defined.

- [ ] **Step 1: Write the failing test**

CORRECTION (Task 2 execution, 2026-07-19): the mock backend drains synchronously with a real ack; the test must force failure (setSimulateSyncFailure, the established scanStore.test.ts pattern) to observe the pending state, then clear it to prove the real-ack half.

Create `src/stores/unknownEnqueue.store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function makeStore() {
  const db = new MockDb();
  const store = createTestScanStore({ db });
  // AI off so the unknown never dispatches a live decode; the scan still counts synchronously.
  store.getState().updateSettings({ aiLookupEnabled: false });
  return { db, store };
}

// The mock/local backend drains the sync queue SYNCHRONOUSLY with a REAL ack (documented in
// sessionPersistence.store.test.ts: "SAVE_SESSION drained synchronously"). To observe the D1
// pending state (ops enqueued, row not yet acked) we force sync failure first - the established
// pattern from scanStore.test.ts ("keeps scans locally as pending when sync fails").
function pendingStore() {
  const { db, store } = makeStore();
  store.getState().setSimulateSyncFailure(true);
  return { db, store };
}

describe("D1: every unknown scan enqueues its ledger writes and is never fake-synced", () => {
  it("an unknown scan enqueues SAVE_PRODUCT, SAVE_SCAN_EVENT and INCREMENT_COUNT", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const ops = store.getState().pendingSyncQueue.map((q) => q.operation);
    expect(ops).toContain("SAVE_PRODUCT");
    expect(ops).toContain("SAVE_SCAN_EVENT");
    expect(ops).toContain("INCREMENT_COUNT");
  });

  it("the counted unknown feed row is NOT stamped synced before an ack and carries the same-fact quantityDelta 1", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    expect(row.status).toBe("known"); // counted against a provisional
    // No ack has happened (sync is failing) - the OLD code fake-stamped "synced" here regardless.
    expect(row.syncStatus).not.toBe("synced");
    expect(row.quantityDelta, "the stored event and the counted delta are the same fact").toBe(1);
  });

  it("the enqueued INCREMENT_COUNT idempotency key matches the counted event's key (no re-key)", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    const inc = store.getState().pendingSyncQueue.find((q) => q.operation === "INCREMENT_COUNT" && q.scanEventId === row.id);
    expect(inc, "an INCREMENT_COUNT is enqueued for this scan event").toBeDefined();
    expect(inc!.idempotencyKey).toBe(row.idempotencyKey);
  });

  it("re-scanning the same unknown increments the count and enqueues a second INCREMENT_COUNT, still no double product row", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    store.getState().processScan("888888888882");
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);
    expect(store.getState().finalCounts.length).toBe(1);
    const incs = store.getState().pendingSyncQueue.filter((q) => q.operation === "INCREMENT_COUNT");
    expect(incs.length).toBe(2);
  });

  it("clearing the failure and retrying drains the queue, acks the row for REAL, and applies the count exactly once", () => {
    const { db, store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    const productId = row.matchedProductId!;
    expect(productId).toBeTruthy();

    store.getState().setSimulateSyncFailure(false);
    store.getState().retrySync();

    // Queue drained; the row now reads synced because a REAL ack happened (db.apply succeeded),
    // not because anything stamped it optimistically.
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
    const acked = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    expect(acked.syncStatus).toBe("synced");

    // Server-side truth: the provisional product, its scan event, and the count applied exactly once.
    expect(db.snapshot().products[productId], "SAVE_PRODUCT reached the backend").toBeDefined();
    expect(db.getScanEvent(row.id), "SAVE_SCAN_EVENT reached the backend").toBeDefined();
    expect(db.getServerCount("session-1", productId)?.quantity).toBe(1);

    // Idempotency: retrying again must never double-apply.
    store.getState().retrySync();
    store.getState().retrySync();
    expect(db.getServerCount("session-1", productId)?.quantity).toBe(1);
  });

  it("the minted provisional product carries provenanceTier 'provisional' from birth", () => {
    const { store } = makeStore();
    store.getState().processScan("777777777775");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "777777777775")!;
    expect(prod.provisional).toBe(true);
    expect(prod.provenanceTier).toBe("provisional");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/unknownEnqueue.store.test.ts`
Expected: FAIL (all 6). Test 1 fails because `pendingSyncQueue` contains no `SAVE_PRODUCT`/`INCREMENT_COUNT` for the provisional (nothing is enqueued in `ensureProvisionalCount`); test 2 fails because the row is stamped `syncStatus: "synced"` and carries `quantityDelta: 0`; test 5 fails because `SAVE_PRODUCT` never reaches the backend; test 6 fails because `provenanceTier` does not exist yet.

- [ ] **Step 3: Implementation - Edit A: declare the type in `src/types.ts`**

Add the type alias ABOVE the `Product` interface (types.ts:86) and the field inside `Product` after the `provisional?: boolean;` line (types.ts:116):
```ts
// Provenance of a product's identity, from birth. P2's resolver tier interface reads this to rank
// tenant truth vs master truth; Phase 1 defaults every provisional mint to "provisional". Optional
// so older persisted rows (no tier yet) fall back to undefined = treat as lowest trust.
export type ProvenanceTier =
  | "provisional"
  | "ai_suggested"
  | "ladder_verified_strong"
  | "corpus_verified"
  | "human_verified";
```
Inside `Product`:
```ts
  provenanceTier?: ProvenanceTier;
```

- [ ] **Step 4: Implementation - Edit B: stamp the tier on the `ensureProvisionalCount` mint**

In `src/stores/scanStore.ts`, the provProduct literal (scanStore.ts:2950-2955) currently reads exactly:
```ts
        const provProduct: Product = {
          id: provId, businessId: st0.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
          specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
          aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_gemini",
          confidence: 0, verified: false, provisional: true, createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
        };
```
Change only the last field line to:
```ts
          confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
```

- [ ] **Step 5: Implementation - Edit C: capture the counted event + count id**

Immediately below the provProduct literal, the increment block (scanStore.ts:2956-2963) currently reads exactly:
```ts
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        if (ev) {
          const r = incrementInventoryCount(counts, { ...ev, matchedProductId: provId, status: "known", quantityDelta: 1 }, idFactory);
          counts = r.counts;
          qty = r.count.quantity;
        }
```
Replace with:
```ts
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        let countId: string | null = null;
        const countedEvent = ev
          ? { ...ev, matchedProductId: provId, status: "known" as const, quantityDelta: 1 }
          : null;
        if (countedEvent) {
          const r = incrementInventoryCount(counts, countedEvent, idFactory);
          counts = r.counts;
          qty = r.count.quantity;
          countId = r.count.id;
        }
```

- [ ] **Step 6: Implementation - Edit D: same-fact delta on the row; drop the fake `synced`**

Inside the same function's `set(...)`, the scanFeed row update (scanStore.ts:2989-2995) currently reads exactly:
```ts
                  // Preserve an IN-FLIGHT "Decoding..." badge (a live decode is actually running) so the
                  // documented "Decoding -> Verified / Suggested / Conflict / Needs review" UI stays visible;
                  // only stamp "suggested" when there is no decode in flight.
                  decodeStatus: e.decodeStatus === "decoding" ? "decoding" : "suggested",
                  syncStatus: "synced" as const,
                  reason: e.reason || reason,
```
Replace with:
```ts
                  // Preserve an IN-FLIGHT "Decoding..." badge (a live decode is actually running) so the
                  // documented "Decoding -> Verified / Suggested / Conflict / Needs review" UI stays visible;
                  // only stamp "suggested" when there is no decode in flight.
                  decodeStatus: e.decodeStatus === "decoding" ? "decoding" : "suggested",
                  // D1 FIX: the stored feed event and the counted delta are the SAME FACT - the row a
                  // provisional count was applied from must carry the delta it contributed (North-star #2:
                  // sum(feed deltas) === quantity). And the fake optimistic "synced" stamp is GONE: the
                  // row's syncStatus is derived from pendingSyncQueue membership (see the reconcile at
                  // scanStore.ts:907-922) and only reads "synced" after a real sync ack.
                  quantityDelta: 1,
                  reason: e.reason || reason,
```

- [ ] **Step 7: Implementation - Edit E: enqueue the three ledger ops**

`ensureProvisionalCount` currently ends (scanStore.ts:2996-2999) exactly:
```ts
              : e,
          ),
        }));
      },
```
(the closing of the `scanFeed.map`, the `set`, and the action - immediately before `markFeedRowVerified`). Insert the enqueue block between the `}));` and the closing `},`:
```ts
              : e,
          ),
        }));
        // D1 FIX: a provisional count is real inventory. Enqueue its ledger writes through the SAME sync
        // queue mechanism every counted scan uses. SAVE_SCAN_EVENT + INCREMENT_COUNT mirror the countable
        // branch's two ops (scanStore.ts:1397-1422); SAVE_PRODUCT for the freshly minted provisional is a
        // NEW op on the scan path (precedent: resolveUnknown's SAVE_PRODUCT enqueue, :3912-3930). The
        // INCREMENT_COUNT key is the event's own key minted in processScan - reused verbatim, never
        // regenerated (Idempotent Sync Rules).
        if (countedEvent && countId) {
          const bId = st0.businessId;
          const sId = st0.sessionId;
          const incPayload: IncrementPayload = {
            businessId: bId, sessionId: sId, productId: provId, scanEventId: countedEvent.id,
            quantityDelta: 1, idempotencyKey: countedEvent.idempotencyKey,
          };
          enqueueAndSync([
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "Product", entityId: provId, operation: "SAVE_PRODUCT", payload: provProduct, idempotencyKey: buildIdempotencyKey(bId, sId, provId, "SAVE_PRODUCT"), scanEventId: null }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "ScanEvent", entityId: countedEvent.id, operation: "SAVE_SCAN_EVENT", payload: countedEvent, idempotencyKey: buildIdempotencyKey(bId, sId, countedEvent.id, "SAVE_SCAN_EVENT"), scanEventId: countedEvent.id }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "InventoryCount", entityId: countId, operation: "INCREMENT_COUNT", payload: incPayload, idempotencyKey: countedEvent.idempotencyKey, scanEventId: countedEvent.id }),
          ]);
        }
      },
```

Notes for the implementer:
- `countedEvent.idempotencyKey` is the feed event's existing `keyFor("INCREMENT_COUNT")` key minted in `processScan` - reuse it verbatim (no re-key; matches the Global Constraint and the derived-syncStatus reconcile at scanStore.ts:907-922, which keys pending state off exactly this key). `IncrementPayload`, `makeQueueItem`, `enqueueAndSync`, and `buildIdempotencyKey` are all already imported/in-scope in this file.
- Do NOT remove the `syncStatus` reconcile logic elsewhere; only the hard-coded `synced` stamp inside `ensureProvisionalCount` is removed. The derived `syncStatus` (scanStore.ts:907-922, computed from pendingSyncQueue membership) will now correctly report `pending` for this row until sync acks it.

- [ ] **Step 8: Run test to verify it passes, then typecheck**

Run: `npx vitest run src/stores/unknownEnqueue.store.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests) + no type errors.

- [ ] **Step 9: Run the existing regression nets**

Run: `npx vitest run src/stores/countAlways.store.test.ts src/stores/failedDecodePlaceholder.store.test.ts src/stores/orphanedCountDedup.store.test.ts src/stores/resolveUnknownIdempotent.store.test.ts`
Expected: PASS. (These cover "scan N = count N", the failed-decode provisional mint, orphan dedup, and resolve idempotency - all touching `ensureProvisionalCount`.) If any existing test asserts the OLD behavior (a counted unknown row with `quantityDelta: 0` or `syncStatus: "synced"`), that test encodes the D1 defect itself - update it with a one-line comment citing this task, never revert the fix.

- [ ] **Step 10: Commit**
```bash
git add src/types.ts src/stores/scanStore.ts src/stores/unknownEnqueue.store.test.ts
git commit -m "fix(ledger): D1 - provisional counts enqueue their ledger writes; same-fact delta; no fake synced; ProvenanceTier born"
```

---

## Task 3: `provenanceTier` stamped at every provisional mint site

**Files:**
- Modify: `src/stores/scanStore.ts` (the two remaining `provisional: true` mint sites: :2614 and :2887)
- Test: `src/stores/provenanceTier.store.test.ts`

**Interfaces:**
- Consumes: the `ProvenanceTier` type declared in Task 2.
- Produces: every product literal in scanStore.ts that sets `provisional: true` also stamps `provenanceTier: "provisional"` at birth.

**Ground truth (verified 2026-07-19):** scanStore.ts has exactly THREE `provisional: true` product mint sites: :2614 (inside `runLiveDecodeOnce`, the suggested-decode provisional), :2887 (the failed-decode mint that shares `provisionalPlaceholderName`), and :2954 (`ensureProvisionalCount`, already stamped by Task 2). This task stamps the remaining two so P2's tier interface is a fill-in with no migration.

- [ ] **Step 1: Write the failing test**

Create `src/stores/provenanceTier.store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

describe("provenanceTier is stamped at every provisional product birth", () => {
  it("BEHAVIOR: the ensureProvisionalCount mint carries the tier (covered end to end)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("666666666668");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "666666666668")!;
    expect(prod.provenanceTier).toBe("provisional");
  });

  it("STATIC LOCK: every 'provisional: true' product literal in scanStore.ts stamps provenanceTier", () => {
    // Same static-source-check idiom as src/services/keySafety.test.ts: lock the invariant at the
    // source level so a future provisional mint site cannot forget the tier.
    const src = readFileSync(join(process.cwd(), "src", "stores", "scanStore.ts"), "utf8");
    const mintLines = src.split("\n").filter((l) => l.includes("provisional: true,"));
    expect(mintLines.length, "the three known mint sites exist").toBeGreaterThanOrEqual(3);
    for (const line of mintLines) {
      expect(line, `provisional mint missing provenanceTier: ${line.trim()}`).toContain('provenanceTier: "provisional"');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/provenanceTier.store.test.ts`
Expected: FAIL - the STATIC LOCK test reports the :2614 and :2887 mint lines missing `provenanceTier` (the :2954 line already carries it from Task 2; the BEHAVIOR test passes).

- [ ] **Step 3: Write minimal implementation**

In `src/stores/scanStore.ts`, stamp the two remaining sites. Site :2614 (inside `runLiveDecodeOnce`) currently reads exactly:
```ts
                  confidence: decision?.confidence ?? 0, verified: false, provisional: true, createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
```
Change to:
```ts
                  confidence: decision?.confidence ?? 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
```
Site :2887 (the failed-decode mint) currently reads exactly:
```ts
              confidence: 0, verified: false, provisional: true, createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
```
(this exact string is unique by Task 3 time - the :2954 twin already carries `provenanceTier` after Task 2). Change to:
```ts
              confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
```

- [ ] **Step 4: Run test + typecheck to verify it passes**

Run: `npx vitest run src/stores/provenanceTier.store.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**
```bash
git add src/stores/scanStore.ts src/stores/provenanceTier.store.test.ts
git commit -m "feat(identity): provenanceTier stamped at all three provisional mint sites (P2 tier fill-in)"
```

---

## Task 4: D3 - ALL THREE orphan-transfer sites union scanEventIds / aliasesSeen / appliedIdempotencyKeys

**Files:**
- Modify: `src/stores/scanStore.ts` (new module-level helper + the three sites: `runLiveDecodeOnce` ~:2569-2594, `backgroundVerifyDeep` ~:3363-3390, `resolveUnknown` ~:3886-3910)
- Test: `src/stores/mergeUnion.store.test.ts`

**Interfaces:**
- Consumes: `createTestScanStore`, `MockDb`, `replayLedgerCounts` from Task 1, `InventoryCount` from `@/types` (already imported in scanStore.ts).
- Produces: module-level pure helper in scanStore.ts:
  `transferOrphanCount(finalCounts: InventoryCount[], oid: string, targetId: string | null, nowIso: string): InventoryCount[]`
  used at all three orphan-transfer sites, so the surviving count's `scanEventIds`, `aliasesSeen`, and `appliedIdempotencyKeys` are the UNION of both rows (orphan history survives; a replayed event stays a no-op; the copy-paste defect class dies permanently).

**Ground truth (verified 2026-07-19):** the identical quantity-only orphan-transfer fragment exists at THREE live sites, and only patching one leaves two production bugs:
1. `runLiveDecodeOnce` (~:2569-2594, `mergeOrphanId` -> `mergeTargetId`): the fast-decode auto-link merge; the comment at :2567 itself says "the SAME orphan-transfer pattern resolveUnknown uses". Runs on every live decode that auto-links to an existing product.
2. `backgroundVerifyDeep` (~:3363-3390, `ownProvId` -> `mergeTargetId`): the deep-verify merge. (An earlier review labeled this "applyDecodeFallback"; the enclosing store action is actually `backgroundVerifyDeep`, which starts at :3017 - `applyDecodeFallback` at :3011 is a 4-line wrapper around `ensureProvisionalCount` with no merge of its own.)
3. `resolveUnknown` (~:3886-3910, `removeOrphanId` -> `orphanTransferTargetId`): the human/batch resolution merge.
All three transfer `quantity` only and drop the three anti-double-count ledger fields. The target-row-absent branch (`[...finalCounts, { ...orphanRow, productId: targetId }]`) already carries them by re-pointing the whole orphanRow.

- [ ] **Step 1: Write the failing test**

Create `src/stores/mergeUnion.store.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";

// D3: all three orphan-transfer sites (resolveUnknown merge, runLiveDecodeOnce fast-decode auto-link,
// backgroundVerifyDeep deep-verify merge) must UNION the surviving count's scanEventIds / aliasesSeen /
// appliedIdempotencyKeys so orphan history survives the merge and a replayed event id stays a no-op.

type Store = ReturnType<typeof createTestScanStore>;

function assertMergedLedger(store: Store, targetProductId: string) {
  const merged = store.getState().finalCounts.find((c) => c.productId === targetProductId)!;
  expect(merged, "the merge target still has a count row").toBeDefined();
  const feedIds = store.getState().scanFeed.filter((e) => e.matchedProductId === targetProductId).map((e) => e.id);
  for (const id of feedIds) {
    expect(merged.scanEventIds, `feed event ${id} recorded on the surviving count (union, not overwrite)`).toContain(id);
  }
  const replay = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId)
    .find((c) => c.productId === targetProductId)!;
  expect(replay.quantity, "replay reproduces the merged quantity").toBe(merged.quantity);
  expect(new Set(merged.scanEventIds), "replay reproduces the exact scanEventIds set").toEqual(new Set(replay.scanEventIds));
}

describe("D3 site 3: resolveUnknown merge unions the anti-double-count ledger fields", () => {
  it("merging an orphan into a target unions scanEventIds and preserves total quantity", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });

    // Count two distinct provisional identities (one scan each).
    store.getState().processScan("111111111116");
    store.getState().processScan("222222222229");
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);

    // Resolve the SECOND code by linking it to the FIRST code's provisional product (a merge).
    const target = store.getState().products.find((p) => p.primaryBarcode === "111111111116")!;
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "222222222229" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "link_existing", {
      applyToCount: true, origin: "human", productId: target.id,
    });

    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0), "quantity conserved across the merge").toBe(2);
    expect(store.getState().finalCounts.find((c) => c.productId === target.id)!.quantity).toBe(2);
    assertMergedLedger(store, target.id);
  });
});

describe("D3 site 1: runLiveDecodeOnce fast-decode auto-link merge unions the placeholder's history", () => {
  it("a live VERIFIED decode carrying the same GTIN merges the scan's placeholder into the existing product with the union", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Seed an existing counted product with a GTIN via the human-resolution path (AI off).
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("036000291452");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291452" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Duracell AA 4pk", brand: "Duracell", category: "Battery", primaryBarcode: "036000291452", gtin: "036000291452" },
    });
    const p1 = store.getState().products.find((p) => p.primaryBarcode === "036000291452")!;
    expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(1);

    // Now scan a DIFFERENT code whose LIVE decode returns a VERIFIED identity with the SAME canonical
    // GTIN -> identity-merge auto_link -> the scan's own placeholder (mergeOrphanId) transfers into p1.
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providerNames: ["gemini"],
        results: [{
          productName: "Duracell AA 4pk", brand: "Duracell", category: "Battery", specsShort: "", specsFull: "",
          primarySku: "", primaryBarcode: "036000291452", gtin: "0036000291452", upc: "", ean: "", aliases: [],
          imageUrl: "", productUrl: "", sourceUrls: ["https://duracell.com/aa"], confidence: 0.92, verifiedFacts: [], guesses: [],
        }],
        decision: { status: "verified", confidence: 0.92, reason: "Verified.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
      }),
    })) as unknown as typeof fetch;
    try {
      store.getState().processScan("VENDOR-SKU-88");
      await vi.waitFor(() => {
        expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(2);
      });
    } finally {
      globalThis.fetch = original;
    }
    assertMergedLedger(store, p1.id);
  });
});

describe("D3 site 2: backgroundVerifyDeep merge unions the placeholder's history", () => {
  it("a deep-verified tire decode carrying the same GTIN merges the scan's own placeholder (ownProvId) with the union", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Seed the existing counted tire (same canonical GTIN the deep decode will report), AI off.
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("715459332915");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "715459332915" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Hankook Dynapro AT2 LT265/70R17 121S", brand: "Hankook", category: "Tire", specsShort: "LT265/70R17 121S", primaryBarcode: "715459332915", gtin: "715459332915" },
    });
    const p1 = store.getState().products.find((p) => p.primaryBarcode === "715459332915")!;

    // Tire context + AI on: scan a DIFFERENT code; the fast decode answers "suggested" (which auto-fires
    // the decode-deep background verify, see backgroundVerifyDeep.store.test.ts's proven modeStub idiom);
    // the deep response is VERIFIED with the SAME GTIN -> backgroundVerifyDeep merges ownProvId into p1.
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
    const identity = {
      productName: "Hankook Dynapro AT2 LT265/70R17 121S", brand: "Hankook", category: "Tire",
      specsShort: "LT265/70R17 121S", specsFull: "", primarySku: "", primaryBarcode: "715459332915",
      gtin: "715459332915", upc: "", ean: "", aliases: [], imageUrl: "",
      productUrl: "https://hankooktire.com/dynapro-at2", sourceUrls: ["https://hankooktire.com/dynapro-at2"],
      confidence: 0.92, verifiedFacts: [], guesses: [],
    };
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.mode === "decode-deep") {
        return { ok: true, json: async () => ({ providerNames: ["gemini"], results: [identity], decision: { status: "verified", confidence: 0.92, reason: "Verified: exact code on page.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } } }) };
      }
      return { ok: true, json: async () => ({ providerNames: ["gemini"], results: [{ ...identity, confidence: 0.6, sourceUrls: ["https://www.upcitemdb.com/upc/715459332915"] }], decision: { status: "suggested", confidence: 0.6, reason: "Grounded, not app-verified.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } } }) };
    }) as unknown as typeof fetch;
    try {
      store.getState().processScan("HANKOOK-PN-77");
      await vi.waitFor(() => {
        expect(store.getState().finalCounts.find((c) => c.productId === p1.id)?.quantity).toBe(2);
      });
    } finally {
      globalThis.fetch = original;
    }
    assertMergedLedger(store, p1.id);
  });
});
```

Implementer note on the two live-decode tests: the merge target selection is `identityMerge`'s auto_link rule (same canonical GTIN across encodings - the exact recipe `src/stores/identityMerge.store.test.ts` test 1 proves for the resolveUnknown path, and `src/stores/backgroundVerifyDeep.store.test.ts` proves for the deep flow). If a run shows the decode taking a different sub-branch (e.g. suggest_link), adjust the scanned code / decode payload per those two proven recipes - do NOT weaken the union assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/mergeUnion.store.test.ts`
Expected: FAIL on all three sites' union assertions: the surviving count's `scanEventIds` does not contain the orphan's original event id (only quantity was transferred), so the live set differs from the replay set.

- [ ] **Step 3: Write the shared helper**

In `src/stores/scanStore.ts`, add a module-level pure helper directly below `makeQueueItem` (after scanStore.ts:740):
```ts
// D3 FIX (shared by ALL THREE orphan-transfer sites: runLiveDecodeOnce's fast-decode auto-link merge,
// backgroundVerifyDeep's deep-verify merge, and resolveUnknown's merge): move an orphan placeholder's
// count onto the merge target, UNIONING the anti-double-count ledger fields (scanEventIds / aliasesSeen /
// appliedIdempotencyKeys) so orphan history survives the merge and a replayed event id stays a no-op.
// Deduped unions keep a repeated merge idempotent. Pure: returns a new array, never mutates. A null
// targetId (or a zero-quantity orphan) just drops the orphan row - identical to each site's old behavior.
function transferOrphanCount(
  finalCounts: InventoryCount[],
  oid: string,
  targetId: string | null,
  nowIso: string,
): InventoryCount[] {
  const orphanRow = finalCounts.find((c) => c.productId === oid);
  const orphanQty = orphanRow?.quantity ?? 0;
  let next = finalCounts.filter((c) => c.productId !== oid);
  if (targetId && orphanRow && orphanQty > 0) {
    const targetRow = next.find((c) => c.productId === targetId);
    next = targetRow
      ? next.map((c) =>
          c.productId === targetId
            ? {
                ...c,
                quantity: c.quantity + orphanQty,
                scanEventIds: Array.from(new Set([...c.scanEventIds, ...orphanRow.scanEventIds])),
                aliasesSeen: Array.from(new Set([...c.aliasesSeen, ...orphanRow.aliasesSeen])),
                appliedIdempotencyKeys: Array.from(new Set([...c.appliedIdempotencyKeys, ...orphanRow.appliedIdempotencyKeys])),
                updatedAt: nowIso,
              }
            : c,
        )
      : [...next, { ...orphanRow, productId: targetId, updatedAt: nowIso }];
  }
  return next;
}
```
(`InventoryCount` is already imported in scanStore.ts.)

- [ ] **Step 4: Replace all three sites with the helper**

SITE 1 - `runLiveDecodeOnce` (scanStore.ts:2572-2593). The current code:
```ts
                  set((st) => {
                    const orphanRow = st.finalCounts.find((c) => c.productId === oid);
                    const orphanQty = orphanRow?.quantity ?? 0;
                    let finalCounts = st.finalCounts.filter((c) => c.productId !== oid);
                    if (orphanQty > 0) {
                      const targetRow = finalCounts.find((c) => c.productId === targetId);
                      finalCounts = targetRow
                        ? finalCounts.map((c) =>
                            c.productId === targetId ? { ...c, quantity: c.quantity + orphanQty, updatedAt: now() } : c,
                          )
                        : orphanRow
                          ? [...finalCounts, { ...orphanRow, productId: targetId, updatedAt: now() }]
                          : finalCounts;
                    }
                    return {
                      products: st.products.filter((p) => p.id !== oid),
                      finalCounts,
                      scanFeed: st.scanFeed.map((e) =>
                        e.matchedProductId === oid ? { ...e, matchedProductId: targetId } : e,
                      ),
                    };
                  });
```
Replace with:
```ts
                  set((st) => ({
                    products: st.products.filter((p) => p.id !== oid),
                    finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
                    scanFeed: st.scanFeed.map((e) =>
                      e.matchedProductId === oid ? { ...e, matchedProductId: targetId } : e,
                    ),
                  }));
```

SITE 2 - `backgroundVerifyDeep` (scanStore.ts:3366-3379). The current finalCounts computation inside its `set((st) => { ... })`:
```ts
                  const orphanRow = st.finalCounts.find((c) => c.productId === oid);
                  const orphanQty = orphanRow?.quantity ?? 0;
                  let finalCounts = st.finalCounts.filter((c) => c.productId !== oid);
                  if (orphanQty > 0) {
                    const targetRow = finalCounts.find((c) => c.productId === targetId);
                    finalCounts = targetRow
                      ? finalCounts.map((c) =>
                          c.productId === targetId ? { ...c, quantity: c.quantity + orphanQty, updatedAt: now() } : c,
                        )
                      : orphanRow
                        ? [...finalCounts, { ...orphanRow, productId: targetId, updatedAt: now() }]
                        : finalCounts;
                  }
```
Replace with:
```ts
                  const finalCounts = transferOrphanCount(st.finalCounts, oid, targetId, now());
```
Keep everything else in that `set` (the `products` filter, the decodeStatus-aware `scanFeed` map, and the `needsReviewQueue` map) exactly as it is.

SITE 3 - `resolveUnknown` (scanStore.ts:3889-3909). The current code:
```ts
          set((st) => {
            const orphanRow = st.finalCounts.find((c) => c.productId === oid);
            const orphanQty = orphanRow?.quantity ?? 0;
            let finalCounts = st.finalCounts.filter((c) => c.productId !== oid);
            if (targetId && orphanQty > 0) {
              const targetRow = finalCounts.find((c) => c.productId === targetId);
              finalCounts = targetRow
                ? finalCounts.map((c) =>
                    c.productId === targetId ? { ...c, quantity: c.quantity + orphanQty, updatedAt: now() } : c,
                  )
                : orphanRow
                  ? [...finalCounts, { ...orphanRow, productId: targetId, updatedAt: now() }]
                  : finalCounts;
            }
            return {
              finalCounts,
              scanFeed: st.scanFeed.map((e) =>
                e.matchedProductId === oid ? { ...e, matchedProductId: targetId ?? null } : e,
              ),
            };
          });
```
Replace with:
```ts
          set((st) => ({
            finalCounts: transferOrphanCount(st.finalCounts, oid, targetId, now()),
            scanFeed: st.scanFeed.map((e) =>
              e.matchedProductId === oid ? { ...e, matchedProductId: targetId ?? null } : e,
            ),
          }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/stores/mergeUnion.store.test.ts src/stores/identityMerge.store.test.ts src/stores/orphanedCountDedup.store.test.ts src/stores/backgroundVerifyDeep.store.test.ts`
Expected: PASS (new 3-site suite + the three existing merge/dedup/deep suites stay green).

- [ ] **Step 6: Commit**
```bash
git add src/stores/scanStore.ts src/stores/mergeUnion.store.test.ts
git commit -m "fix(ledger): D3 - shared transferOrphanCount unions ledger fields at all three merge sites"
```

---

## Task 5: D2 - markWrong transfers quantity instead of destroying it (+ example-gate regression lock)

**Files:**
- Modify: `src/stores/scanStore.ts` (`markWrong`, ~:4508-4577; the count-delete is :4561-4565)
- Test: `src/stores/markWrongTransfer.store.test.ts`

**Interfaces:**
- Consumes: `createTestScanStore`, `MockDb`, `replayLedgerCounts` (Task 1), `ensureProvisionalCount` (existing; enqueues + same-fact delta per Task 2), `incrementInventoryCount` (already imported in scanStore.ts).
- Produces: `markWrong(productId)` moves the wrong product's full `count.quantity` to an "Unidentified item" provisional row keyed by the representative scanned code, repoints the affected feed events onto that provisional and re-applies them through the ledger, reopens review. Total physical quantity is invariant across the correction AND the replay invariant holds: the transferred quantity is carried by real repointed events, and on a persist-trimmed feed the residual rides a synthetic backing ScanEvent appended to the feed and applied through the ledger - never a naked number, so `replayLedgerCounts` reproduces the count exactly in every case. Example/test-barcode classification is preserved: an example code never mints a counted provisional that re-trips the b4ff79a paid-rung example-gate or settles verified.

**Ground truth (verified 2026-07-19):** `markWrong` step 3 (scanStore.ts:4561-4565) does `finalCounts.filter((c) => c.productId !== productId)` and emits a `count_removed` audit - the `count.quantity` vanishes with no transfer. Step 2 (scanStore.ts:4554-4560) already repoints the wrong product's feed rows to `matchedProductId: null` and `status: needs_review`. Step 4 (scanStore.ts:4566-4570) reopens review via `reopenNeedsReview(code, ...)`; the representative code is `seenCodes[0] || product?.primaryBarcode || ""` (:4567).

**ORDERING CONSTRAINT (would stall if ignored):** `ensureProvisionalCount`'s idempotency guard (scanStore.ts:2932-2939) short-circuits when ANY currently-counted, non-archived product carries the code in `primaryBarcode`/`gtin`/`upc`/`ean`/`primarySku`. The WRONG product still carries the code (step 1b at :4541-4552 un-verifies it but does NOT blank `primaryBarcode`), so calling `ensureProvisionalCount` BEFORE removing the wrong count row makes the guard match the wrong product and return early - nothing is minted, the transfer never happens. The guard's `counted` set is built from `finalCounts` (:2932), so removing the wrong count row FIRST is sufficient to un-match it; no identifier blanking is needed.

- [ ] **Step 1: Write the failing test**

Create `src/stores/markWrongTransfer.store.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";

const total = (store: ReturnType<typeof createTestScanStore>) =>
  store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);

// Seed a VERIFIED product + approved alias so the scan resolves "known" and counts against it, then
// markWrong it. The physical quantity must survive as an Unidentified provisional, not vanish.
function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const s = store.getState();
  const productId = "seed-wrong-1";
  store.setState((prev) => ({
    products: [...prev.products, {
      id: productId, businessId: s.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
      specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
      vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
      source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
    }],
    aliases: [...prev.aliases, {
      id: "alias-wrong-1", businessId: s.businessId, productId, rawCodeExample: code, cleanCode: code,
      normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
      createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", lastSeenAt: s.sessionId,
      syncStatus: "synced", idempotencyKey: "seed-alias-wrong-1",
    }],
  }));
  return productId;
}

describe("D2: markWrong transfers quantity instead of destroying it", () => {
  it("marking a counted product wrong keeps total physical quantity constant", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);

    store.getState().processScan(code); // counts against the (wrong) verified product
    store.getState().processScan(code); // qty 2
    expect(total(store)).toBe(2);

    await store.getState().markWrong(productId, { reason: "test" });

    // The wrong product's count is gone, but the 2 physical items survive on an Unidentified provisional.
    expect(total(store), "total physical quantity is invariant across markWrong").toBe(2);
    expect(store.getState().finalCounts.some((c) => c.productId === productId)).toBe(false);
    const unidentified = store.getState().products.find(
      (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === code,
    );
    expect(unidentified, "an Unidentified provisional now carries the quantity").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === unidentified!.id)!.quantity).toBe(2);
  });

  it("a ledger replay after markWrong reproduces the surviving quantity and scanEventIds", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);
    store.getState().processScan(code);
    store.getState().processScan(code);
    await store.getState().markWrong(productId, { reason: "test" });

    const unidentified = store.getState().products.find((p) => p.provisional && p.primaryBarcode === code)!;
    const live = store.getState().finalCounts.find((c) => c.productId === unidentified.id)!;
    const replay = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId)
      .find((c) => c.productId === unidentified.id)!;
    expect(replay.quantity).toBe(live.quantity);
    expect(new Set(live.scanEventIds)).toEqual(new Set(replay.scanEventIds));
  });

  it("EXAMPLE-GATE REGRESSION LOCK: an example barcode marked wrong never dispatches a paid decode and never settles verified", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // AI ON so a paid decode WOULD dispatch if the example-gate ever regressed.
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    // Spy on fetch: a paid decode POST to /api/ai-lookup would flow through here.
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(async () => { throw new Error("no live call allowed"); }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const exampleCode = "4006381333931"; // textbook GS1 example barcode (b4ff79a blocklist)
      const productId = seedKnown(store, exampleCode);
      store.getState().processScan(exampleCode);
      await store.getState().markWrong(productId, { reason: "test" });
      // The transferred provisional stays an Unidentified/needs-review row, never verified.
      const prov = store.getState().products.find((p) => p.provisional && p.primaryBarcode === exampleCode);
      expect(prov).toBeDefined();
      expect(prov!.verified).toBe(false);
      const row = store.getState().scanFeed.find((e) => e.matchedProductId === prov!.id);
      expect(row?.decodeStatus === "verified").toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/markWrongTransfer.store.test.ts`
Expected: FAIL. The first two tests fail because `total(store)` drops to 0 after markWrong (the count row is filtered out with no transfer), and no Unidentified provisional carries the quantity.

- [ ] **Step 3: Write minimal implementation**

In `src/stores/scanStore.ts`, `markWrong` step 3 plus the `code` declaration (scanStore.ts:4561-4567) currently read:
```ts
        // 3. Remove the session count (product + now-deactivated aliases are kept for audit/repair).
        if (count) {
          set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
          emitAudit({ entityType: "InventoryCount", entityId: count.id, action: "count_removed", metadata: { productId, quantity: count.quantity, reason: "marked_wrong" } });
        }
        // 4. Reopen Needs Review for the representative scanned code.
        const code = seenCodes[0] || product?.primaryBarcode || "";
```
Replace with (order is the whole fix - see ORDERING CONSTRAINT above: (a) remove the wrong count row FIRST so `ensureProvisionalCount`'s guard at :2932-2939 cannot match the still-counted wrong product, (b) THEN mint + count the provisional, (c) then repoint-and-apply the remaining events, (d) then a synthetic residual backing event for the feed-trim edge):
```ts
        // 3. Transfer the wrong product's physical quantity to a SAFE "Unidentified item" provisional
        //    keyed by the representative scanned code, then reopen review. Total physical quantity is
        //    INVARIANT across any identity correction (North-star #2): the items are still on the
        //    shelf; only their identity was wrong.
        const code = seenCodes[0] || product?.primaryBarcode || "";
        if (count) {
          const wrongQty = count.quantity;
          // (a) Remove the wrong count row FIRST. ensureProvisionalCount's idempotency guard
          //     (scanStore.ts:2932-2939) short-circuits when any CURRENTLY-COUNTED product carries this
          //     code in its identifier fields - the wrong product still does (step 1b un-verifies but
          //     does not blank primaryBarcode). Its `counted` set is built from finalCounts, so removing
          //     the row here is what lets the mint below proceed.
          set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
          if (code && wrongQty > 0) {
            // (b) Mint + count the Unidentified provisional off the first reopened feed row (step 2
            //     already reset the wrong product's rows to matchedProductId: null / needs_review, which
            //     is exactly the shape ensureProvisionalCount's feed lookup matches). Task 2's D1 repair
            //     makes this mint enqueue SAVE_PRODUCT + SAVE_SCAN_EVENT + INCREMENT_COUNT too.
            get().ensureProvisionalCount(code, `Marked wrong - re-identify. Previous match "${product?.name ?? ""}" removed.`);
            const provRow = get().products.find(
              (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === code,
            );
            if (provRow) {
              // (c) Repoint every REMAINING reopened feed event for this code onto the provisional and
              //     apply each through the ledger (incrementInventoryCount dedupes by event id), stamping
              //     the same-fact quantityDelta: 1 on the row. The transferred quantity is carried by
              //     REAL events - the ledger replay reproduces it exactly (North-star #2).
              const pending = get().scanFeed.filter(
                (e) => e.cleanCode === code && e.matchedProductId === null && e.status === "needs_review",
              );
              for (const ev2 of pending) {
                const stNow = get();
                const cur = stNow.finalCounts.find((c) => c.productId === provRow.id);
                if (cur?.scanEventIds.includes(ev2.id)) continue;
                const r = incrementInventoryCount(
                  stNow.finalCounts,
                  { ...ev2, matchedProductId: provRow.id, status: "known", quantityDelta: 1 },
                  idFactory,
                );
                set((s2) => ({
                  finalCounts: r.counts,
                  scanFeed: s2.scanFeed.map((e) =>
                    e.id === ev2.id
                      ? { ...e, matchedProductId: provRow.id, status: "known" as const, quantityDelta: 1, quantityAfterScan: r.count.quantity }
                      : e,
                  ),
                }));
              }
              // (d) Feed-trim safety net: if the wrong count carried MORE events than the current feed
              //     exposes (a persist-trimmed feed), carry the residual on a SYNTHETIC BACKING EVENT
              //     appended to the feed and applied through the ledger - NEVER a naked quantity bump.
              //     replayLedgerCounts rebuilds counts from feed events only, so a bare `quantity +=`
              //     would be quantity no replay can reproduce - the exact invariant this phase exists
              //     to guarantee. On a complete feed (every unit test + normal sessions) the repoint
              //     loop above accounts for everything, missing is 0, and this mints nothing.
              const applied = get().finalCounts.find((c) => c.productId === provRow.id)?.quantity ?? 0;
              const missing = wrongQty - applied;
              if (missing > 0) {
                const residualId = idFactory();
                const residualEvent: ScanEvent = {
                  id: residualId,
                  businessId: state.businessId,
                  sessionId: state.sessionId,
                  rawCode: code,
                  cleanCode: code,
                  normalizedCandidates: [],
                  matchedProductId: provRow.id,
                  matchType: "unknown",
                  status: "known",
                  resolverStatus: "needs_review",
                  codeType: detectCodeType(code),
                  reason: "markWrong residual repoint (feed trimmed by persist).",
                  quantityDelta: missing,
                  quantityAfterScan: 0,
                  createdAt: now(),
                  source: "scan",
                  notes: "markWrong residual repoint (feed trimmed by persist).",
                  syncStatus: "pending",
                  syncError: null,
                  idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, residualId, "INCREMENT_COUNT"),
                };
                const rr = incrementInventoryCount(get().finalCounts, residualEvent, idFactory);
                residualEvent.quantityAfterScan = rr.count.quantity;
                set((s2) => ({
                  scanFeed: [residualEvent, ...s2.scanFeed],
                  finalCounts: rr.counts,
                }));
                // Enqueue the synthetic event like any counted scan (SAVE_SCAN_EVENT + INCREMENT_COUNT).
                // Without this, the derived syncStatus reconcile (scanStore.ts:907-922) would report an
                // event absent from pendingSyncQueue as "synced" - re-minting the exact fake-synced
                // class Task 2 killed. No SAVE_PRODUCT here: ensureProvisionalCount already enqueued it.
                const residualInc: IncrementPayload = {
                  businessId: state.businessId, sessionId: state.sessionId, productId: provRow.id,
                  scanEventId: residualId, quantityDelta: missing, idempotencyKey: residualEvent.idempotencyKey,
                };
                enqueueAndSync([
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "ScanEvent", entityId: residualId, operation: "SAVE_SCAN_EVENT", payload: residualEvent, idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, residualId, "SAVE_SCAN_EVENT"), scanEventId: residualId }),
                  makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "InventoryCount", entityId: rr.count.id, operation: "INCREMENT_COUNT", payload: residualInc, idempotencyKey: residualEvent.idempotencyKey, scanEventId: residualId }),
                ]);
              }
            }
          }
          emitAudit({ entityType: "InventoryCount", entityId: count.id, action: "count_transferred", metadata: { productId, quantity: wrongQty, toCode: code, reason: "marked_wrong" } });
        }
        // 4. Reopen Needs Review for the representative scanned code.
```
Then DELETE the now-duplicated `const code = seenCodes[0] || product?.primaryBarcode || "";` line that previously sat at scanStore.ts:4567 (it is declared above now). The `const reviewId = code ? get().reopenNeedsReview(...) : null;` block that follows stays unchanged.

Notes for the implementer:
- Do not change step 1/1b/2 (alias deactivation at :4520-4536, product un-verify at :4541-4552, feed reset at :4554-4560) or step 4/5 (reopen review + correctionRecheck).
- The repoint loop may also pick up an older uncounted needs_review row for the same code that step 2 did not create; counting it is correct under the TOP-LEVEL LAW (a physically scanned code counts) and keeps live === replay. The residual backing event only ever ADDS (missing > 0), never subtracts, and because it is a real feed event applied through `incrementInventoryCount` (recorded in `scanEventIds` + `appliedIdempotencyKeys`) and enqueued like any counted scan, replay reproduces it and it can never read as fake-synced. `ScanEvent`, `detectCodeType`, and `state` (captured at the top of `markWrong`, :4509) are all already in scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stores/markWrongTransfer.store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run markWrong regression nets**

Run: `npx vitest run src/stores/orphanedCountDedup.store.test.ts src/stores/aliasRepair.store.test.ts src/components/FinalCountTable.test.tsx`
Expected: PASS. (These cover the markWrong-distinct dedup path, alias repair, and the FinalCountTable "Mark wrong hidden" UI test - the store-level transfer must not regress them. Note: `orphanedCountDedup.store.test.ts`'s second test asserts a markWrong'd product is never silently reused - the transfer target is a NEW provisional row, not the wrong product, so that guarantee holds.)

- [ ] **Step 6: Commit**
```bash
git add src/stores/scanStore.ts src/stores/markWrongTransfer.store.test.ts
git commit -m "fix(ledger): D2 - markWrong transfers quantity to Unidentified provisional (invariant total; example-gate locked)"
```

---

## Task 6: D7 - per-rung AbortController timeout + total wall-clock ceiling in the ladder

**Files:**
- Modify: `src/server/upc/ladder.ts` (`runLadder`, `LadderRung`, `RunLadderOpts`, ~:26-75)
- Modify: `src/server/decode/pipeline.ts` (add `perRungTimeoutMs` at the three `runLadder` call sites, ~:1127, :1250, :1266)
- Test: `src/server/upc/ladderTimeout.test.ts`

**Interfaces:**
- Produces:
  - `RunLadderOpts` gains `perRungTimeoutMs?: number` (default from `DECODE_LADDER_RUNG_MS`, hard fallback 8000) and keeps `deadlineAt?`/`now?`.
  - `LadderRung.run` signature becomes `(ctx: RunLadderContext) => Promise<RungOutcome>` where `RunLadderContext = { signal: AbortSignal }` (backward compatible: existing rungs ignore the arg). `runLadder` races each `r.run(...)` against an AbortController that aborts at `min(perRungTimeout, remaining wall-clock)`; a timed-out rung records `{ rung, reason: "aborted: ..." }` and the ladder moves on or settles best-so-far.
  - **Honest scope of the guarantee:** the LADDER never waits past the budget - the identity answer is bounded. The ABANDONED rung's underlying network call may keep running server-side until its own fetch timeout; threading the abort signal into every provider's fetch is an explicit follow-up (deferred), not part of this task. What the acceptance criterion requires - the decode response is settled within the wall-clock ceiling and the abort fired - is fully delivered.

**Ground truth (verified 2026-07-19):** `runLadder` (ladder.ts:60-75) does `const outcome = await r.run();` - an unbounded await. The existing deadline check (ladder.ts:64) only gates rung STARTS. The existing test at ladder.test.ts:173-195 explicitly asserts "A rung already in flight is NEVER aborted" - THIS BEHAVIOR IS THE DEFECT; that test's synchronous slow rung still passes under the new code (it settles immediately in fake time before any real timer fires), so only its comment may need updating. `pipeline.ts` already passes `{ deadlineAt: ladderDeadlineAt }` to all three `runLadder` calls (pipeline.ts:1127, :1250, :1266) and `ladderDeadlineAt = decodeStartedAt + max(DECODE_LADDER_TOTAL_MS=15000, budgetMs)` (pipeline.ts:435). `intEnv` is already imported in pipeline.ts (:20).

- [ ] **Step 1: Write the failing test**

Create `src/server/upc/ladderTimeout.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLadder, type LadderRung, type RungOutcome } from "./ladder";

const settled = (reason: string): RungOutcome => ({ settled: true, payload: { hit: true }, reason });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("D7: per-rung hard timeout aborts an in-flight rung", () => {
  it("aborts a rung that never resolves, records an 'aborted' reason, and moves on", async () => {
    // A rung that never settles on its own; it must be aborted by the per-rung timeout.
    const hang: LadderRung = {
      name: "hang",
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const nextRung: LadderRung = { name: "next", run: async () => settled("next verified") };

    const p = runLadder("049000006346", [hang, nextRung], { perRungTimeoutMs: 5000, now: () => Date.now() });
    // Advance past the per-rung timeout so the AbortController fires.
    await vi.advanceTimersByTimeAsync(6000);
    const r = await p;

    expect(r.reasons[0].rung).toBe("hang");
    expect(r.reasons[0].reason).toMatch(/aborted/i);
    expect(r.settledBy).toBe("next");
  });

  it("bounds the ladder at the total wall-clock ceiling: an in-flight rung past deadlineAt is aborted (the ladder never waits on it)", async () => {
    const abortSpy = vi.fn();
    const hang: LadderRung = {
      name: "hang",
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => { abortSpy(); reject(new Error("aborted")); });
        }),
    };
    const start = Date.now();
    const p = runLadder("049000006346", [hang], { deadlineAt: start + 4000, perRungTimeoutMs: 60000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(abortSpy, "the in-flight rung was aborted at the wall-clock ceiling").toHaveBeenCalled();
    expect(r.settledBy).toBeUndefined();
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });

  it("a rung that settles before its timeout is unaffected (backward compatible)", async () => {
    const fast: LadderRung = { name: "fast", run: async () => settled("fast hit") };
    const p = runLadder("049000006346", [fast], { perRungTimeoutMs: 5000 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.settledBy).toBe("fast");
  });

  it("LATE-RESOLVE GUARD: a rung that answers AFTER the ladder moved on cannot mutate the returned result or reasons", async () => {
    let lateResolve: ((o: RungOutcome) => void) | undefined;
    const hang: LadderRung = {
      name: "hang",
      run: () => new Promise<RungOutcome>((resolve) => { lateResolve = resolve; }),
    };
    const nextRung: LadderRung = { name: "next", run: async () => settled("next verified") };
    const p = runLadder("049000006346", [hang, nextRung], { perRungTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;
    const reasonsSnapshot = JSON.stringify(r.reasons);
    const settledBySnapshot = r.settledBy;
    // The abandoned rung answers late - the returned result must not change.
    lateResolve?.({ settled: true, payload: { hijack: true }, reason: "late hijack" });
    await vi.runAllTimersAsync();
    expect(JSON.stringify(r.reasons)).toBe(reasonsSnapshot);
    expect(r.settledBy).toBe(settledBySnapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/upc/ladderTimeout.test.ts`
Expected: FAIL - `runLadder` calls `r.run()` with no argument (destructuring `{ signal }` throws), and it awaits unbounded, so the hang rung never rejects and the ladder promise never resolves (test times out).

- [ ] **Step 3: Write minimal implementation**

In `src/server/upc/ladder.ts`, update the interfaces and `runLadder`.

Change `LadderRung` (ladder.ts:26-29):
```ts
export interface RunLadderContext {
  /** Aborts when this rung exceeds its per-rung timeout OR the total wall-clock ceiling. */
  signal: AbortSignal;
}

export interface LadderRung {
  name: string;
  run: (ctx: RunLadderContext) => Promise<RungOutcome>;
}
```

Add to `RunLadderOpts` (ladder.ts:42-47):
```ts
export interface RunLadderOpts {
  deadlineAt?: number;
  now?: () => number;
  /** Per-rung hard timeout (ms). A rung that does not settle within this window (or before the total
   *  deadlineAt, whichever is sooner) is abandoned: its AbortController fires, an "aborted" reason is
   *  recorded, and the ladder moves on or settles best-so-far. NOTE the honest scope: the LADDER stops
   *  waiting - the rung's own underlying fetch may keep running server-side until its provider-level
   *  timeout (signal threading into every provider fetch is a deferred follow-up). Omit BOTH this and
   *  deadlineAt for the legacy unbounded behavior. */
  perRungTimeoutMs?: number;
}
```

Replace `runLadder` (ladder.ts:60-75):
```ts
export async function runLadder(_code: string, rungs: LadderRung[], opts: RunLadderOpts = {}): Promise<LadderResult> {
  const now = opts.now ?? Date.now;
  const reasons: Array<{ rung: string; reason: string }> = [];
  for (const r of rungs) {
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
      reasons.push({ rung: r.name, reason: "skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)" });
      continue;
    }
    // Per-rung hard budget = min(perRungTimeout, remaining wall-clock to the total deadline). The
    // ladder stops WAITING on an in-flight rung at this budget - the D7 fix: a started rung is no
    // longer an unbounded await (the abandoned rung's own network call may still run server-side
    // until its provider timeout; the ladder result is already settled and immune to it - see the
    // late-resolve guard test). When neither a per-rung timeout nor a deadline is set, the rung runs
    // unbounded (legacy behavior, fully backward compatible).
    const controller = new AbortController();
    const budgets: number[] = [];
    if (opts.perRungTimeoutMs !== undefined) budgets.push(opts.perRungTimeoutMs);
    if (opts.deadlineAt !== undefined) budgets.push(Math.max(0, opts.deadlineAt - now()));
    const budgetMs = budgets.length > 0 ? Math.min(...budgets) : undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: RungOutcome;
    try {
      if (budgetMs !== undefined) {
        const abortedPromise = new Promise<never>((_res, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("ladder-rung-timeout"));
          }, budgetMs);
        });
        outcome = await Promise.race([r.run({ signal: controller.signal }), abortedPromise]);
      } else {
        outcome = await r.run({ signal: controller.signal });
      }
    } catch {
      // Timeout OR the rung itself threw after abort: record an honest "aborted" reason and move on.
      reasons.push({ rung: r.name, reason: `aborted: rung exceeded its budget (${budgetMs ?? "unbounded"}ms) - DECODE_LADDER_RUNG_MS / DECODE_LADDER_TOTAL_MS` });
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
    reasons.push({ rung: r.name, reason: outcome.reason });
    if (outcome.settled) {
      return { settledBy: r.name, outcome, reasons };
    }
  }
  return { reasons };
}
```

Existing-test note: `src/server/upc/ladder.test.ts:174-195` ("skips rungs whose start time is past the deadline") uses a slow rung whose `run: async () => {...}` settles immediately in fake time - it ignores the new ctx arg (valid TS) and still passes. If it fails only on its inline comment expectations, update the comment text, never the assertions on skip reasons.

In `src/server/decode/pipeline.ts`, add `perRungTimeoutMs` at the three call sites so production gets bounded rungs. At pipeline.ts:1127, :1250, and :1266, change each
```ts
{ deadlineAt: ladderDeadlineAt }
```
to
```ts
{ deadlineAt: ladderDeadlineAt, perRungTimeoutMs: intEnv(process.env.DECODE_LADDER_RUNG_MS, 8000) }
```
The rung runners (`runGoUpc`/`runFetchV2`/`runGpt`/`runUpcItemDb`/`runOpenFoodFacts`) currently take no arg - they still compile (the new ctx arg is simply not consumed). Threading the signal INTO the provider fetches is the deferred follow-up named above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/upc/ladderTimeout.test.ts src/server/upc/ladder.test.ts`
Expected: PASS - new timeout suite (4 tests) green; existing ladder suite still green.

- [ ] **Step 5: Typecheck the pipeline change**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**
```bash
git add src/server/upc/ladder.ts src/server/upc/ladderTimeout.test.ts src/server/decode/pipeline.ts src/server/upc/ladder.test.ts
git commit -m "fix(decode): D7 - per-rung AbortController timeout + wall-clock ceiling (ladder never waits on an in-flight rung)"
```

---

## Task 7: The net-new ledger invariant suite across all 13 paths

**Files:**
- Create: `src/stores/ledgerInvariants.store.test.ts`

**Interfaces:**
- Consumes: `createTestScanStore`, `MockDb`, `replayLedgerCounts` (Task 1), the fixes from Tasks 2/4/5.
- Produces: the phase's crown gate. For every scan path it asserts the two book-balancing invariants + retry-safety.

**Ground truth:** the 13 paths map to concrete store setups already used across the existing store suites (see `countAlways.store.test.ts` for AI-off/offline/breaker; `failedDecodePlaceholder.store.test.ts` for decode-in-flight/failed; `mergeUnion.store.test.ts` (Task 4) for merges; `markWrongTransfer.store.test.ts` (Task 5) for post-markWrong). One clock fact matters for the cap path: `createTestScanStore` pins `now()` to `"2026-06-12T10:00:00.000Z"` (scanStore.ts:5160), and `processScan` computes `dailyCount = settings.lastResetDate === today ? settings.dailyLookupCount : 0` (:1528-1529) - so exercising a REAL cap hit requires `lastResetDate: "2026-06-12"` (matching the pinned clock) with `dailyLookupCount >= dailyLookupLimit`; the DEFAULT `lastResetDate` of "1970-01-01" silently resets the count to 0.

- [ ] **Step 1: Write the test suite**

Create `src/stores/ledgerInvariants.store.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";
import type { ScanEvent } from "@/types";

type Store = ReturnType<typeof createTestScanStore>;

// ---- Shared invariant assertions -----------------------------------------------------------------
function sumFeedDeltasByProduct(feed: ScanEvent[], sessionId: string): Map<string, number> {
  const seen = new Set<string>();
  const m = new Map<string, number>();
  for (const e of feed) {
    if (e.sessionId !== sessionId || !e.matchedProductId) continue;
    if (seen.has(e.id)) continue; // dedupe replayed ids exactly like the ledger
    seen.add(e.id);
    m.set(e.matchedProductId, (m.get(e.matchedProductId) ?? 0) + (e.quantityDelta ?? 0));
  }
  return m;
}

function assertBooksBalance(store: Store) {
  const { finalCounts, scanFeed, sessionId } = store.getState();
  // (1) per product: sum(feed deltas) === finalCounts.quantity
  const deltas = sumFeedDeltasByProduct(scanFeed, sessionId);
  for (const c of finalCounts) {
    expect(deltas.get(c.productId) ?? 0, `sum(feed deltas) === quantity for ${c.productId}`).toBe(c.quantity);
  }
  // (2) replay reproduces quantity AND exact scanEventIds set
  const replay = replayLedgerCounts(scanFeed, sessionId);
  for (const live of finalCounts) {
    const r = replay.find((x) => x.productId === live.productId);
    expect(r, `replay has a count for ${live.productId}`).toBeDefined();
    expect(r!.quantity, `replay quantity for ${live.productId}`).toBe(live.quantity);
    expect(new Set(live.scanEventIds), `replay scanEventIds for ${live.productId}`).toEqual(new Set(r!.scanEventIds));
  }
}

async function assertRetryIsNoOp(store: Store) {
  const before = JSON.stringify(store.getState().finalCounts.map((c) => ({ p: c.productId, q: c.quantity })).sort((a, b) => a.p.localeCompare(b.p)));
  for (let i = 0; i < 3; i++) await store.getState().syncPending();
  const after = JSON.stringify(store.getState().finalCounts.map((c) => ({ p: c.productId, q: c.quantity })).sort((a, b) => a.p.localeCompare(b.p)));
  expect(after, "N sync retries change nothing").toBe(before);
}

function aiOffStore(): Store {
  const s = createTestScanStore({ db: new MockDb() });
  s.getState().updateSettings({ aiLookupEnabled: false });
  return s;
}

// ---- The paths -----------------------------------------------------------------------------------
describe("Ledger invariant suite (books balance on every path)", () => {
  it("path: KNOWN (verified seed) scan", async () => {
    const store = aiOffStore();
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "kp", businessId: s.businessId, name: "Known", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "ka", businessId: s.businessId, productId: "kp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "ka" }],
    }));
    store.getState().processScan("049000006346");
    store.getState().processScan("049000006346");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: UNKNOWN-first (AI off)", async () => {
    const store = aiOffStore();
    store.getState().processScan("888888888882");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: UNKNOWN-repeat (same code twice, one product)", async () => {
    const store = aiOffStore();
    store.getState().processScan("888888888882");
    store.getState().processScan("888888888882");
    expect(store.getState().finalCounts.length).toBe(1);
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: MISREAD (bad GS1 check digit)", async () => {
    const store = aiOffStore();
    store.getState().processScan("036000291453"); // valid length, bad check digit
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: EXAMPLE / test barcode", async () => {
    const store = aiOffStore();
    store.getState().processScan("4006381333931"); // textbook GS1 example
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: CONFLICT (context-conflict known match still counts provisionally)", async () => {
    // Seed a verified product whose domain conflicts with the tire scan context.
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "cp", businessId: s.businessId, name: "Hot Sauce", brand: "", category: "food", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "ca", businessId: s.businessId, productId: "cp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "ca" }],
    }));
    store.getState().processScan("049000006346");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: CAP-BLOCKED (daily cap genuinely reached today, AI on)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    // createTestScanStore pins now() to 2026-06-12 (scanStore.ts:5160). processScan resets dailyCount
    // to 0 unless lastResetDate === today's date on THAT clock - so this is the genuine cap-hit-after-
    // usage branch, not the silently-reset default (lastResetDate "1970-01-01" would count as 0 used).
    store.getState().updateSettings({ aiLookupEnabled: true, dailyLookupLimit: 1, dailyLookupCount: 1, lastResetDate: "2026-06-12" });
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: OFFLINE", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setOnline(false);
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: BREAKER-OPEN (emergency stop)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, emergencyStop: true });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().processScan("878106003504");
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: DECODE-IN-FLIGHT then failed (network throws)", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      store.getState().processScan("878106003504");
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"));
    } finally {
      globalThis.fetch = original;
    }
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-RESOLUTION (resolveUnknown create_new)", async () => {
    const store = aiOffStore();
    store.getState().processScan("878106003504");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "878106003504" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "create_new", { applyToCount: true, origin: "human", newProduct: { name: "Resolved" } });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-MARKWRONG (quantity transferred)", async () => {
    const store = aiOffStore();
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "wp", businessId: s.businessId, name: "Wrong", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "wa", businessId: s.businessId, productId: "wp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "wa" }],
    }));
    store.getState().processScan("049000006346");
    store.getState().processScan("049000006346");
    await store.getState().markWrong("wp", { reason: "test" });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });

  it("path: POST-MERGE (two provisionals merged via resolveUnknown)", async () => {
    const store = aiOffStore();
    store.getState().processScan("111111111116");
    store.getState().processScan("222222222229");
    const target = store.getState().products.find((p) => p.primaryBarcode === "111111111116")!;
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "222222222229" && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "link_existing", { applyToCount: true, origin: "human", productId: target.id });
    assertBooksBalance(store);
    await assertRetryIsNoOp(store);
  });
});
```
(Path 13, decode-SUCCESS merge, is covered by Task 4's `mergeUnion.store.test.ts` site-1/site-2 tests, which run the same replay + union invariants through the LIVE decode handlers - together the two files cover all 13 paths.)

- [ ] **Step 2: Run to verify it passes (all fixes already in place)**

Run: `npx vitest run src/stores/ledgerInvariants.store.test.ts`
Expected: PASS (12 tests here; path 13 lives in mergeUnion). If ANY path fails, that is a real ledger defect surfaced by the suite - fix the store (do NOT weaken the assertion). Common expected surfacings and their owner: a cap-blocked/offline/breaker path that fails `assertBooksBalance` means the provisional enqueue or same-fact delta (Task 2) missed that branch; a post-merge failure means the D3 union (Task 4) missed a site.

Note on TDD ordering: this suite is authored AFTER Tasks 2/4/5 land, so it is a green consolidation gate rather than red-first. That is deliberate - the per-defect suites (Tasks 2/4/5) are the red-first TDD; this suite is the invariant net that must never go red again.

- [ ] **Step 3: Full unit-suite regression**

Run: `npm run test`
Expected: PASS - all Vitest suites (2294+ existing + the new ones) green. Note the wall-clock time; confirm the ledger suite alone is well under the 90s budget (`npx vitest run src/stores/ledgerInvariants.store.test.ts` should be a few seconds).

- [ ] **Step 4: Commit**
```bash
git add src/stores/ledgerInvariants.store.test.ts
git commit -m "test(ledger): net-new invariant suite across the scan paths (books balance + replay + retry-safe)"
```

---

## Task 8: Golden fixture code CLASSES (misread / example / vendor / conflict)

**Files:**
- Create: `src/stores/goldenClasses.store.test.ts`

**Interfaces:**
- Consumes: `createTestScanStore`, `MockDb`.
- Produces: identity-outcome assertions per code CLASS (decodeStatus / resolverStatus / provisional identity), NO ledger assertions (those live in Task 7). This satisfies the master-plan line: "add misread/example/vendor/conflict code classes to its fixture set (identity-outcome assertions only)."

**Ground truth:** the existing `src/eval/goldenBaseline.test.ts` is a CORPUS barcode-lookup gate (`lookupByExactBarcode` over `benchmarks/golden/phase1-corpus-golden.json`) - it has no `processScan`/identity-outcome concept and no ledger concept. Extending it in place would conflate corpus lookup with scan-identity outcomes. The correct home for the new classes is a sibling store test that asserts the identity OUTCOME `processScan` produces for each class (all AI-off so it is deterministic + $0). This does not shrink or alter the existing 84-code corpus gate.

- [ ] **Step 1: Write the test**

Create `src/stores/goldenClasses.store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Identity-outcome golden classes (AI OFF, deterministic, $0). Ledger balance is asserted separately
// in ledgerInvariants.store.test.ts; here we lock the IDENTITY each class resolves to. Wrong identity
// is failure; unknown is acceptable (North-star #3).
function aiOff() {
  const s = createTestScanStore({ db: new MockDb() });
  s.getState().updateSettings({ aiLookupEnabled: false });
  return s;
}

describe("golden code classes: identity outcome per class (AI off)", () => {
  it("MISREAD (bad check digit) never mints a verified/known identity - stays provisional/needs_review", () => {
    const store = aiOff();
    store.getState().processScan("036000291453");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "036000291453");
    // It counts (appears + counts) but only as an unverified provisional, never verified.
    expect(prod?.verified ?? false).toBe(false);
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291453");
    expect(review?.status).toBe("open");
  });

  it("EXAMPLE barcode is never a verified identity", () => {
    const store = aiOff();
    store.getState().processScan("4006381333931");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "4006381333931");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("VENDOR label (ASIN/FNSKU shape) is not treated as a GTIN and routes to review", () => {
    const store = aiOff();
    store.getState().processScan("X004DY7YUT");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "X004DY7YUT");
    expect(review, "a vendor-label code opens a review").toBeDefined();
    const prod = store.getState().products.find((p) => p.primaryBarcode === "X004DY7YUT");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("CONFLICT (context-conflict verified match) does not auto-count against the poisoned product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "xp", businessId: s.businessId, name: "Hot Sauce", brand: "", category: "food", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "xa", businessId: s.businessId, productId: "xp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "xa" }],
    }));
    store.getState().processScan("049000006346");
    // The poisoned product must NOT be the counted identity; the count lands on a safe provisional.
    const poisonedCount = store.getState().finalCounts.find((c) => c.productId === "xp");
    expect(poisonedCount, "conflict never counts against the poisoned product").toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it passes (identity behavior already exists)**

Run: `npx vitest run src/stores/goldenClasses.store.test.ts`
Expected: PASS. These lock EXISTING identity behavior (the resolver/firewall already route these classes correctly). If any fails, it reveals a real identity regression from Tasks 2/5 - fix the store, never weaken the class assertion.

- [ ] **Step 3: Confirm the existing corpus golden gate is untouched**

Run: `npm run test:golden`
Expected: PASS (the 84-code corpus gate unchanged).

- [ ] **Step 4: Commit**
```bash
git add src/stores/goldenClasses.store.test.ts
git commit -m "test(golden): identity-outcome golden classes (misread/example/vendor/conflict)"
```

---

## Task 9: Playwright ledger proof - markWrong keeps total constant (desktop + phone, store AND DOM)

**Files:**
- Create: `e2e/ledger-markwrong.spec.ts`

**Interfaces:**
- Consumes: the e2e `test` fixture from `./fixtures` (seeds `scanContext: "any"`), `page.route` mock of `/api/ai-lookup`, testids `scanner-input`, `final-count-body`, `login-button`, `count-row-${productId}` (FinalCountTable.tsx:240), `qty-${productId}` (the quantity cell, FinalCountTable.tsx:241), and the `window.__scanStore` handle.
- Produces: a browser proof that markWrong keeps the summed session quantity constant, asserted BOTH in the store and in the rendered final-count DOM, on desktop and at a 390px phone viewport, with screenshots in `e2e/proof/`.

**Ground truth (verified 2026-07-19 - these are facts, not contingencies):**
- The store handle ALREADY EXISTS: `src/stores/scanStore.ts:5147-5152` exposes `window.__scanStore = useScanStore` whenever `NODE_ENV !== "production"` (comment: test/dev only, inert in prod builds). The Playwright webServer runs the dev server, so the handle is present in every e2e run. No new exposure code is needed or allowed.
- Precedent for driving store actions from a spec via this handle: `e2e/batch-approve.spec.ts:119-126` (reads `needsReviewQueue` through `page.evaluate` with a typed `Store` cast) and `:156-163` (CALLS `batchApprove` through the handle); also `scripts/scan-matrix.mjs:51`. Copy that exact pattern.
- The "Mark wrong" button (`mark-wrong-${product.id}`, FinalCountTable.tsx:343) is hidden behind `SHOW_ADVANCED_ACTIONS = false` (FinalCountTable.tsx:172; `FinalCountTable.test.tsx:75` asserts it is absent in the default UI). Driving `markWrong` through the store handle is the ratified mechanism: same precedented pattern as batch-approve, and flipping a deliberately-off flag for a test would prove a path no real user reaches.
- DOM assertion targets: `final-count-body` (FinalCountTable.tsx:127); rows are `count-row-${product.id}` (:240); the quantity cell is `qty-${product.id}` (:241).

- [ ] **Step 1: Sanity-check the harness**

Run: `npx playwright test e2e/count-always.spec.ts`
Expected: PASS (the e2e fixture + dev webServer work; `final-count-body` renders counted rows).

- [ ] **Step 2: Write the spec**

Create `e2e/ledger-markwrong.spec.ts`:
```ts
import { test, expect, type Page } from "./fixtures";

const AI_OFF = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

// Total counted quantity via the dev/test store handle (scanStore.ts:5147-5152; same pattern as
// e2e/batch-approve.spec.ts:144-149).
async function totalCounted(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Store = { getState: () => { finalCounts: Array<{ quantity: number }> } };
    const w = window as unknown as { __scanStore: Store };
    return w.__scanStore.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
  });
}

for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`markWrong keeps total counted quantity constant (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.route("**/api/ai-lookup", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: AI_OFF });
      return route.fulfill({ json: {} });
    });
    await page.goto("/login");
    await page.getByTestId("login-button").click();
    await page.waitForURL("**/scan");
    await expect(page.getByTestId("scanner-input")).toBeFocused();

    // Scan the same unknown code twice -> one provisional row, quantity 2.
    await scan(page, "049000006346");
    await scan(page, "049000006346");
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);

    const before = await totalCounted(page);
    expect(before).toBeGreaterThanOrEqual(2);
    const wrongId = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts[0].productId;
    });

    // Drive markWrong through the store handle (the UI button is behind SHOW_ADVANCED_ACTIONS=false,
    // FinalCountTable.tsx:172; the handle is the precedented e2e mechanism - batch-approve.spec.ts:156-163).
    await page.evaluate(async (id: string) => {
      type Store = { getState: () => { markWrong: (pid: string, o?: { reason?: string }) => Promise<string | null> } };
      const w = window as unknown as { __scanStore: Store };
      await w.__scanStore.getState().markWrong(id, { reason: "e2e ledger proof" });
    }, wrongId);

    // STORE assertion: total physical quantity is invariant across markWrong.
    await expect.poll(() => totalCounted(page), { message: "total physical quantity invariant" }).toBe(before);

    // DOM assertions: the transfer is RENDERED, not just stored. Exactly one counted row remains (the
    // Unidentified provisional), the wrong product's row is gone, and the qty cell shows the full 2.
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    await expect(page.getByTestId(`count-row-${wrongId}`)).toHaveCount(0);
    const provisionalId = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts[0]?.productId ?? "";
    });
    expect(provisionalId).not.toBe("");
    await expect(page.getByTestId(`qty-${provisionalId}`)).toHaveText(/2/);

    await page.screenshot({ path: `e2e/proof/ledger-markwrong-${vp.name}.png`, fullPage: true });
  });
}
```

- [ ] **Step 3: Run the spec**

Run: `npx playwright test e2e/ledger-markwrong.spec.ts`
Expected: PASS (both viewports), screenshots written to `e2e/proof/ledger-markwrong-desktop.png` and `e2e/proof/ledger-markwrong-phone.png`.

- [ ] **Step 4: Commit**
```bash
git add e2e/ledger-markwrong.spec.ts
git commit -m "test(e2e): ledger markWrong keeps total quantity constant, store + DOM (desktop + 390px phone)"
```

---

## Task 10: CI wiring + full-gates run

**Files:**
- Modify: `package.json` (add `test:ledger` script; ensure the ledger + golden-classes suites are in the gate)

**Interfaces:**
- Produces: a named `test:ledger` script for targeted CI/local runs. The suites are already picked up by `vitest run` (they match the `dom` project `include` glob `src/stores/**/*.test.ts` and the `unit` glob `src/services/**/*.test.ts` / `src/server/**/*.test.ts`), so `npm run test` and `npm run proof:full` already gate them.

- [ ] **Step 1: Add the named script**

In `package.json` `scripts`, add after `"test:corpus-drift": ...`:
```json
    "test:ledger": "vitest run src/stores/ledgerInvariants.store.test.ts src/stores/unknownEnqueue.store.test.ts src/stores/mergeUnion.store.test.ts src/stores/markWrongTransfer.store.test.ts src/stores/provenanceTier.store.test.ts src/stores/goldenClasses.store.test.ts src/services/inventory.replay.test.ts src/server/upc/ladderTimeout.test.ts",
```

- [ ] **Step 2: Run the ledger gate + confirm the $0 / <90s budget**

Run: `npm run test:ledger`
Expected: PASS, all suites, in well under 90s, no network calls (all AI-off or fetch-mocked; nothing in these suites reaches a live provider).

- [ ] **Step 3: Full gate sweep**

Run each and confirm:
```bash
npx tsc --noEmit
npm run lint
npm run test
```
Expected: typecheck clean; lint clean; full Vitest green (2294+ existing + new). Fix any lint/type issue inline (e.g. an unused import), re-run, do not suppress with disables.

- [ ] **Step 4: Playwright regression sweep (the visible-behavior locks)**

Run: `npx playwright test e2e/count-always.spec.ts e2e/ledger-markwrong.spec.ts e2e/scan.spec.ts`
Expected: PASS. `count-always` proves "scan N = count N" still holds (North-star #1); `ledger-markwrong` proves the D2 invariant in the browser (store + DOM); `scan.spec` is the core scan flow.

- [ ] **Step 5: Commit**
```bash
git add package.json
git commit -m "chore(ci): add test:ledger gate script (ledger suite + replay + timeout, $0 <90s)"
```

- [ ] **Step 6: Final verification report**

Confirm the branch state and that nothing was pushed:
```bash
git log --oneline feat/decode-ladder-goupc..feat/phase1-ledger
git status
git branch --show-current
```
Expected: the Phase-1 commits listed, on `feat/phase1-ledger`, NOT pushed. Report the commit list + the full-gate results to the owner for review before any merge/push (owner gate).

---

## Self-Review

**1. Spec coverage (against master-plan Phase 1):**
- D1 (quantityDelta:0 + fake synced + never enqueued) -> Task 2 (enqueue + same-fact delta + drop `synced`; `applyDecodeFallback` + context-conflict inherit via `ensureProvisionalCount`). Done.
- `provenanceTier` from birth -> Task 2 (type + first mint) + Task 3 (remaining two mint sites + static lock). Done.
- D3 (merge unions) -> Task 4, ALL THREE live sites via one shared `transferOrphanCount` helper, each branch test-driven. Done.
- D2 (markWrong transfer + example-gate lock) -> Task 5, with the `ensureProvisionalCount` guard ordering constraint (:2932-2939) called out and the transfer carried by real repointed events so replay holds. Done.
- D7 (per-rung AbortController + wall-clock ceiling, fake timers, late-resolve guard; honest scope: the ladder never waits, the abandoned fetch may outlive it) -> Task 6. Done.
- Net-new ledger invariant suite across all 13 paths (sum deltas === quantity; replay reproduces quantity + scanEventIds; retry no-op) -> Task 7 (12 paths) + Task 4's two live-merge paths (path 13, decode-success merges). Done.
- Golden fixture misread/example/vendor/conflict CLASSES (identity-outcome only) -> Task 8. Done.
- Playwright ledger spec, desktop + 390px phone, store AND rendered DOM -> Task 9. Done.
- CI + $0 + <90s + existing suites green -> Task 10. Done.
- Acceptance criteria 1-5: (1) invariant suite green on every path incl. replay -> Tasks 4+7; (2) markWrong keeps total constant, both viewports, example-gate locked -> Tasks 5+9; (3) no path leaves an event unenqueued or falsely synced -> Task 2; (4) provider that never resolves aborted at its rung timeout (abort spy), total decode wall-clock bounded under fake timers -> Task 6; (5) ledger suite + golden fixtures in CI, $0, <90s, existing green -> Task 10. Done.
- Not-in-scope respected: no Firestore/auth/UI-redesign; no D5/D6 logic. Done.

**2. Placeholder scan:** No "TBD", "implement later", or "add error handling" placeholders. Every implementation step quotes the REAL current code at the site (verified against the live repo 2026-07-19) and shows the complete replacement - no elided bodies inside old-code quotes (Task 2's restructure into Edits A-E exists precisely to guarantee exact-match edits; the former `/* ...unchanged... */` old-string is gone).

**3. Type consistency:** `replayLedgerCounts(events, sessionId)` used identically in Tasks 1/4/5/7. `ProvenanceTier` declared in Task 2 (same commit as its first use - `npx tsc --noEmit` is green at every commit boundary); Task 3 only adds stamps + tests. `transferOrphanCount(finalCounts, oid, targetId, nowIso)` named identically in Task 4's helper, all three site replacements, and the File Structure. `resolveUnknown`'s link payload key is `productId` (scanStore.ts:603) - used consistently in Tasks 4/7. `markWrong` returns `Promise<string | null>` (matches types + FinalCountTable usage). `LadderRung.run` new signature `(ctx: RunLadderContext) => Promise<RungOutcome>` used consistently in Task 6's tests and impl. `IncrementPayload`, `makeQueueItem`, `enqueueAndSync`, `buildIdempotencyKey`, `incrementInventoryCount`, `InventoryCount` are all confirmed imported/in-scope in scanStore.ts.
