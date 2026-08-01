# Universal Hybrid Identity Final Fix Report

Date: 2026-08-01 (America/Chicago)

Status: **DONE**

Assigned worktree: `C:\tmp\inventory-local-tire-demo`

Starting HEAD: `19613190e5f48c68ebc87f1f9c3015c08f435a51`

Final implementation HEAD before this report: `538327f8`

No E2E/Playwright, live/provider API, production data, deploy, push, or real-data operation was run. The pre-existing untracked `decode-outcomes/` directory was preserved and never staged.

## Commits

- `a6581c56` — `fix: make identity route exports legal`
- `ea9b7736` — `fix: close identity final review gaps`
- `538327f8` — `fix: omit absent review context from fingerprints`

## Finding closure

### 1. Next.js route export legality

RED: the preview route module exposed four non-route exports (`MAX_LOCAL_PREVIEW_REQUEST_BYTES`, `createIdentityPreviewRoute`, `isLocalIdentityPreviewEnabled`, and `loadLocalPreviewSigningKey`).

GREEN: preview/apply/review implementations and factories moved into `src/server/identity/*Route.ts`; App Router modules now expose only their legal HTTP methods. The route export contract test passes.

### 2. Category/record-type shaping, plugin manifest completeness, and exact candidate evidence

RED:

- Browser shaping omitted both `categoryHint` and `recordType`, so tire hard constraints and explicit service/non-product classification did not receive adapter facts.
- Ranked candidates did not retain the exact identifier family that produced their evidence.
- Review confirmation persisted `decision.normalizedKeys[0]` rather than the selected candidate's exact evidence family.

GREEN:

- Universal import mapping now supports `recordType`, maps `category` into `categoryHint`, and only accepts the explicit safe record-type allowlist (`product`, `labor`, `service`, `fee`, `subtotal`, `header`).
- Preview/apply manifests bind the complete deterministic generic+tire plugin registry.
- Each ranked candidate carries its own exact intersecting identifier family; confirm/revoke/current-link review behavior uses that family and fails closed when it is absent. Product creation uses candidate evidence first and signed row identifiers only when no candidate exists; it no longer reads `normalizedKeys[0]`.

### 3. Preview lookup batching and immutable read snapshot

RED: three concurrent row lookups caused three full tenant-link scans and three tenant-product scans.

GREEN: an authoritative read-model instance now memoizes one immutable promise-backed tenant state per business. Concurrent preview lookups share one link read and one tenant-product read while retaining tenant scope and read-only candidate-source behavior.

### 4. Aggregate-event inventory projection

RED: no projection module existed, and counted aggregate events were durable only in `aggregate-ledger`.

GREEN: `localInventoryProjection.ts` rebuilds `InventoryCount[]` with the existing `replayInventoryEvents` primitive. Aggregate ledger writes/retries and atomic counted-row writes/retries materialize the scoped projection inside the same `AtomicLocalStorage` transaction. Duplicate application remains replay-equivalent and idempotent. The two-process atomic claim/count test also passes.

### 5. Durable signed row context and later physical-count approval

RED:

- Saved reviews contained only decision/scope, not the signed quantity/session/source facts needed to count later.
- A later manager approval never invoked `atomicCountedRow`.

GREEN:

- Unresolved apply rows persist server-bound mode, quantity, unit, source ordinal/sheet/row, import session, stable event time, and scoped identifiers. This context participates in immutable review idempotency hashing without serializing absent optional values.
- A later physical-count confirm/create action constructs a canonical aggregate event and reuses `createLocalAtomicCountedApply` with `identity-review-count:<reviewId>` idempotency. Reconcile reviews remain non-counting. The default production composition permits this path only against the completed matching import run and revalidates the current exact target.

### 6. Frozen 5,000-row benchmark fixture and purity

RED: `frozen-5000.v1.json` was only a compact generation recipe; persisted `rows`, `snapshot`, and `contentSha256` were absent.

GREEN:

- The fixture now persists 5,000 canonical synthetic rows and 2,000 frozen candidate records (4,237,989 bytes).
- Separate source-row, catalog-snapshot, canonical-content, and raw-file SHA-256 bindings are verified.
- A checked-in local-only generator reproduces the fixture.
- The benchmark uses the production read-only candidate source, complete generic+tire plugin registry, poisoned global fetch boundary, sequential post-batch decisions, real signed chunks, and exact bucket/quantity accounting.
- Required standalone evaluator result: warm median `780.8918 ms`; decision p95 `0.0956 ms`; both pass the `10,000 ms` and `2 ms` gates. Browser main-thread proof remains `BLOCKED` because E2E/Playwright was explicitly forbidden.

## Verification

- Final focused identity suite: **10 files, 112 tests passed**.
- Projection/concurrency file suite: **2 files, 11 tests passed**, including the independent Node-process atomic test.
- Review/apply/repository suite after the full-suite-discovered optional-field regression: **3 files, 57 tests passed**.
- Standalone persisted-fixture benchmark: **1 test passed**.
- Benchmark runner: warm median `780.8918 ms`, decision p95 `0.0956 ms`, browser main thread `BLOCKED`.
- TypeScript: `npx.cmd tsc --noEmit --incremental false --pretty false` — **PASS**.
- Focused ESLint on changed implementation/tests/scripts — **0 errors**; one pre-existing `columnIntelligence.ts` unused `tokens` warning remains.
- `git diff --check` — **PASS** before implementation commits.
- Clean committed-tree build: `npx.cmd next build --webpack` from `C:\tmp\identity-final-build-538327f8` — **exit 0**. Next compiled, typechecked, collected page data, generated 31/31 static pages, finalized traces, and emitted `/api/identity/preview`, `/api/identity/apply`, and `/api/identity/reviews`.

The source worktree's `.next/trace` remained locked by an unrelated process, so build proof used a fresh `git archive` of committed HEAD plus the existing local `node_modules` junction. No source or user artifact was deleted or moved.

## Full-suite caveat

The complete unit/DOM invocation reached **4,447 passed, 79 skipped, 4 failed** across 465 files. One failure exposed the new absent-optional review fingerprint bug; it was fixed in `538327f8` and its focused repository/review/apply proof is green. The three remaining full-suite failures are:

- two unrelated date-rollover assertions that still expect month `2026-07` while the current date is `2026-08-01`;
- the identity performance p95 gate when run concurrently with the entire 4,500-test suite (`8.1289 ms`), despite the specified standalone frozen protocol passing at `0.0956 ms`.

These are reported as remaining verification concerns, not hidden as a clean full-suite result. No unrelated test or clock behavior was changed.

## Remaining concerns

- Browser main-thread performance is unverified/blocked by the explicit no-E2E boundary.
- Full-suite month-rollover fixtures should be repaired separately.
- Performance gates should remain isolated according to the frozen benchmark protocol; whole-suite contention is not a stable measurement environment.
- Local build artifacts were left at `C:\tmp\identity-final-build-ea9b7736*` and `C:\tmp\identity-final-build-538327f8*`; they are generated copies only and were not removed because deletion was outside this fix scope.
