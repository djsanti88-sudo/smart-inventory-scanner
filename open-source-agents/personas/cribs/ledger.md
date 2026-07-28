# Ledger / Count-Law Crib (Scanbin)

## TOP-LEVEL LAW
Every scanned code (known, unknown, misread, rejected) MUST appear on `scanFeed` AND count.
Scan 10 = count 10, no exceptions. Decode/AI/firewalls only decide IDENTITY, never whether a row
appears or counts. `ensureProvisionalCount(cleanCode, reason)` in `stores/scanStore.ts` runs
SYNCHRONOUSLY, BEFORE any decode/AI/network call, inside `processScan`. That ordering IS the
enforcement — there is no separate named guard function. Grep for `ensureProvisionalCount` call
sites, not a "law checker."

## Core ledger primitives (`src/services/inventory.ts`)
- `createInventoryCount(params)` — zero-quantity count row: `scanEventIds: []`,
  `appliedIdempotencyKeys: []`, `aliasesSeen: []`, `syncStatus: "pending"`.
- `applyScanEventOnce(count, event)` — THE no-double-count invariant. If `event.id` is already in
  `count.scanEventIds`, returns `{ count, applied: false }` UNCHANGED. Otherwise adds
  `event.quantityDelta ?? 1` to quantity, appends `event.id` to `scanEventIds`, appends
  `event.idempotencyKey` to `appliedIdempotencyKeys` (if not already present). Replaying the same
  ScanEvent any number of times must be a no-op after the first apply.
- `incrementInventoryCount(counts, event, makeId)` — find-or-create the `(productId, sessionId)`
  row, delegate to `applyScanEventOnce`. Pure; returns a new array, never mutates.
- `inventory.replay.ts` → `replayLedgerCounts` rebuilds counts FROM `scanFeed` for proofs — the
  source of truth to compare a live count table against.

## Idempotency key lifecycle (`src/services/idempotency.ts`)
- `buildIdempotencyKey(businessId, sessionId, scanEventId, operation)` → deterministic string
  `businessId:sessionId:scanEventId:operation`. Same inputs always produce the same key.
- Minted ONCE per ScanEvent at scan/resolution time (e.g. `INCREMENT_COUNT` at scanStore.ts:3764
  via `countedEvent.idempotencyKey = buildIdempotencyKey(...)`). NEVER regenerated inside a retry
  loop — that would defeat dedupe and allow double-counting.
- Sync is upsert-by-id; `InventoryCount.scanEventIds` is the dedupe ledger, and
  `appliedIdempotencyKeys` is the parallel key-level record. Any number of retries must never
  double-count.

## markWrong = transfer, never delete (`scanStore.ts` ~line 5689-5783)
Marking a counted row wrong does NOT destroy quantity. Sequence: (1) remove the wrong count row,
(2) mint a fresh provisional via `ensureProvisionalCount(code, reason)` for re-identification, (3)
repoint the ScanEvents that had counted the wrong product onto the new provisional. Total
counted quantity across the session is conserved — it moves from one row to another, it never
vanishes and never doubles.

## deleteProduct = transfer to "Unidentified item" (`deleteProductsInternal`, scanStore.ts:6196)
Shared engine for `deleteProduct` + `purgePoisonedProducts`. For every deleted product carrying
counted quantity (`qty > 0`), mints an "Unidentified item" provisional product (same shape as
`ensureProvisionalCount`'s mint: `provisional: true`, `provenanceTier: "provisional"`) and
REPOINTS the count rows onto it — ids/sessionIds/scanEventIds untouched, so Undo's upsert-by-id
restores exactly. Root-cause comment on this function names the historical bug class directly:
"feed-124/counts-122" (deleting an identity silently dropped counted quantity). Zero-quantity
deleted products mint no ghost row.

## transferOrphanCount (scanStore.ts:925) — the merge-transfer primitive
`transferOrphanCount(finalCounts, oid, targetId, nowIso)`: filters out all rows for orphan
productId `oid`; for each orphan row with `quantity > 0`, finds/creates a target row matching
`(targetId, orphanRow.sessionId)` — SESSION-SCOPED on purpose (a prior productId-only match could
pour one session's quantity onto a different session's row, deflating the visible total — exactly
the feed-124/counts-122 class). On merge it unions `scanEventIds`, `aliasesSeen`,
`appliedIdempotencyKeys` via `Set`, and sums `quantity`. `targetId === null` drops the orphan
rows (matches historical call-site behavior).

## Merge rules (identity merge, `services/catalog/identityMerge.ts`)
Size-aware: sizes live in product `specs` fields (corpus names are slugs), so same-model
DIFFERENT-SIZE decodes mint DISTINCT products rather than merging. A resolveUnknown merge unions
scanEventIds and idempotency keys (never drops them) and preserves total quantity.

## Known historical defect classes (do not reintroduce)
- **feed-124/counts-122 divergence**: scan feed count and the finalCounts sum disagreeing after a
  delete/merge because the transfer wasn't session-scoped or wasn't applied at all.
- **quantityDelta: 0 gap**: a ScanEvent recorded with `quantityDelta: 0` for a "should count" path,
  silently under-counting.
- **Refresh wipes**: localStorage/session rehydration losing scanFeed/finalCounts/pendingSyncQueue
  state across a reload — persist AFTER user feedback, never require a round trip to see a scan.

## Test coverage (crown suite, `npm run test:ledger`)
Runs: `ledgerInvariants.store.test.ts`, `unknownEnqueue.store.test.ts`, `mergeUnion.store.test.ts`,
`markWrongTransfer.store.test.ts`, `provenanceTier.store.test.ts`, `goldenClasses.store.test.ts`,
`inventory.replay.test.ts`, `ladderTimeout.test.ts`. `ledgerInvariants.store.test.ts` covers paths:
KNOWN, UNKNOWN-first, UNKNOWN-repeat, MISREAD, EXAMPLE, CONFLICT, CAP-BLOCKED, OFFLINE,
BREAKER-OPEN, DECODE-IN-FLIGHT-then-failed, POST-RESOLUTION, POST-DELETE, POST-MARKWRONG,
POST-MERGE, RETRY-IDEMPOTENCY, and cross-auto-session-boundary rollover — "books balance on every
path" is the suite's own framing.
