# Loop 2 - Decode Section Adversarial Verify + Provider-Misbehavior Hunt (2026-08-13)

Scope: same section as loop 1. Read-only, no edits, no live/paid calls. Verified against
`git diff src/server/decode/pipeline.ts src/services/upc/goUpcThrottle.ts src/server/upc/` (the
uncommitted DC-1/DC-2 money fixes) plus a new lens: hostile/degraded providers.

## Job 1 - Verification verdict table

| fix | verdict | evidence |
|---|---|---|
| DC-1 abandonment leak (AbortSignal into GoUpcGate.run, checked before `fn()`) | **CONFIRMED** | `goUpcThrottle.ts` `run()` now takes `signal?`, checks `allAbandoned` inside the `acquireSlot().then()` callback **before** calling `fn()`, throwing `AbortError` instead. `ctx.signal` is threaded from `runLadder` (`ladder.ts:130/132` always passes `{signal: controller.signal}`) through `runGoUpc(ctx)` -> `GoUpcRungDeps.signal` -> `gate.run(canonical, client, deps.signal)`. Regression test `src/server/upc/goUpcAbandonment.test.ts` ("drops the queued Go-UPC network call...") asserts `client` is never called after the ladder abandons the rung at 100ms even though the gate would otherwise release it at ~15s; reverting the fix (drop the signal param / drop check) makes this test fail because `client` was unconditionally called once the throttle released the queued entry. A second test proves the non-abandoned path is unaffected (`client` still fires once, spacing preserved). |
| DC-2 shared-abort (per-key Set of signals + hasUnsignaled, drop only when every registered signal is aborted, each caller races its own signal) | **CONFIRMED** | `goUpcThrottle.ts` replaced the bare `Map<string, Promise>` with `Map<string, {shared, signals, hasUnsignaled}>`; each `run()` call joins the existing entry's `signals` Set (or sets `hasUnsignaled`) and gets its own wrapped promise via `ownAbortRace`, which races the caller's own signal against `shared` without affecting `shared` itself. `goUpcThrottle.test.ts`'s new "DC-2" describe block has 3 tests: (1) caller A aborts while queued, caller B (never aborts) still resolves and `fn` still ran exactly once - this fails under the pre-fix code because the old `existing` early-return handed B the literal same promise that A's original code path could reject; (2) drop `fn` entirely only when every registered caller has aborted; (3) a caller with no signal at all keeps the call alive even if every signaled caller aborts. All three exercise behavior the pre-fix single-promise dedup could not produce. |
| Charge-arm stickiness (`chargeFailureInArm` generalizes `capDenialInArm` to any non-cap settlement failure) | **CONFIRMED** | `pipeline.ts`'s `chargeOnEgress` now checks `if (chargeFailureInArm) throw chargeFailureInArm;` before the `!paidChargeArmed` no-op return, and the catch around `settlePaidCharge()` sets `chargeFailureInArm` for any non-`DailyCapExceededError`. `withPaidChargeArmed`'s setup resets both `capDenialInArm` and `chargeFailureInArm` to null per arm; the `finally` deliberately does NOT rethrow `chargeFailureInArm` (only logs it as an honest per-rung skip), unlike `capDenialInArm`. Test `pipeline.test.ts` "(e) a non-cap GLOBAL charge failure is STICKY..." mocks `chargeDailySlotConditional` to reject once inside the shared goupc->fetchv2->gpt arm and asserts `fetchV2` (module-mocked) is never called and the daily-used counter stays 0. Pre-fix, `paidChargeArmed` would already be `false` (consumed before the await) after goupc's failed attempt, so fetchv2's own `chargeOnEgress()` would see `!paidChargeArmed` and silently return, letting fetchv2 egress unmetered - this test would fail against that code. |

**No fix was refuted or found to introduce an inverse leak or a wrongly-blocked decode within the reviewed diff:**
- DC-1: the drop only fires when every *registered* caller's signal is aborted; `runLadder` always supplies a real `ctx.signal` (`LadderRung.run` requires it structurally, `runGoUpc(ctx?)`'s optional param is still always called with `{signal}` in production), so the conservative "no signal => never drop" branch only matters for direct test harnesses, not the live route. The drop happens strictly before `fn()` (charge + fetch), so no path exists for a charge with no egress or vice versa - order inside `client` (`await chargeOnEgress(); return goUpcLookup(...)`) is unchanged.
- DC-2: `ownAbortRace` never mutates `shared`; a caller who joins after `fn()` already started can still only affect its own returned promise. The synchronous nature of the `acquireSlot().then()` callback (drop-check and `fn()` call happen in the same microtask) rules out a caller joining in the narrow window between the check and the call.
- Charge stickiness: `chargeFailureInArm` is reset at the top of every new `withPaidChargeArmed` arm and is request-scoped (closure-local, not module-level), so one request's storage hiccup cannot poison a later request. It is intentionally NOT rethrown to the outer handler (unlike the cap case) - each rung it blocks already records its own honest skip reason via existing per-rung catches, so no under-blocking (legitimate decodes are not wrongly hard-failed with a 500) and no under-charging (the alternative, letting the rung proceed, is exactly the bug being fixed).

