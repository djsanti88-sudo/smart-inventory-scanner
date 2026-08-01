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

## Fix round 1

- Recorded-machine baseline: Windows 10.0.26200 x64, Intel Core i7-14650HX, 24 logical CPUs, Node v24.15.0. The immutable fixture SHA-256 is `873572f1ddf8835e3e7e9dea2307aec2361c7663e2592d841a670bd5a9640c86`; snapshot hash is `frozen-local-hash-v1`.
- Measured cold diagnostic was 3.4064 ms. Three warm runs were 398.6923, 397.5722, and 466.7902 ms; median 398.6923 ms. Sequential decision p95 was 0.0475 ms. Actual signed output: 12 chunks, maximum 479,234 bytes, aggregate 5,635,054 bytes.
- The offline benchmark supports `--import-performance --compare-baseline --format=json|markdown` and reports an environment mismatch rather than treating this machine baseline as portable proof.
- DOM proof uploads through the real container/shaper into an injected preview route: service receives all 5,000 rows in source order, each of five buckets totals 1,000, and the aggregate-only UI renders only 25 review controls. Oversized or malformed chunk sets keep Apply unavailable.

## Fix round 2

- The benchmark CLI now executes the shared harness for every `--import-performance` invocation. It performs one cold diagnostic, one warmup, three measured warm runs, and one real batch retrieval followed by sequential decisions. It exits nonzero if the absolute 10,000 ms / 2 ms gates fail or if a comparable-machine median exceeds 110% of baseline.
- Current comparison run: cold 3.6955 ms; warm 449.4470, 448.6229, and 461.5591 ms; median 449.4470 ms versus baseline limit 645.1210 ms; decision p95 0.0598 ms. Signed output had 13 chunks, maximum 478,340 bytes, aggregate 5,970,125 bytes.
- Runtime fixture SHA-256 verification binds `96ead7180f18147d23ac007f9ed2b247bd5bbe260d3f166fc04980be5b1298c3`. The shared fixture contract requires 5,000 rows, total quantity 15,000, and bucket vectors: automatic 1,000/1,000; review 1,000/2,000; abstain 1,000/3,000; non-product 1,000/4,000; invalid 1,000/5,000. Performance proof sums quantities from verified signed row/decision pairs; DOM proof imports the same contract.
- Stream enforcement proof sends 33 one-MiB chunks through a `ReadableStream` with no `Content-Length`; the route returns 413 and delegates zero times.
- Exact build blocker: `npm.cmd run build` on Windows 10.0.26200, Node v24.15.0, Next 16.2.12. Turbopack rejected the linked-worktree symlink: `Symlink [project]/node_modules is invalid, it points out of the filesystem root`. This is distinct from the route-purity test's sandbox `EPERM` creating `.tmp/identity-import/...`.
