### Task 2.2: Deprecate legacy `decodeOrchestrator`

**Files:** Modify `src/services/ai/decodeOrchestrator.ts` (header JSDoc), no behavior change.

- [ ] Add `@deprecated` JSDoc: "Legacy concurrent orchestrator - superseded by the decode ladder
  (src/server/upc/ladder.ts) + route computeDecode. Only type exports remain in use." Verify the
  4 known live importers (route.ts, decode/index.ts, decodeFallback.ts, benchmarkAnalysis.ts)
  import TYPES only; if any imports a runtime symbol, report instead of changing behavior.
- [ ] `npm run test` green. Commit `docs(code): mark decodeOrchestrator deprecated (ladder era)`.

