# Task 6 Report: D7 - per-rung AbortController timeout + total wall-clock ceiling

**NOTE:** This report file previously held a stale report from an older, unrelated plan (a
"reconcile report service" task). It has been completely overwritten with this task's actual report.

## Status: DONE

## What this closes
Defect D7: `runLadder`'s deadline check only gated rung STARTS - once a rung started, `await r.run()`
was unbounded and could hang 25s+ (the owner-reported 36-70s decode hangs). After this change, a
started rung is raced against an `AbortController` whose timeout fires at
`min(perRungTimeoutMs, remaining wall-clock to deadlineAt)`. A rung that exceeds its budget is
abandoned: the ladder records an honest `aborted: ...` reason and moves on (or settles best-so-far).
Total wall-clock is bounded by the existing `deadlineAt`. A rung that resolves AFTER the ladder has
already returned cannot mutate the returned `reasons`/`settledBy` - the race's loser is simply never
awaited again (proved by the LATE-RESOLVE GUARD test).

**Honest scope preserved as worded in the brief:** the ladder stops WAITING at the timeout. The
abandoned rung's underlying network call may keep running server-side until its own provider-level
timeout - threading the abort signal into every provider's fetch (Go-UPC / Fetch V2 / GPT / UPCitemdb
/ Open Food Facts) is an explicit deferred follow-up, not part of this task.

## Files changed
- `src/server/upc/ladder.ts` - `LadderRung.run` now takes `(ctx: RunLadderContext) => Promise<RungOutcome>`
  where `RunLadderContext = { signal: AbortSignal }`; `RunLadderOpts` gains `perRungTimeoutMs?: number`;
  `runLadder` races each rung against a budget-driven `AbortController` + `setTimeout`, with
  `clearTimeout` in a `finally` on every path (no dangling timers).
- `src/server/upc/ladder.test.ts` - updated the one stale comment on the existing L2 deadline test
  ("A rung already in flight is NEVER aborted mid-run") to explain why that test's synchronous
  `slowRung` still passes under the new race (it settles in real time well inside its 40s budget).
  No assertions were changed.
- `src/server/decode/pipeline.ts` - all three `runLadder` call sites (free rungs :1127, Go-UPC-only
  escalation :1250, full paid ladder :1266) now pass
  `perRungTimeoutMs: intEnv(process.env.DECODE_LADDER_RUNG_MS, 8000)` alongside the existing
  `deadlineAt: ladderDeadlineAt`.
- `src/server/upc/ladderTimeout.test.ts` (new) - the 4-test D7 suite from the brief, verbatim.

## Ground-truth anchor verification
Before editing, every anchor quoted in the brief was checked against the live file and matched
exactly:
- `ladder.ts:60-75` `runLadder` body - exact match.
- `ladder.test.ts:173-195` L2 deadline test with the "NEVER aborted" comment - exact match.
- `pipeline.ts:20` `intEnv` already imported - confirmed.
- `pipeline.ts:435` `ladderDeadlineAt = decodeStartedAt + max(DECODE_LADDER_TOTAL_MS, budgetMs)` - confirmed.
- `pipeline.ts:1127, :1250, :1266` all three `{ deadlineAt: ladderDeadlineAt }` call sites - confirmed
  exact match, no drift from prior tasks.

No mismatches found; no NEEDS_CONTEXT stop was needed.

## TDD sequence (proof)
1. Wrote `src/server/upc/ladderTimeout.test.ts` verbatim from the brief.
2. Ran `npx vitest run src/server/upc/ladderTimeout.test.ts` before implementing:
   **3 of 4 failed as predicted** - `TypeError: Cannot destructure property 'signal' of 'undefined'`
   on the two tests whose rungs destructure `{ signal }` (no ctx arg existed yet), and the
   LATE-RESOLVE GUARD test hit vitest's 30s test timeout (the hang rung never rejected, ladder
   promise never resolved) - exactly the failure mode the brief described.
3. Implemented the `ladder.ts` changes and the three `pipeline.ts` call-site changes per the brief's
   Step 3, verbatim.
4. Re-ran the focused suite - all green (below).

## Terminal Proof