## Job 2 - Provider misbehavior findings

**DC2-1 (new, Low-Medium, mitigated at a different layer) - a Go-UPC 200 response with no usable
`product` payload is still classified as a confident "hit", not a miss.** `goUpcClient.ts:119-125`:
any 200 body that parses as JSON but lacks a `product` object (e.g. `{}`, `{"error":"..."}`, a
provider bug) yields `{kind:"hit", inferred:false, product:{name:"",brand:"",...}}` because
`toProduct()` defaults every missing field to `""` and `inferred` defaults to `false` when absent.
`GoUpcProvider.ts`'s hit path then treats this as `goupc_exact` -> `verifiedDecision()` (confidence
0.9, "Go-UPC exact barcode match -> verified auto-count candidate") and calls `deps.usage.record()`
(a real paid unit burned for a garbage response). This full-empty case is caught downstream by
`isUsableProductName` (`decode.ts:130`, `name.length < 3` rejects the empty string) in
`scanGates.ts`/`scanStore.ts` before the row can auto-apply, so it degrades to Needs Review rather
than a silently-wrong counted identity - but a *plausible-but-generic* short name would pass that
gate too (only a curated `PLACEHOLDER_NAME`/`REFUSAL_NAME`/`SCRAPE_ERROR_TITLE` regex list screens
it, e.g. "Unknown"/"N/A" are caught, but an arbitrary short garbage string like a provider's default
placeholder SKU code is not). No test in `GoUpcProvider.test.ts` currently asserts on an empty/absent
`product` field in a 200 body (grepped: no case constructs `{ }` or omits `product` entirely while
returning 200).

**DC2-2 (new, Medium, pre-existing but newly relevant under this lens) - a single false 404 permanently
poisons a real code for 30 days.** `GoUpcProvider.ts:291-297`: any `kind:"miss"` (a bare HTTP 404, no
retry, no distinguishing signal from the provider) immediately writes a 30-day negative-cache entry
(`writeMissCache`) that short-circuits every future lookup of that code (`readMissCache` check at
`GoUpcProvider.ts:238-241`, before the spend gate and before the gate/client are ever reached) with
no re-verification path until the TTL expires. `goUpcClient.ts` only routes a non-2xx/non-404/400/401/429
status to `"transient"` (not cached) - but a provider that returns a spurious *404* during an outage,
misconfiguration, or a race in their own DB replication (a real barcode that was momentarily
unindexed) is indistinguishable from a genuine "not in DB" 404 in this code path. This directly
matches "a cache entry that permanently poisons future lookups of that code" from this loop's own
brief: the code does not go to Needs Review with an honest "transient" reason on a false 404 - it is
silently and durably marked as a real miss, and every subsequent scan of that barcode for 30 days
skips Go-UPC entirely (falling through to the more expensive fetchv2/gpt rungs, or Needs Review if
those are also unavailable) with no visible indication that the "miss" was provider flakiness rather
than ground truth. This is an availability/cost-shape defect, not a wrong-identity defect (Resolver
Trust Rules' "wrong identity is worse than unknown" is not violated - a poisoned code degrades to
unknown/escalation, never to a confident wrong answer) but is a real product defect this lens
surfaces that loop 1's ladder-logic-only hunt did not name.

No evidence was found of: a provider response text being usable as a prompt-injection vector into a
later AI call (GPT's prompt is built from `code` alone via `promptFor(code)` in `gptFromScratch.ts` -
no prior free/paid rung's `productName`/`description` is concatenated into any subsequent provider
prompt in the reviewed files); an unhandled circuit-breaker stuck-open state (`circuitBreaker.ts`'s
`canRequest` self-heals via `COOLDOWN_MS` half-open trial, independent of the money-fix diff); or a
retry path that double-charges the daily cap for one logical lookup within the reviewed diff (the
`paidChargeArmed` consume-before-await pattern plus the new stickiness make re-entrant egress inside
one arm structurally impossible; a client-level HTTP retry of `/api/ai-lookup` itself is a distinct,
pre-existing concern outside this diff's scope and was not newly introduced).
