# Test Triage: triage-01-log

## Failure Summary
- **Failing Test File:** `src/stores/cloudDrainRace.store.test.ts`
- **Failing Suite/Test:** `cloud drain race (regression) > does not lose ops enqueued while an async drain is in flight`
- **Assertion Failure:** `AssertionError: expected 7 to be 8` at line 64:32 (`expect(applied.length).toBe(8)`).

---

## True Root Cause
A race condition / state synchronization defect exists in the store's cloud queue draining logic (`syncPending` / `drainQueue`) during concurrent async drain calls.

Specifically:
1. An async cloud drain operation (`drain1`) is initiated.
2. While `drain1` is in flight, a new operation (`lateEnqueue`) is added to the pending queue, and a concurrent drain (`drain2`) is triggered.
3. The queue draining mechanism fails to re-read or preserve operations enqueued while an active drain is in flight—either because `drain1` clears the pending queue upon completion using a stale snapshot, or `drain2` fails to process items enqueued mid-flight.
4. Consequently, 1 operation out of the 8 total operations is dropped during execution, resulting in `applied.length` being 7 instead of the expected 8.

---

## Distractors in the Log (Not the Root Cause)
- **`MaxListenersExceededWarning` (lines 53-56):** Node.js event emitter warning about 11 close listeners attached to an `EventTarget`. This is a non-fatal process warning from worker thread cleanups, not the cause of the assertion failure.
- **Heap & Worker Info (lines 40-42, 51):** Heap memory usage (612MB / 1024MB) and thread pool worker count (8 active) are within normal operational limits.

---

## Recommended Next Actions
1. **Inspect Drain Loop Implementation:** Examine the queue drain function in `src/stores/scanStore.ts` (or relevant store module) that manages `pendingSyncQueue`. Ensure that:
   - Queue draining operates in an atomic loop that re-checks for new pending items before completing.
   - Queue updates do not replace `pendingSyncQueue` with stale state snapshots captured before async network operations finished.
2. **Verify Fix:** Run the targeted test file to confirm resolution:
   ```bash
   npx vitest run src/stores/cloudDrainRace.store.test.ts
   ```