Command: `npx vitest run src/server/upc/ladderTimeout.test.ts src/server/upc/ladder.test.ts`
Result: `Test Files 2 passed (2)` / `Tests 23 passed (23)` - 168ms total (fake timers, no real waits)
Exit code: 0

Command: `npx tsc --noEmit`
Result: no output (clean)
Exit code: 0

Command: `npm run test` (full suite, once, before commit)
Result: `Test Files 250 passed | 8 skipped (258)` / `Tests 2503 passed | 32 skipped (2535)` - 22.57s
Exit code: 0

## Self-review checklist
- Timers cleaned up in all paths: `clearTimeout(timer)` runs in a `finally` block covering both the
  success and the catch (timeout/throw) branches - no dangling `setTimeout` keeping the process alive.
- Late-resolve guard genuinely proves post-return immunity: the guard test lets the ladder return
  first (`await p`), snapshots `reasons`/`settledBy`, THEN resolves the abandoned rung's promise with
  a hijack payload, then asserts the snapshot is unchanged. This passes because `runLadder` never
  re-awaits or re-references the loser of `Promise.race` after the race settles.
- Existing `ladder.test.ts` suite: all 19 pre-existing tests still pass unmodified in assertions; only
  one stale comment was updated per the brief's explicit instruction ("that test's synchronous slow
  rung still passes under the new code... only its comment may need updating").
- No em dash or en dash introduced in any new/edited string or comment (verified by inspection of the
  full diff).
- `ladder.ts` stays framework-free and env-free - the only env read (`DECODE_LADDER_RUNG_MS`) lives in
  `pipeline.ts` via the existing `intEnv` helper, exactly as required.
- Rung runners in `pipeline.ts` (`runUpcItemDb`, `runOpenFoodFacts`, `runGoUpc`, `runFetchV2`,
  `runGpt`) are all `async (): Promise<RungOutcome>` closures taking no args; TypeScript's structural
  typing permits assigning them to `(ctx: RunLadderContext) => Promise<RungOutcome>` (fewer params is
  allowed), which is why `tsc --noEmit` passed with zero changes needed to those closures - confirmed
  by reading pipeline.ts:884, :920, :955, :1012, :1091.
- No unhandled rejection warnings observed when running the new timeout suite (loser promises from
  `Promise.race` that later reject are simply never referenced again).

## Proof Type
- Automated proof: yes (unit tests, fake timers, `npx tsc --noEmit`, full `npm run test`).
- Mocked proof: N/A (no external providers touched in this task; rungs in tests are pure in-memory
  fakes).
- Live proof: none required/attempted (no paid API calls in scope).
- Manual proof: none required for this task (pure server-side logic + tests).
- Untested limitations: the abandoned rung's real provider fetch (Go-UPC/Fetch V2/GPT/UPCitemdb/Open
  Food Facts) does not yet receive the abort signal - it can keep running server-side after the ladder
  moves on. This is the explicitly deferred follow-up named in the brief and in the code's doc
  comments, not a gap in this task's acceptance criteria.

## Git status
- Branch: `feat/phase1-ledger`.
- Commit: `754d6c5` - "fix(decode): D7 - per-rung AbortController timeout + wall-clock ceiling (ladder
  never waits on an in-flight rung)".
- Staged/committed explicitly: `src/server/upc/ladder.ts`, `src/server/upc/ladderTimeout.test.ts`,
  `src/server/decode/pipeline.ts`, `src/server/upc/ladder.test.ts` only.
- Left untouched (pre-existing unrelated stale modifications, per instruction not to sweep them in):
  `.claude/settings.local.json`, `.superpowers/sdd/task-3-report.md`. This file
  (`task-6-report.md`) was rewritten and will be staged separately by the caller/owner if desired.
- Not pushed (local commit only, per instruction).

## Next recommended step
Thread the `AbortSignal` into the actual provider fetch calls inside `runGoUpc` / `runFetchV2` /
`runGpt` / `runUpcItemDb` / `runOpenFoodFacts` in `pipeline.ts` (and wherever they call `fetch`
downstream) so an abandoned rung's real network request is cancelled server-side too, not just
un-awaited. This was explicitly named as a deferred follow-up in the brief and is not required for
D7's acceptance criteria.
