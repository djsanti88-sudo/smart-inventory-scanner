# Task 3 Report: Fast Brand-Anchored Grounded Spec Finder

## Failing-then-passing parse test output

### Failing run (Step 2 - before implementation):
```
FAIL  |unit| src/services/ai/groundedSpecFinder.test.ts [ src/services/ai/groundedSpecFinder.test.ts ]
Error: Cannot find module './groundedSpecFinder' imported from ...groundedSpecFinder.test.ts
Test Files  1 failed (1)
Tests  no tests
Duration  143ms
```

### Passing run (Step 4 - after implementation):
```
RUN  v4.1.8 C:/Users/djsan/inventory
Test Files  1 passed (1)
Tests  2 passed (2)
Start at  19:49:49
Duration  160ms (transform 28ms, setup 0ms, import 39ms, tests 2ms, environment 0ms)
```

Both parse cases pass:
1. "maps a grounded JSON answer to a result + strong evidence when the exact code is grounded" - PASS
2. "returns weak evidence when the exact code is NOT grounded" - PASS

## Typecheck result

```
npx tsc --noEmit
(no output - clean, exit 0)
```

No new type errors introduced.

## How groundedSpecFind is wired to the existing provider

The live wrapper mirrors `src/services/ai/geminiProvider.ts` lines 29-59 exactly:

- Same API endpoint pattern: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
- Same `tools: [{ google_search: {} }]` grounding flag (geminiProvider.ts line 27)
- Same `generationConfig: { temperature: ... }` structure (geminiProvider.ts line 26)
- Same grounding-aware response extraction: `candidate?.content?.parts` text join (geminiProvider.ts lines 40-43)
- Same `extractJson` function pattern as `safeParseJson` in geminiProvider.ts lines 69-81: tolerates code-fence wrapper, finds first `{...}` object

Key difference: `groundedSpecFind` does NOT reuse `normalizeResult` from `provider.ts` because `parseSpecResponse` is a purpose-built pure mapper that sets `corroboratedByModel`, anchors brand, and returns an `EvidenceResult` alongside the result. Using `normalizeResult` would lose the `exactCodeGrounded -> fetched_source` evidence mapping.

The provider reads `process.env.GEMINI_API_KEY` server-side only (same as geminiProvider.ts line 10). The file is guarded with `import "server-only"` so the Next.js bundler will reject client-side imports.

## Commit

Branch: `decode/prefix-anchored-fast`
Commit hash: `9c2fa90`
Message: `feat(decode): fast brand-anchored grounded spec finder (3s budget)`
Files committed:
- `src/services/ai/groundedSpecFinder.ts`
- `src/services/ai/groundedSpecFinder.test.ts`

---

# Task 3 FIX Report: Evidence via EvidenceVerifier, not model claim

## verifyEvidence signature mirrored

From `src/services/ai/evidenceVerifier.ts` lines 63-68:
```ts
export function verifyEvidence(
  code: string,
  codeType: CodeType,
  evidence: ProviderEvidence,
  opts?: { trustedHosts?: string[] },
): EvidenceResult
```

Mirrored in `groundedSpecFind` at the call site (mirrors `decodeOrchestrator.ts` line 132):
```ts
const evidence = verifyEvidence(code, codeType, providerEvidence);
```

## Test output (fail then pass)

### Failing run (new test with old implementation - parseSpecResponse called with 2 args but old code expected 3):
```
FAIL  |unit| src/services/ai/groundedSpecFinder.test.ts (2 tests | 1 failed) 5ms
  x anchors the brand and builds productName from brand+model+size 4ms
    AssertionError: expected 'WRONGBRAND' to be 'Cooper'
Test Files  1 failed (1)
Tests  1 failed | 1 passed (2)
```

### Passing run (after fix):
```
RUN  v4.1.8 C:/Users/djsan/inventory
Test Files  1 passed (1)
Tests  2 passed (2)
Start at  20:05:54
Duration  157ms
```

Full suite: 93 passed | 7 skipped (100), 679 passed | 30 skipped (709).

## Typecheck result

```
npx tsc --noEmit
(no output - clean, exit 0)
```

## Proof that no code path sets evidence.verified=true without an EvidenceVerifier call

There is no code path in the fixed file where `evidence.verified` can become `true` without passing through `verifyEvidence`. Specifically:

1. `parseSpecResponse` returns `{ result: AiLookupResult | null }` ONLY - it has no `evidence` field at all. The old code that set `evidence = { verified: true, strength: "fetched_source" }` when `exactCodeGrounded === true` has been deleted entirely.

2. `groundedSpecFind` produces evidence in exactly one place (after the `res.ok` check):
   ```ts
   const evidence = verifyEvidence(code, codeType, providerEvidence);
   ```
   This is the ONLY assignment to `evidence` in the live path. The `nullResult()` helper always returns `verified: false`. The `catch` block calls `nullResult()` which also returns `verified: false`.

3. `verifyEvidence` (read-only, not modified) returns `verified: true` only when the exact code appears in real grounding text or a trusted-host URL - never from the model's `exactCodeGrounded` field (which is not passed to it at all).

## Key-in-URL and response-size-limit items

Both match the existing `geminiProvider.ts` precedent (key appended to URL as `?key=`, no response size limit enforced). These are noted in inline comments in the fixed file for codebase-wide follow-up; this file does NOT diverge from the parent pattern.

## Commit

## Concerns for Task 4 (live wrapper)

1. **`exactCodeGrounded` is model self-claim, not app-verified**: The `groundedSpecFind` wrapper sets `evidence.strength = "fetched_source"` when `json.exactCodeGrounded === true`, but this is the model's own claim - not independently verified by `EvidenceVerifier`. Task 4's integration test should confirm whether Gemini reliably sets this flag only when the UPC truly appears in a cited source. If not, the evidence strength should be downgraded to `grounding_chunk`.

2. **No `EvidenceVerifier` call in the live path**: Unlike `decodeOrchestrator.ts` which calls `verifyEvidence(code, codeType, evidenceOf(r))` independently, `groundedSpecFind` trusts `exactCodeGrounded` from the model. For the fast/cheap path this is an acceptable trade-off (3s budget), but Task 4 should document it as a known gap vs. the full orchestrator path.

3. **Grounding chunk text is not extracted**: The live wrapper extracts only the `text` from `content.parts` but does NOT extract `candidate.groundingMetadata.groundingSupports` (the support segment texts that `geminiProvider.ts` maps to `groundingChunks`). If the model sets `exactCodeGrounded: false` but the UPC actually appears in a grounding chunk, the evidence strength will be `"none"` instead of `"grounding_chunk"`. Task 4 should decide whether to add grounding metadata extraction.

4. **`AbortSignal.timeout(3000)` behavior**: When no external signal is passed, the wrapper uses `AbortSignal.timeout(3000)`. If the Gemini call itself takes exactly 3s due to network conditions, the signal may fire mid-read. This is the intended 3s budget behavior per the brief, but Task 4 should verify the error is caught cleanly (it is - the `catch` block returns `nullResult()`).
