<!-- subject=analyst-triage case=triage-01-log round=4 elapsed=33s rc=0 -->
**Root‑cause hypothesis (high confidence)**  
The failure in `cloudDrainRace.store.test.ts` is a timing/race artifact that only manifests when the test runs under Vitest’s parallel load. The file is listed in the project’s *known‑flaky registry* (`cloudDrainRace.store.test.ts` is “timing‑flaky ONLY under full parallel vitest load; it passes in isolation”). The assertion `expect(applied.length).toBe(8)` fails because one operation is lost only when concurrent drains and late enqueues overlap, not because the deterministic code path produces an incorrect value.

**Next diagnostic step (cheapest)**  
Re‑run `cloudDrainRace.store.test.ts` **in isolation** (single worker / no parallel siblings). If it passes alone, the issue is confirmed as a race condition; if it still fails, then further targeted tracing of the drain logic would be required.
