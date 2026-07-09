# Decode Ladder Live Proof Report (Task 19: Rungs 1-2 live + Rungs 3-4 build/dry-run)

Generated 2026-07-09T04:49:18Z. Branch feat/decode-ladder-goupc.

## Rung 1 (corpus, $0)

- Sampled: 20 random tire barcodes + 20 random retail barcodes from `src/server/knowledge.generated.db`.
- Server: local dev on port 3105, all live provider keys blanked (GEMINI_API_KEY, OPENAI_API_KEY, GO_UPC_API_KEY, FIRECRAWL_API_KEY / _1.._10, BRAVE_SEARCH_API_KEY).
- Result: 39/40 resolved locally (assertion 40/40: false).
- p50 wall-clock (script-measured, includes HTTP/Next.js overhead): 260ms. Route-reported latencyMs for corpus hits is 0 by design (no internal timer on that path).
- Load caveat: a 4-worker crawler fleet runs concurrently in this checkout per the task brief; if p50 exceeds the 5ms internal-gate target, it reflects HTTP + host load, not corpus query cost.
- HONESTY NOTE: 19/20 retail rows resolve via `resolveUnknownFast`'s free-tier consensus, which also queries the free, keyless UPCitemdb trial endpoint concurrently with the local retail-DB lookup -- a live external network call (no key, $0), not purely offline. All 20 tire rows resolve via the direct `resolveExactBarcode` corpus short-circuit with zero network calls.
- Gaps found (1):
  - `52454615`: code IS in the local retail corpus (sqlite_hit) but codeType did not qualify for the free-tier resolver (isPublicBarcode gates on upc_a/ean_13/gtin_14 only -- e.g. EAN-8 falls through to the paid ladder, all-skipped here since keys are blanked)
- Raw: `scripts/proof-rung-1-results.json`.

## Rung 2 (Go-UPC, <= 15 lookups) -- LIVE, real keys

- Server: local dev on port 3106, REAL .env.local keys (Go-UPC quota genuinely spendable).
- Go-UPC usage counter (backend: turso, table `goupc_usage`) BEFORE: month=2026-07 used=0. AFTER: month=2026-07 used=0. Delta: 0.
- Known-good GTIN group (10 codes, confirmed absent from the local corpus): 9 verified, 1 suggested, 0 misses -- but see the finding below.
- Non-GTIN group (5 Amazon-ASIN-shaped codes): all 5 correctly gated BEFORE the Go-UPC client by `buildLadderRungs()` (`isGtinShaped && isValidCheckDigit`, src/server/upc/ladder.ts) -- 4/5 fell through to `fetchv2` (skipped, no key) then `gpt` (skipped, non_public_code_type), 1/5 got a `fetchv2:ok` result (Fetch V2 has no key gate of its own for discovery-less structured lookups). None ever touched `go-upc`. This IS the quota-protection proof the brief asked for, and it holds.

**CRITICAL FINDING -- the Go-UPC rung was NEVER actually invoked by any of the 15 calls, and structurally cannot be for ordinary public barcodes today.** All 10 known-good GTIN codes resolved via `resolveUnknownFast` ("Plan D", src/services/ai/parallelResolve.ts) BEFORE the ladder ever ran: providers seen were `parallel:floor` (1), `parallel:barcode_db` (2, UPCitemdb), `parallel:retail_db` (4, the same local corpus), `parallel:firecrawl` (3). The route (src/app/api/ai-lookup/route.ts:602-676) calls Plan D for every `isPublicBarcode` code (`upc_a`/`ean_13`/`gtin_14`) and Plan D is DELIBERATELY TERMINAL for those types by design (parallelResolve.ts:280-283 comment: "we must ALWAYS be terminal here and NEVER return null"). The Go-UPC -> Fetch V2 -> GPT ladder only runs for codes where Plan D is skipped, i.e. NON-public code types (vendor_label, alpha_sku, numeric_sku) -- and `numeric_sku` (any all-digit code that is not exactly 12/13/14 digits, e.g. 8-digit EAN-8) is the ONLY numeric shape that can be BOTH `isGtinShaped` (so `buildLadderRungs` includes the `goupc` rung) AND outside `isPublicBarcode` (so it actually reaches the ladder). This is the SAME gap class found in Rung 1 (code `66546931`, an EAN-8 retail hit that fell through to an all-skipped ladder instead of the free consensus path).
  - Net effect: with today's route wiring, the Go-UPC rung (and everything behind it -- Fetch V2, GPT-5.5) is reachable ONLY for 8-digit EAN-8-shaped codes. Standard UPC-A (12-digit), EAN-13 (13-digit), and GTIN-14 (14-digit) codes -- the overwhelming majority of real product barcodes -- can never reach Go-UPC through this route as currently wired, because Plan D always answers first and always terminates.
  - This was not a test-design mistake in isolation: the task brief's rung-2 design ("10 known-good GTIN codes NOT in local corpus" expecting a Go-UPC fallback) is a reasonable read of the plan doc, but the plan doc's Task 8 route-wiring description ("corpus/cache steps ... AFTER ... BEFORE any paid AI: goupc -> fetchv2 -> gpt") does not match what Task 8's actual committed code does for PUBLIC barcodes -- Plan D (a pre-existing, pre-ladder resolver) sits in front of and terminates the ladder for that whole class.
  - Recommend the controller decide: (a) is Plan D's terminal behavior for public barcodes an intentional, permanent design (in which case the Go-UPC/Fetch-V2/GPT ladder's real-world reach is far narrower than the plan assumed, and rungs 3-4's "double-miss" input set -- which are ALL non-tire numeric codes, need re-examination for which code shape they actually are), or (b) Plan D needs to be scoped down / the ladder needs to run when Plan D produces only an unverified floor, before rungs 3-4 are authorized to spend against it.

