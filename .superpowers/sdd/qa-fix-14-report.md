# QA Fix #14 Report

## Bug
Medium, info-disclosure: customer-facing reason/status text leaked raw vendor/service/model names
verbatim ("upcitemdb", "openfoodfacts", "goupc"/"Go-UPC", "fetchv2"/"Fetch V2", "gpt-5.5",
"gpt_call_failed") to every role, live on preview.

## Root cause
No content sanitizer existed on the customer-facing `reasonText`/`decision.reason` path. Raw
per-rung reason strings (UpcItemDbProvider/OpenFoodFactsProvider/GoUpcProvider, Fetch V2 strings,
the GPT ladder rung's hardcoded "gpt-5.5 from-scratch: ..." reason, and the all-miss join in
`pipeline.ts`) flowed straight through to `reasonText`/`decision.reason` -> scanStore.ts ->
`needsReviewQueue[].reason` / `scanFeed[].reason` -> rendered verbatim by `LiveScanFeed.tsx` /
`NeedsReviewTable.tsx`. The existing `REASON_TEXT` map (decodeFallback.ts) was stale/dead on the
ladder path - it never covered these sites.

## Fix
1. `src/services/ai/decodeFallback.ts`: added a pure `sanitizeCustomerReason(raw, ctx?)` - denylist
   regex covering every raw vendor/service/model token and internal skip-reason code; empty or
   denylisted input returns an honest, non-empty, context-aware fallback (cap/offline/missing-keys
   context reused from scanStore's existing honest copy, else a generic honest default). Safe
   hand-written prose passes through unchanged. Never returns "".
2. `src/services/ai/gptLadderRung.ts`: replaced the two hardcoded `GPT_LADDER_REASON` /
   `GPT_LADDER_SUGGEST_REASON` literals (which named the model) with honest, token-free copy.
3. `src/server/decode/pipeline.ts`: applied `sanitizeCustomerReason` at every customer-facing
   `reasonText`/`decision.reason` assembly - the `win` branch (settled rung), the Plan-D-stash
   all-miss merge, and the plain all-miss branch. `debug.ladderReasons` (and all of `debug.*`) is
   left untouched - platform-only, keeps the raw chain for diagnosis.
4. `src/stores/scanStore.ts`: client-side defense-in-depth - `data.decision.reason` and
   `data.reasonText` are sanitized once, immediately after the `/api/ai-lookup` response is parsed
   in `runLiveDecodeOnce`, so every downstream read (`needsReviewQueue[].reason`,
   `scanFeed[].reason`, the existing `honestReasonForBadge` composition) is already clean without
   touching that badge/reason logic itself.

## Tests (TDD, all written failing first)
- `decodeFallback.test.ts`: `sanitizeCustomerReason` strips every denylisted token to an honest
  non-empty string, passes safe prose through unchanged, never returns "" for empty input, honest
  context reasons (offline/cap/missing-keys) survive intact.
- `gptLadderRung.test.ts`: verified and suggested `decision.reason` contain no vendor/model token
  and are non-empty.
- `pipeline.test.ts`: all-miss ladder, free-rung settle (UPCitemdb hit), and a genuine Go-UPC
  prefix-conflict settle all produce clean, non-empty `reasonText`/`decision.reason`;
  `debug.ladderReasons` still carries the raw chain. Updated one pre-existing assertion that had
  encoded the OLD raw-leaking behavior (`/No rung resolved the code/` match) to assert the new
  sanitized-but-honest contract instead.
- `route.test.ts`: new describe block asserts the customer-facing PROSE fields (`reasonText`,
  `decision.reason`, `results[].guesses`) across no-key / HTTP-500 (`gpt_call_failed`) / all-miss
  scenarios never match the denylist and are never empty. Scoped to prose fields only -
  `providerNames`/`providerStatuses` are structured metadata the client's own logic keys off
  (e.g. `provider === "gpt-5.5-ladder"`), not customer-rendered prose, and are out of this bug's
  scope. Updated the same pre-existing raw-leak assertion as pipeline.test.ts.
- New `scanStore.reasonSanitize.test.ts`: client-side defense-in-depth - a mocked
  `/api/ai-lookup` response carrying a raw leaking `reasonText`/`decision.reason` never reaches
  `needsReviewQueue[].reason` or `scanFeed[].reason`; honest server prose survives byte-for-byte.

## Gates
- `npx vitest run src/services/ src/server/ src/stores/` (reduced worker count): 2081 passed / 32
  skipped, 0 failed.
- Full `npx vitest run` (reduced worker count `--maxWorkers=2`): 2455 passed / 32 skipped, 0
  failed, across all 250 files.
- `npx tsc --noEmit`: clean.
- Note: at full default parallelism the suite showed a handful of pre-existing, unrelated
  timing/resource-contention flakes (`countAlways.store.test.ts` 174-code burst timeout,
  `cloudDrainRace.store.test.ts`, `LiveScanFeedSuggestion.test.tsx`, `scanFocus.test.tsx`) - none
  reference `reasonText`/`decision.reason`/the sanitizer, and all pass cleanly in isolation and
  under reduced parallelism. Confirmed pre-existing and unrelated to this fix.

## Concerns
- None blocking. The denylist is a regex list, not an allowlist - a future new provider/rung name
  must be added to the denylist in `decodeFallback.ts` (and mirrored in the test regexes) or its
  raw name could leak the same way. Left a comment at the sanitizer's definition site pointing at
  this.
