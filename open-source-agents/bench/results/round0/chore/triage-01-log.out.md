<!-- subject=chore case=triage-01-log round=0 elapsed=84s rc=0 -->


TL;DR: Test failure due to race condition where async drain operations missed one enqueued operation.

Root cause: The test expects 8 operations to be applied but only 7 are recorded. This suggests a race condition where the async drain processes didn't fully complete before the assertion, or one operation was lost during concurrent processing.

Key facts:
- Test asserts `applied.length` should be 8
- Actual value is 7
- Test involves concurrent drains and late enqueues
- Error occurs in `cloudDrainRace.store.test.ts:64`

Next action: Add explicit await for drain completion or use synchronization primitives (e.g., Promise.allSettled) to ensure all operations are processed before assertion. Check if the mockDb correctly tracks all operations.