**Real (small) unplanned spend disclosure:** 3 of the 10 known-good-GTIN calls resolved via `parallel:firecrawl`, meaning Plan D's Firecrawl `/search` tiebreaker (1 credit) fired for those codes (and possibly `firecrawlScrapeCheap`, another 1 credit, if search alone was insufficient) -- this is REAL Firecrawl credit spend that happened as a side effect of testing "Go-UPC," not Go-UPC spend itself. Estimated worst case: <=6 credits (3 search + up to 3 scrape), well inside the phase's 300-credit Firecrawl cap, but outside the "$0 marginal" framing the brief stated for this rung. Reconciliation: computed floor from response shapes; true spend = Firecrawl console.
- Reconciliation (Go-UPC): computed floor from this script's counter read (delta 0, backend confirmed live via Turso); true spend = Go-UPC provider console (expect $0 this run, matching the delta).
- Raw: `scripts/proof-rung-2-results.json`.

## Rung 3 (Fetch V2, HARD SET ONLY) -- BUILT, DRY-RUN ONLY (not authorized to spend this dispatch)

- Input reconciliation: `tmp-goupc-200-misses.txt` (74 double-miss codes) = `tmp-fetchv2-misses.txt` (61 still-unresolved) ∪ the 13 codes Fetch V2 already resolved in `tmp-fetchv2-goupc-misses.json` (all verified/suggested). Reconciled: true.
- Dry-run validated a 20-code sample from the still-unresolved pool with ZERO network calls / ZERO Firecrawl credits.
- Baseline to beat: 17.6% (13/74). Success gate for a live run: resolution rate strictly > baseline AND zero wrong identities vs corpus/fixture truth.
- Live invocation (owner-gated, not run this dispatch): `node scripts/proof-rung-3-fetchv2.mjs --live --sample=20 --port=3107`.
- Raw: `scripts/proof-rung-3-results.json`.

## Rung 4 (GPT-5.5 v3 prompt, HARD SET ONLY, <= $1.5) -- BUILT, DRY-RUN ONLY (not authorized to spend this dispatch)

- Budget guard (copied pattern from `scripts/tmp-gpt-goupc-misses.mts`): worst-case reserve $0.39/call, hard cap $1.5 (this rung's reserved slice of the phase's $3.00 total GPT-5.5 cap) -> CONCERN: guard allows at most 3 calls under this $1.5 cap at the $0.39/call worst-case reserve -- a 10-code sample does NOT fit (10 * $0.39 = $3.90 > $1.5). Even the FULL phase-wide $3.00 GPT-5.5 cap only affords 7 calls at this worst-case rate, not 10. The plan's "$1.5 (half split) / 10-code sample" combination is arithmetically inconsistent as written -- the controller must either raise this rung's reserved cap, accept a smaller sample (<=3 codes), or confirm a lower true worst-case-per-call before authorizing --live.
- Junk-guess gate: <= 0 (2026-07-08 v2-prompt baseline was 3 junk in 7; the v3 prompt under test is designed to kill this).
- Dry-run validated the guard math with ZERO network calls / ZERO OpenAI spend.
- Input dependency: this rung's 10-code sample is drawn from codes rung 3 STILL cannot resolve -- it does not exist until rung 3 has actually run live, so this rung cannot execute before rung 3.
- Live invocation (owner-gated, not run this dispatch): `node scripts/proof-rung-4-gpt.mjs --live --codes=CODE1,CODE2,...,CODE10 --port=3108`.
- Raw: `scripts/proof-rung-4-results.json`.

## Rung 2 RE-RUN (Go-UPC via the FIXED ladder, commit 6a800c4) -- LIVE, real keys

- Server: local dev on port 3106, REAL .env.local keys, full fixed ladder (Plan D verified wins terminal; floor/suggestion yields to Go-UPC -> FetchV2 -> GPT). forceRetry on every call (no cache replays).
- Go-UPC usage counter (backend: turso) BEFORE: month=2026-07 used=0. AFTER: month=2026-07 used=2. Delta: 2 (cap <= 10 for the 10-code group; 15 for the rung).
- Known-good GTIN group (10 codes, not in local corpus): 9 verified, 1 suggested, 0 miss/needs_review. Settled by stage:
  - fetchv2: 1
  - single_source: 8
  - goupc: 1
