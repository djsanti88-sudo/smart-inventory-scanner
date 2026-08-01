# Task 14 local 5,000-row performance report

## Environment and procedure

- Timestamp: 2026-07-31 local worktree run.
- Fixture: `src/eval/identity/fixtures/frozen-5000.v1.json`, synthetic-only, deterministic seed `scanbin-local-identity-5000`, 5,000 rows, total quantity 5,000.
- Procedure: cold preview diagnostic, warm crypto/parser/engine/signer, one warmup and three measured warm previews; decision timing uses one real `lookupBatch`, then sequential `decideIdentity` calls over `candidatesByRecord`.
- Browser main-thread proof: **BLOCKED**. E2E/Playwright is owner-forbidden, and Node scheduling is not browser responsiveness evidence.

## RED/GREEN evidence

- RED: the route rejected a valid 5,000-row request at its old 512 KiB input ceiling; the frozen perf harness exposed post-sign tokens above the 512 KiB output cap.
- GREEN: `npx.cmd vitest run src/eval/identity/importPerf.test.ts` passed: 1 test, 3.24 s wall including Vitest startup, 2.88 s test body.
- The harness verifies actual emitted token bytes, multi-chunk output, aggregate 32 MiB cap, signed-chunk/root recomputation, 5,000 rows/decisions/row IDs, exact quantity accounting, warm preview <=10 s, and sequential-decision nearest-rank p95 <=2 ms.
- Compatibility GREEN: `npx.cmd vitest run src/services/universalFileReader.test.ts src/components/UniversalImportPanelContainer.test.tsx src/services/universalImportPreview.test.ts` passed: 42 tests.

## Blockers

- The existing exported-route purity test that initializes `.tmp/identity-import` is environment-blocked by `EPERM mkdir` under the sandbox. It is not treated as product proof or a code regression.
- A portable baseline comparison is diagnostic only until this machine's baseline JSON is deliberately recorded; no cross-machine timing claim is made.
