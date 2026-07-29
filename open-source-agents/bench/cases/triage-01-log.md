# Case: triage-01 (test-failure triage)

## Task prompt (what the subject model sees)
You are triaging a failing test run in the Scanbin inventory project (a Next.js + Zustand + Vitest
codebase). Below is an excerpt of `npx vitest run` output. Identify the TRUE root cause of the
failure, explain why it happened, and recommend the correct next action. Do not just restate the
stack trace - diagnose it.

## Input log (shown to subject)
```
 RUN  v1.6.0 C:/Users/djsan/inventory
      Projects: unit, dom

 ❯ src/stores/cloudDrainRace.store.test.ts (1 test | 1 failed) 812ms
   ❯ cloud drain race (regression) > does not lose ops enqueued while an async drain is in flight
     AssertionError: expected 7 to be 8 // Object.is equality

     - Expected
     + Actual

     - 8
     + 7

      at src/stores/cloudDrainRace.store.test.ts:64:32
      at runTest (node_modules/@vitest/runner/dist/index.js:1146:11)
      at runSuite (node_modules/@vitest/runner/dist/index.js:1297:15)

 ❯ src/services/reconcile/shopwareCsvAdapter.test.ts (14 tests | 14 passed) 340ms
 ❯ src/services/security/identifierPersist.test.ts (6 tests | 6 passed) 210ms
 ❯ src/stores/ledgerInvariants.store.test.ts (8 tests | 8 passed) 1904ms
 ❯ src/services/ai/decode.test.ts (22 tests | 22 passed) 640ms
 ❯ src/components/UniversalImportPanelContainer.test.tsx (11 tests | 11 passed) 980ms
 ❯ src/lib/auth.signup-provision.test.ts (5 tests | 5 passed) 402ms

 Test Files  1 failed | 47 passed (48)
      Tests  1 failed | 349 passed (350)
   Start at  14:22:07
   Duration  38.91s (transform 2.10s, setup 1.44s, collect 9.62s, tests 26.02s)

--- worker pool: threads (poolOptions.threads.maxThreads = 8, minThreads = 4) ---
--- vitest config: test.isolate = true, fileParallelism = true ---

FAIL src/stores/cloudDrainRace.store.test.ts > cloud drain race (regression) > does not lose ops enqueued while an async drain is in flight
AssertionError: expected 7 to be 8
 ❯ src/stores/cloudDrainRace.store.test.ts:64:32
     62|     await Promise.all([drain1, drain2, lateEnqueue]);
     63|     const applied = mockDb.getAppliedOpIds();
     64|     expect(applied.length).toBe(8);
     65|   });

  System.gc information: heap used 612MB / 1024MB limit (workers: 8 active)

  Node.js process warning: MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
  11 close listeners added to [EventTarget]. Use emitter.setMaxListeners() to increase limit
      at process.nextTick (node:internal/process/task_queues:82:21)
      at node:internal/timers:520:9

 ELIFECYCLE  Command failed with exit code 1.
```

## GROUND TRUTH (never shown to subject)

**Root cause:** `cloudDrainRace.store.test.ts` is a KNOWN timing-flaky test. It exercises
`drainCloudOnce`'s promise-chain mutex (the mechanism that ensures overlapping cloud sync drains
never race one Firestore doc - see `docs/ARCHITECTURE.md` section 2 step 5 and
`docs/ARCHITECTURE.md` Trap #14: "`cloudDrainRace.store.test.ts` is timing-flaky only under full
parallel vitest load; it passes in isolation. Do not 'fix' it blind."). The test asserts an exact
count of applied ops (`applied.length === 8`) that depends on real-clock interleaving of two
concurrent drains plus a late enqueue. Under `fileParallelism: true` with 8 worker threads all
competing for CPU (visible in the log: 47 other files running concurrently, heap at 612MB/1024MB,
an EventEmitter listener warning indicating thread/handle pressure), the drain's internal
microtask/timer ordering shifts just enough that one op from the late-enqueue race window is
still in flight when the assertion fires - producing `7` instead of `8`. This is NOT a logic bug in
the mutex; it is a test-environment timing artifact that only appears under parallel load.

**Correct triage output (HIT criteria):**
1. Identifies that the failing test is the specific timing-flaky test documented in
   `docs/ARCHITECTURE.md` (cloudDrainRace / drainCloudOnce mutex), not a newly introduced bug.
2. Explains that the flakiness is caused by parallel vitest execution (worker-thread contention/
   scheduling) affecting real-clock-dependent promise interleaving, not a code regression.
3. Recommends re-running the single file in isolation (e.g. `npx vitest run
   src/stores/cloudDrainRace.store.test.ts` alone, or with `--no-file-parallelism` / reduced
   thread count) to confirm it passes standalone, BEFORE concluding anything is broken.
4. Does NOT recommend deleting, skipping, or weakening the assertion - the doctrine and
   LESSONS_LEARNED L16 explicitly forbid weakening tests to force green.
5. Correctly notes the other 349 tests all passed, so this is an isolated/known flake, not a
   systemic failure.

**Red-herring traps deliberately planted in the log (a shallow or wrong-diagnosis response will
seize on one of these):**
- Trap A - `MaxListenersExceededWarning: Possible EventEmitter memory leak detected`: looks like a
  real leak to chase down; it is just noise from many parallel worker threads registering
  listeners, not the actual root cause of the assertion failure.
- Trap B - `System.gc information: heap used 612MB / 1024MB limit`: looks like a memory-pressure/
  OOM problem worth "fixing" (e.g. by reducing test data size); it is a symptom of running the full
  47-file parallel suite, not a defect in this test or in production code.
- Trap C (structural) - the assertion `expected 7 to be 8` is adjacent to real production files
  (`shopwareCsvAdapter.test.ts`, `identifierPersist.test.ts`, `ledgerInvariants.store.test.ts`) all
  passing; a shallow read might assume the ledger invariant suite itself is implicated (it is not -
  it passed cleanly) or that this is a genuine double-count/lost-scan ledger bug requiring a
  `services/inventory.ts` fix, when it is purely a test-timing artifact isolated to one test file.

**Scoring:** HIT = names the timing-flakiness-under-parallel-load root cause AND recommends an
isolated rerun as the next step, without proposing to weaken/delete the test. FALSE POSITIVE = the
response chases Trap A or Trap B as the root cause, or proposes changing ledger/mutex production
code, or proposes weakening the assertion to `toBeGreaterThanOrEqual(7)` (or similar) to force
green.
