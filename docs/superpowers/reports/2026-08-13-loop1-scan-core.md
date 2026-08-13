# Loop 1 Defect Hunt — scan-core section (2026-08-13)

Scope per `npm run check:section scan-core`: `src/stores/**`, `src/services/inventory.ts`,
`src/services/inventory.replay.ts`, `src/services/resolver.ts`, `src/services/scanCleaner.ts`,
`src/services/aliasMatcher.ts`, `src/services/idempotency.ts`.

Method: read the small pure services in full; grepped `scanStore.ts` (~8,800 lines) for the
named invariant enforcement points (`ensureProvisionalCount`, `markWrong`, `processScan`,
`buildIdempotencyKey` call sites, the decode concurrency queues) rather than reading top to
bottom, per the section brief. `.next/` excluded from all searches.

## Result summary

This section is in genuinely good shape. `services/inventory.ts`, `inventory.replay.ts`,
`resolver.ts`, `scanCleaner.ts`, `aliasMatcher.ts`, and `idempotency.ts` are small, pure, and
each of the stated invariants (dedupe-by-event-id, text-only codes, approved-alias/verified-
product gating, tiered conflict detection, idempotency keys minted once) is directly enforced
in code I read, not just asserted in a comment. `scanStore.ts`'s `processScan`,
`ensureProvisionalCount`, and `markWrong` carry heavy, specific in-line documentation of prior
defect classes (F-02, F-03, D1, Task 9, S6, the 2026-08-05 livelock) and the code visibly
implements the fix each comment describes — this is a file that has absorbed many real audits,
not one that merely claims to. I did not find a defect that breaks the TOP-LEVEL LAW (every
scan appears + counts) or produces a wrong count/identity under a realistic scan sequence.

The one real finding is a structural gap in test isolation for the decode-concurrency queues,
not a user-facing correctness bug — see SC-1.

| id | category | evidence | concrete failure scenario | severity | confidence |
|---|---|---|---|---|---|
| SC-1 | Invariant gap (test isolation) | `src/stores/scanStore.ts:482-505` (`generalDecodeQueue`, `trustedExactDecodeQueue`, `decodeTaskPromises` module-level singletons); test-only partial reset at `scanStore.ts:8772-8790` (`__resetGeneralDecodePacerForTest` only resets the pacer's token bucket, not `queue.active`/`queue.pendingIds`/`decodeTaskPromises`) | The decode queues are declared as module-level singletons shared by *every* `create<ScanState>()` instance (the file's own comment at line 8773 says so: "module-level singleton shared by every store instance"). `createTestScanStore()` (scanStore.ts:8751) creates a fresh Zustand store per test but never touches these singletons. Within one test file that calls `createTestScanStore()` more than once and leaves a `liveDecode()` promise unsettled at the end of an earlier test (e.g. a test that asserts mid-flight state without draining `pending`, or one that throws before its `finally`), `queue.active` and `decodeTaskPromises` entries survive into the next `it()` in the same file, silently reducing the concurrency budget (`MAX_CONCURRENT_DECODES` / `MAX_CONCURRENT_TRUSTED_EXACT_DECODES`) or making a later `liveDecode()` for the same reviewId resolve to a stale, already-settled promise instead of running. This is a test-suite reliability risk (flaky/order-dependent failures), not a production bug — production only ever constructs one store (`useScanStore` at scanStore.ts:8689), so the singleton is safe there. Not currently observed failing; flagged because the shipped test helper (`__resetGeneralDecodePacerForTest`) shows the authors already knew part of this state needed test-scoped reset and only reset the pacer, not `active`/`pendingIds`/`decodeTaskPromises`. | Low (prod) / Medium (CI trust) | Medium — verified by code reading and the module's own doc comment; did not reproduce an actual cross-test failure in the time available. |

## Notes on what was checked and cleared (no defect found)

- `applyScanEventOnce` / `incrementInventoryCount` (`services/inventory.ts`): dedupe-by-`event.id`
  is a hard `Array.includes` gate before any mutation; negative-delta "transfer out" writes used
  by `markWrong` (scanStore.ts:7629-7641) and `deleteProductsInternal` (scanStore.ts:8173,8381)
  are sent only as backend `IncrementPayload`s, never replayed through `applyScanEventOnce`
  locally, so the "always positive local delta" shape this function assumes is never violated.
- `resolveScanToProductTiered` (`aliasMatcher.ts`): the same-tier-conflict-merges-into-overall-
  conflict logic and the `TIER_RESULT_PRIORITY` fallback (`hitsForProduct[0] ?? candidates.find(...)`)
  were checked for an empty-array/`-1`-priority edge case; both are structurally unreachable given
  `pickTier`'s invariant that a "conflict" resolution always carries ≥2 distinct product ids.
- `buildIdempotencyKey(..., idFactory())` call sites (scanStore.ts:7261, 7286, 7576) mint a fresh
  key per distinct human action (unlink alias / move alias / mark wrong), not inside a retry loop —
  consistent with the "idempotency key assigned once, reused on retry" rule. The one call site with
  an explicit comment about retry safety (scanStore.ts:6750, `createdFingerprint`) confirms the key
  is minted once when the queue item is built and every drain/retry replays the same
  `PendingSyncItem` object.
- `ensureProvisionalCount`'s idempotency guard (scanStore.ts:5451-5463) and `markWrong`'s transfer
  accounting (scanStore.ts:7608-7771, the "(d) Feed-trim safety net" residual loop) were traced
  end-to-end for the double-count scenario (retained feed row + persist-trimmed feed row for the
  same wrong product, multiple aliased codes) — the residual-quantity subtraction correctly nets
  out synthetic events already minted by `ensureProvisionalCount`'s own synthetic-backing-event
  path, so total transferred quantity stays invariant.
- `scanCleaner.ts`'s `INVISIBLE` character class was decoded byte-by-byte; it strips C0 controls,
  DEL, zero-width space/joiner/non-joiner, and BOM as intended — no off-by-one or overly broad
  range.
- `vitest.config.ts` exclude list only removes `scripts/**` node:test suites from the `unit`
  project; nothing under `src/stores/**` or the reviewed `src/services/*` files is excluded from
  `npm run test`, so the scan-core tests referenced above do execute under the normal gate (spot-
  checked `deterministicExactQueue.store.test.ts`, which currently passes).

## Untested claim check

Ran `npx vitest run src/stores/deterministicExactQueue.store.test.ts` directly (1 test file, 1
test, passed) to confirm the deterministic-exact-queue concurrency split (4 concurrent
deterministic-only decodes vs 2 ordinary) is a real, executing guard and not a self-skipping
`*.rules.test.ts` file — it is a plain `.store.test.ts` that runs under `npm run test`.
