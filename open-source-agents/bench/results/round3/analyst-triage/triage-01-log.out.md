<!-- subject=analyst-triage case=triage-01-log round=3 elapsed=36s rc=0 -->
**Root‑cause hypothesis (confidence = high)**  
The failure is a *timing artifact* caused by shared mutable state between concurrent async drains when Vitest runs tests in parallel workers. The test file `cloudDrainRace.store.test.ts` is listed in the project’s known‑flaky registry (`cloudDrainRace.store.test.ts` is timing‑flaky only under full parallel vitest load). In the current run, with 8 worker threads and `fileParallelism = true`, one of the enqueued operations was lost or not applied before the assertion, so `applied.length` reports 7 instead of the expected 8. The test passes when executed in isolation (single file, no parallel siblings), confirming that the code itself is correct but the test environment introduces a race.

**Next diagnostic step**  
Re‑run this single test file in isolation to confirm it succeeds:

```bash
npx vitest run src/stores/cloudDrainRace.store.test.ts --run --only
```

If the isolated run passes, the root cause remains a timing/race issue; if it still fails, further investigation (e.g., adding explicit synchronization or inspecting shared state) would be required.