- Non-GTIN group (5 ASIN-shaped codes): gated BEFORE the Go-UPC client by `buildLadderRungs()` -- counter delta reflects only GTIN-shaped calls.
- GPT actuals this run (route-recorded telemetry): $0 (before: $0, after: $0 today).
- Wallet: computed floor = 2 Go-UPC lookups + $0 GPT + any Plan D/FetchV2 Firecrawl credits (not individually metered by the route); true spend = provider consoles (Go-UPC / OpenAI / Firecrawl).
- Pre-fix baseline preserved at `scripts/proof-rung-2-results.pre-fix.json` (delta 0, ladder unreachable).
- Raw: `scripts/proof-rung-2-results.json`.

## Rung 3 (Fetch V2, HARD SET ONLY) -- LIVE (phase 2)

- Sample: 20/20 codes attempted from the 61-code still-unresolved pool (0 skipped by the 150-credit budget guard).
- Rung isolation (real route): GO_UPC_API_KEY blanked (all sample codes are already-proven Go-UPC misses; re-spending ~20 quota lookups proves nothing) and OPENAI_API_KEY blanked (zero GPT spend this rung). Plan D + Fetch V2 run exactly as wired.
- Resolved: 20/20 (100.0%) vs 17.6% baseline -> beats baseline: true. Settled by fetchv2 rung specifically: 0.
- Zero-wrong gate: PASS (0 mismatch candidates; partials flagged for manual adjudication, see rows).
- Wallet: computed worst-case Firecrawl ceiling 60 credits (20 codes x 3); true spend = Firecrawl console.
- Raw: `scripts/proof-rung-3-results.json`.

### Rung 3 ANALYSIS NOTE (read with the section above)

**The 20/20 result is real but it is a CORPUS result, not a Fetch V2 result.** Every sampled code settled via `corpus_exact_barcode` in 7-30ms; the Fetch V2 rung settled 0 codes and spent 0 Firecrawl credits (the 60-credit figure above is the unused worst-case reservation, actual ~0 -- true spend = Firecrawl console). Root cause of the mismatch with the task design: the "61 double-miss codes" were produced by benchmarks that called Go-UPC and Fetch V2 DIRECTLY (`scripts/tmp-fetchv2-goupc-misses.json` records `engine: "fetch_v2_web_only"`), never checking the tire corpus -- but all 74 of those codes have been in `src/server/knowledge.generated.db` (76,173 tire rows, file unchanged since before rung 1) the whole time. Through the REAL route (the T19 integrity rule), the corpus rung answers them before any paid rung can run. That is the ladder working exactly as designed -- but it means this input set cannot exercise Fetch V2 live through the route. A genuine live Fetch V2 proof needs a fresh hard set verified ABSENT from the corpus at run time.
- Zero-wrong gate: PASS trivially (all 20 identities are the corpus rows the truth list was derived from).
- Wallet: computed floor ~0 Firecrawl credits (corpus short-circuits before Plan D and Fetch V2); true spend = Firecrawl console.

## Rung 4 (GPT-5.5 v3 prompt) -- NOT EXECUTABLE THIS DISPATCH (empty input set)

- Rung 4's input is defined as "a 10-code sample of codes rung 3 still cannot resolve." Rung 3 resolved 20/20 (via the corpus, see the analysis note), and all 61 codes of the still-unresolved pool are corpus-resolvable through the real route -- the input set is EMPTY.
- Running GPT on any substitute code list would test an input the phase authorization does not cover, so no GPT call was made. GPT spend this dispatch: $0.00 (route-recorded actuals unchanged; true spend = OpenAI console).
- The rung-4 harness itself is live-ready (actuals-based check-before-spend vs the $3.00 phase cap via the route's own `gptLadder.spentTodayUsd` telemetry, plus the route's identical server-side daily guard); it needs only a real hard-set input: `node scripts/proof-rung-4-gpt.mjs --live --codes=... --port=3108`.

## Phase 2 wallet reconciliation (all rungs)

- Go-UPC: counter delta 2 this phase (Turso `goupc_usage`: 0 -> 2). Phase cap 40: 2 used total. True spend = Go-UPC console.
- GPT-5.5: $0.00 route-recorded actuals across all rungs (baseline $0 today, unchanged). True spend = OpenAI console.
- Firecrawl: computed worst-case ceiling ~12 credits, all from rung 2 (3 Plan D firecrawl-sourced wins + 1 floor-code Fetch V2 discovery + 5 ASIN Fetch V2 discoveries); rung 3 spent ~0 (corpus short-circuit). Well under the 150-credit rung-3 budget and the 300-credit phase cap. True spend = Firecrawl console.
