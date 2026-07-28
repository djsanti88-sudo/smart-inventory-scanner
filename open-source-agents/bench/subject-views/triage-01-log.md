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

