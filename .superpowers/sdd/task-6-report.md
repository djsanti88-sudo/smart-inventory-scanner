# Task 6 report: Ladder reorder part A - corpus peek BEFORE receipt replay

## What
Moved the free tire-corpus exact peek (barcode + SKU-shaped part-number variant) to the TOP of
`runDecodePipeline`, ahead of the L2 persisted-decode (`persistedHit`) peek. Previously the L2 peek -
including permanent `no_result_receipt` rows - ran first and the corpus stage lived INSIDE
`computeDecode`, so once a code exhausted the ladder and a stale receipt was written, a later weekly
corpus harvest that added that barcode could never heal it (the receipt replayed "unresolved" forever
and the $0 corpus hit never ran). Now the corpus hit heals the stale receipt.

- Extracted `corpusPayload(corpus, rawCodeSanitized, cleanCodeSanitized): DecodePayload` as a
  module-level PURE helper (debug fields copied verbatim from the old block).
- Early peek returns `{ kind: "computed", payload: corpusPayload(...), cached: false }`.
- Deleted the now-unreachable corpus block inside `computeDecode` (left a pointer comment).

## TDD evidence
- Step 1/2 (RED): new test `L1 fix: a code with a stale no_result_receipt resolves from the corpus`
  failed exactly as predicted - `expected 'persisted' to be 'computed'` (the receipt short-circuited
  first).
- Step 3 (implement): early peek + pure `corpusPayload` helper; corpus block deleted.
- Step 4 (GREEN):
  - `npx vitest run src/server/decode/pipeline.test.ts` -> 13 passed.
  - `npx vitest run src/server/decode/ src/app/api/ai-lookup/ src/eval/eval.test.ts` -> 63 passed
    (eval 0% false-auto-count invariant HELD).
  - `npx tsc --noEmit` -> 0 errors project-wide.
  - `npx eslint` on both changed files -> clean.

## Files
- `src/server/decode/pipeline.ts` - early corpus peek (first await after `cacheKey`), module-level pure
  `corpusPayload` helper, deleted in-computeDecode corpus block.
- `src/server/decode/pipeline.test.ts` - `vi.mock` for TireKnowledgeProvider + decodeCacheStore (hoisted
  pass-through holder restored in beforeEach), `makeCorpusHit`/`makeReceipt` factories, new RED->GREEN
  test.

## Self-review vs brief
- Corpus peek is the FIRST await in `runDecodePipeline`, immediately after the `cacheKey` const, before
  the `persistedHit` peek. YES.
- `persistedHit` peek otherwise unchanged. YES.
- `corpusPayload` is pure - no closure over request-scoped mutable state (all inputs are params). YES.
- Deleted block leaves no dangling references: `resolveExactBarcode`/`resolveExactPartNumber` still
  imported + used by the early peek; `retailLookupStatus` and the retail/Plan-D/ladder logic untouched.
  YES.
- Debug fields verbatim. YES.
- `e2eMode()` skips the corpus peek exactly as before. YES.
- forceRetry NOT special-cased for corpus (runs first regardless - equivalent to today). YES.
- Corpus hit never persisted to L2 (classifySourceTier -> null for tire-corpus) and never charges the
  cap - unchanged. YES.
- No existing test asserted corpus hits are L1-cached. The Z3 withDecodeCache spy test uses a non-corpus
  code (`0036000291452`), so it still flows through withDecodeCache - still passing. YES.
- eval invariant green. YES.

## Concerns
None. Consequence documented in the brief (corpus hits no longer enter the L1 memory cache via
withDecodeCache; ~0-150ms corpus lookup, acceptable) is intentional and matches the brief.
