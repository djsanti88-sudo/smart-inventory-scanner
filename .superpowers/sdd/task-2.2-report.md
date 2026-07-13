# Task 2.2 Report - Deprecate legacy `decodeOrchestrator`

Branch: `feat/decode-ladder-goupc`. Documentation-only change: add an `@deprecated` JSDoc header to
`src/services/ai/decodeOrchestrator.ts`. No renames, no moves, no deletion, no behavior change.

## Import verification (grep, before editing)

`grep -rn decodeOrchestrator src` found 9 files referencing the module (more than the brief's 4
named importers). Verdict per file:

| Importer | Import line | Verdict |
|---|---|---|
| `src/app/api/ai-lookup/route.ts` | `import { type ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **type-only** (inline `type` modifier) |
| `src/services/ai/decodeFallback.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **type-only** |
| `src/services/benchmark/benchmarkAnalysis.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **type-only** |
| `src/services/decode/index.ts` | `export { runDecode } from "@/services/ai/decodeOrchestrator";` + a separate `export type { DecodeProvider, DecodeRunParams, DecodeRunResult, DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **RUNTIME SYMBOL** - re-exports the `runDecode` function itself, not just types |
| `src/services/decode/contract.ts` | `import type { DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **type-only** (found beyond the brief's named 4) |
| `src/services/ai/decodeFallback.test.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only (test file) |
| `src/services/ai/decodeOrchestrator.test.ts` | `import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";` | runtime symbol - expected, this is the module's own unit test |
| `src/services/ai/groundedSpecFinder.ts` | comment only referencing the file/line, no import | not an import |
| `src/services/decode/README.md` | prose reference | not code |

### Follow-up: is the runtime re-export actually used?

`grep -rn runDecode src` shows the `decode/index.ts` barrel's re-exported `runDecode` has **zero
live (non-test) callers** anywhere in `src`. Only `decodeOrchestrator.test.ts` imports and calls
`runDecode` directly (from the source module, not the barrel). So `decode/index.ts` exposes a live
runtime symbol, but nothing in production code currently consumes it through that barrel - it is
unused dead surface, not a hidden production dependency.

### Verdict summary

- 3 of the 4 brief-named importers (`route.ts`, `decodeFallback.ts`, `benchmarkAnalysis.ts`) are
  confirmed **type-only**, matching the prior audit.
- The 4th brief-named importer, **`decode/index.ts`, is NOT type-only** - it re-exports the
  `runDecode` runtime function alongside its type-only export line. Per the brief's instruction
  ("if any imports a runtime symbol... report instead of changing behavior"), no behavior was
  changed for this file; it is documented here and referenced in the new JSDoc.
- One additional type-only importer beyond the brief's list was found: `decode/contract.ts`.

## Change made

Added this `@deprecated` JSDoc block directly above the existing top-of-file comment in
`src/services/ai/decodeOrchestrator.ts`:

```ts
/**
 * @deprecated Legacy concurrent orchestrator - superseded by the decode ladder
 * (src/server/upc/ladder.ts) + route computeDecode. Only type exports remain in use
 * (src/app/api/ai-lookup/route.ts, src/services/decode/index.ts, src/services/ai/decodeFallback.ts,
 * src/services/benchmark/benchmarkAnalysis.ts import types only). `decode/index.ts` also re-exports
 * the `runDecode` runtime symbol via its barrel, but no live (non-test) code calls it - do not add
 * new callers. Kept for its own unit tests and historical reference; do not extend.
 */
```

No other lines in the file were touched. No imports, exports, function bodies, or types were
changed, renamed, or removed.

## Gate result

| Gate | Command | Result | Exit code |
|---|---|---|---|
| Unit tests | `npm run test` | `Test Files 186 passed \| 7 skipped (193)` / `Tests 1723 passed \| 30 skipped (1753)` | 0 |

No typecheck/lint gate was required by the brief (JSDoc-only, zero-risk); the full unit suite is
the proof and it is green with no new failures.

## Files changed

- `src/services/ai/decodeOrchestrator.ts` - added `@deprecated` JSDoc header only.
- `docs/superpowers/reports/2026-07-12-free-work-execution.md` - appended `## Task 2.2` section.
- `.superpowers/sdd/task-2.2-report.md` - this report (new file).

**Task complete. All gates green. No STOP condition encountered.**
