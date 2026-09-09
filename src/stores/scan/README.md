# Scan store slices

The pieces of the scan store. `src/stores/scanStore.ts` assembles them; nothing else should import
from this folder directly.

**Shared (client state).**

## What is here

| Path | What it does |
|---|---|
| `scanSlice.ts` | `processScan`, `ensureProvisionalCount`, `setLocation`. Where a scan becomes a counted row |
| `decodeSlice.ts` | The decode actions and the AI status/kill-switch readout. Attaches identity only |
| `reviewSlice.ts` | Needs Review: approve, correct, reassign, unlink, and the universal import apply |
| `catalogSlice.ts` | Catalog lookups, product edits, identifier backfill |
| `sessionSlice.ts` | Start / finish / reopen / lock a counting session |
| `internals.ts` | `enqueueAndSync`, `emitAudit`, and the review-decision write helpers |
| `syncInternals.ts` | Cloud drain and the physical-product dedupe maps |
| `persistShape.ts` | The persisted-state shape guard and migration |
| `productDelete.ts` | Deleting a product while preserving its counts on a ghost row |
| `decodeGates.ts`, `decodePacer.ts` | Whether a decode may run, and how fast |
| `aliasBuilders.ts`, `placeholders.ts`, `queueItem.ts`, `reviewHelpers.ts`, `adoption.ts` | Small pure helpers |

## Before you change anything

**A slice is a factory, not an object.** Each `create*Slice(ctx)` is called once per store instance
from `buildScanInitializer`, so any private state it closes over is per-instance. Never hoist a slice
to module scope or make it a singleton - two stores would then share one Map, and one tenant's probes
would leak into another's.

**Anything mutable passed through `ctx` must be passed as a reference or a getter, never by value.**
`trustedExactProbeGeneration` lives in `scanStore.ts` as a `let` and is exposed as
`getTrustedExactProbeGeneration()` for exactly this reason: capturing the number would freeze probe
invalidation, and both the compiler and the whole test suite would stay silent about it. The probe
Maps and Sets are passed by reference and mutated in place - do not copy or spread them.

**Every slice declares an explicit `Pick<ScanState, ...>` return type.** That is the compile-time
proof the store's public surface did not change. Do not let it be inferred.

**Counting order is the rule, and there is no guard function.** `ensureProvisionalCount` runs before
any decode or network work, which is what makes "scan 10 = count 10" true. Adding an `await`, a
tick, or an early return ahead of it breaks the TOP-LEVEL LAW without failing an obvious test. Run
`npm run test:ledger` after touching `scanSlice.ts`.

**`ensureProvisionalCount` returns the minted product id and `markWrong` depends on it** to move a
count to the right product. That return value is the seam of a fixed double-count bug; keep it.

## Where the routes are

None. This is client state. Pages and API endpoints live under `src/app/`.
