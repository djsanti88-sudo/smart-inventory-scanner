# CRIB: Decode Ladder (verified against src/server/decode/pipeline.ts, src/server/upc/ladder.ts,
# src/services/ai/decode.ts, src/services/circuitBreaker.ts, src/stores/scanStore.ts)

## Ladder order (first-settled-rung-STOPS the whole ladder; free before paid, always)

Stage 0 (before any ladder, in `runDecodePipeline`, all $0, no cap):
1. `tire-corpus` - exact trusted-corpus barcode/PN hit. Settles instantly, never persisted to L2.
2. `retail-corpus` - 4M-row Turso retail exact-barcode hit (rung-0 fix). Always a SUGGESTION, never verified.
3. `learned-products` - prior human-approved learning tier. Always a SUGGESTION (never verified).
4. L2 persisted-decode cache peek (a prior "result" or permanent "no_result_receipt" replay) - re-validated
   against misread/example gates before replay; poisoned entries are nulled and recomputed.

Free ladder rungs (`buildFreeLadderRungs`, GTIN-shaped codes only, $0, own local counters not the AI cap):
5. `upcitemdb` - free keyless trial tier (90/day local counter). Hit is always a suggestion.
6. `openfoodfacts` - free. Hit is always a suggestion.

Plan D (`resolveUnknownFast`, public barcode types only: upc_a/ean_13/gtin_14): runs AFTER the free
rungs, BEFORE the cap gate. A verified 2-DB-consensus win returns immediately (free, no cap charge).
A non-verified floor/suggestion is STASHED as the all-miss fallback, not returned yet.

--- LAZY DAILY CAP GATE fires here (only reached if nothing above settled "verified", or before any
paid rung actually runs) - `chargePaidSlot()`: reads `AI_LOOKUP_DAILY_LIMIT` (default 2000; per-account
`AI_LOOKUP_GLOBAL_BACKSTOP` for authed/cap-cleared tenants), throws `DailyCapExceededError` if exhausted.
This is the ONLY place a genuine paid charge happens - free/corpus/cache hits never reach it. ---

Paid ladder rungs (`buildPaidLadderRungs`, order: `["goupc", "fetchv2", "gpt"]` for a valid GTIN,
`["fetchv2", "gpt"]` for a non-GTIN code - goupc is GTIN-gated):
7. `goupc` (Go-UPC) - paid, GTIN-gated, 2 req/s throttled. Self-report only (`verified: false` /
   `strength: "none"` internally), demoted to a suggestion at the ladder layer.
8. `fetchv2` (Fetch V2) - paid web-evidence engine, up to 3 sources, ~25s cap. Can genuinely settle
   "verified" when it independently confirms the exact code on a fetched page (`fetched_source`
   evidence strength); otherwise settles "needs_review"/suggestion.
9. `gpt` (GPT-5.5-ladder, `gpt-5.5-ladder` in providerStatuses) - final paid rung. NEVER mints
   "verified" on its own (self-report only); tier "none" with no aborts/errors = genuine exhaustion,
   eligible for a permanent `no_result_receipt`.

ESCALATION variant (wave-3, when a FREE rung already produced a suggestion): Go-UPC gets first crack
at beating the free stash; if it doesn't improve on it, Fetch V2 gets a shot; if that doesn't improve
either, GPT gets the final shot. A paid rung replaces the free suggestion ONLY if its own outcome is
"verified" or a suggestion with STRICTLY higher confidence - otherwise the free suggestion stands and
the paid rung's reason is still recorded in the reasons list (visible in trace, never silent).

## Reading trace/reason text: what a miss looks like per rung
- Free-rung miss: reason string ends in the rung's own miss code, e.g. "upcitemdb: no match",
  "Open Food Facts: ..." - recorded via `RungOutcome.reason`, never blocks the ladder.
- goupc miss: `goupc_miss` / `goupc_unavailable` in providerStatuses.errorCode.
- fetchv2 miss: `errorCode` is the fv2 outcome itself when not settled (e.g. `no_evidence`),
  or `fetchv2_error` on a thrown exception, or `"skipped: insufficient time budget left (needed
  >=Ns)"` from the wave-3 money-preflight gate (fires BEFORE the rung even starts, so it never bills).
