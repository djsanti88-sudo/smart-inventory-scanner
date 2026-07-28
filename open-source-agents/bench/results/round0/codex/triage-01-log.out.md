# Diagnosis

The failure is a real queue-concurrency defect in the cloud drain, not a memory-limit or Vitest-worker problem. The regression deliberately overlaps two drain calls with an enqueue that occurs while asynchronous persistence is in flight. Only seven of eight operation IDs reach the mock database, which means the drain is using stale queue/snapshot state: it either clears/replaces the queue after awaiting and drops the newly enqueued item, or finishes without scheduling another pass to consume work added during the active drain. Concurrent drains make that stale commit window larger.

The `MaxListenersExceededWarning` and 612 MB heap report are incidental. They do not explain a deterministic, domain-specific 7-versus-8 assertion, and increasing heap size, worker count, timeouts, or listener limits would only hide signals rather than fix the lost operation.

# Correct next action

Run this regression test alone to preserve the schedule and inspect the queue state before snapshot, after each await, and at drain completion. Fix the drain as a single-flight, idempotent loop:

- claim/snapshot pending operation IDs once;
- after I/O, remove only the successfully applied IDs from the **current** queue with a functional state update, never replace it with a stale post-await array;
- leave failures pending;
- if anything was enqueued during the flight, loop or schedule another drain before releasing the single-flight guard;
- have concurrent callers join the same in-flight drain.

Then keep this regression test, add assertions that all eight IDs are applied exactly once and the pending queue is empty, and run the focused store tests followed by the full suite. Do not mark the test flaky or weaken the expected count.