- gpt miss/skip reasons (`errorCode` on the `gpt-5.5-ladder` providerStatus entry): `no_api_key`,
  `non_public_code_type`, `e2e_mode`, `request_budget_exhausted`, `budget_exceeded` (own $ cap hit -
  NOT the same as the AI daily cap), `gpt_aborted_at_cap`, `gpt_call_failed` (transient - HTTP/abort
  failure, NEVER creates a permanent receipt), or no skip at all with tier "none" (genuine exhaustion).
- Ladder-level timeout: `"skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)"` (default 90s
  total budget) or `"aborted: rung exceeded its budget (...)ms"` per-rung.
- 429 cap-exhausted signature: `DailyCapExceededError` -> HTTP 429 "daily_cap" response BEFORE any
  paid rung ran; in a trace this shows as an abrupt stop with NO paid providerStatuses entries at all
  (everything before it is free-rung `other`/skip entries, typically ~0-10ms each) - not a per-rung
  error, the whole paid ladder never started.
- example/test barcode gate: `isExampleOrTestRow` stops the pipeline BEFORE any paid rung with
  `errorCode: "example_or_test_barcode"` (provider `example-gate`) - correctly-refused, not a miss.
- misread-GTIN gate: `isLikelyMisreadGtin` (bad GS1 check digit) blocks corpus/retail/cache replay
  for that code, forcing an honest recompute instead of a coincidental wrong match.

## Circuit breaker / emergency stop / daily cap (client-side gate, `evaluateAiGate`)
Reasons, in priority: `disabled` (AI lookup off) > `offline` > `daily_cap` (local dailyCount >=
dailyLimit) > `circuit_open` (breaker tripped) > `ok`. Breaker: `initBreaker/recordSuccess/
recordFailure/canRequest` - closed -> open after `FAILURE_THRESHOLD` (12) consecutive failures ->
half_open after `COOLDOWN_MS` (30s) -> closed again on success. `emergencyStop` (scanStore) is a
separate manual kill switch: `"Emergency stop is active. AI calls are paused."` - checked before the
gate above. These are SERVER-SIDE-agnostic UI-layer gates; the pipeline's own `chargePaidSlot`/
`DailyCapExceededError` is the server-authoritative cap.

## Evidence hierarchy + decideDecode verify gate (`src/services/ai/decode.ts`)
Strength order: none < url_only < snippet < grounding_chunk < fetched_source. `EvidenceVerifier`
output is the ONLY thing that decides "verified" evidence - a provider's own claim is never trusted.
"verified" status requires ALL of: public barcode codeType (upc_a/ean_13/gtin_14 only - never
vendor_label/X00/FNSKU/ASIN/internal/messy), strong app-verified evidence (single strong source OR
two providers agreeing), non-empty product identity, confidence >= threshold (baseline 0.8), no
brand-prefix conflict (prefixFirewall - overridden by strong exact-code evidence). `CrossCheckEngine`
compares two providers -> agree | conflict | single_provider | weak; disagreement = conflict, forced
to needs_review, never guessed.

## codeType detection (`src/services/codeTypeDetector.ts`)
Vendor-label check runs BEFORE any SKU/digit rule: X00.../B0... (Amazon FNSKU/ASIN, 10 uppercase
alphanumerics) -> `vendor_label`, never treated as a barcode. `upc_a`/`ean_13`/`gtin_14` are the only
types eligible for "verified" or the goupc/upcitemdb/openfoodfacts/retail-corpus rungs.

## Gemini
`GEMINI_DECODE_DISABLED = true` permanently in pipeline.ts (owner order 2026-07-06): the grounding arm
inside Plan D (`groundIdentify`) is hard-gated off (resolves `null`/miss) regardless of any other
setting. Gemini never appears as a live decode rung in any trace.

## L1 vs L2 cache
L1 (`withDecodeCache`/`getDecodeCache`) = in-memory, per-server-process, checked first, never persists.
L2 (`getPersistedDecode`/`persistDecode`, Turso-backed) = durable across restarts, consulted on an L1
miss, BEFORE the daily cap check, so a persisted result or receipt never burns a cap slot. Only PAID
outcomes (`classifySourceTier`: "gpt_ladder" / legacy "paid_ai" markers / "paid_rung" = go-upc or
fetchv2) are ever written to L2 - free/corpus/Plan-D hits are never persisted (a wrong free guess must
never become a permanent wrong answer).
