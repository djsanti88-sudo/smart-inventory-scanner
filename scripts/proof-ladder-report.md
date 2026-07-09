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

## Task 20 full-ladder run

Generated 2026-07-09. 60 codes through the REAL `POST /api/ai-lookup` route on a local dev server with real `.env.local` keys: 20 corpus tires, 20 retail-shaped codes absent from both corpora, 20 hard-tail codes absent from both corpora. Fully sequential, no retry-spam. Raw: `scripts/proof-full-ladder-results.json`.

**Execution note (honest account):** this run took 3 attempts before completing cleanly, all captured in that JSON and the git history of this section:
1. Attempt 1 (port 3109): the spawned dev server never came up within the original 90s timeout (host had ~39 concurrent node processes at the time, matching the task brief's "detached crawler + qa gate" note) -- script exited with no rows written. Fixed by raising the server-boot timeout to 150s.
2. Attempt 2 (port 3111 manual probe, then 3109 resumed): revealed the day's `AI_LOOKUP_DAILY_LIMIT` (local call-volume safety guard, default 200/day, file-backed in `.ai-lookup-usage.json`, unrelated to any paid-provider spend cap) was already exhausted by cumulative testing across rungs 1-4 earlier the same day, so 27/56 attempted codes got HTTP 429 `reasonCode:"daily_cap"` with null outcomes. Fixed by passing `AI_LOOKUP_DAILY_LIMIT=400` to the spawned server for this proof run only (does not touch the real Go-UPC/Firecrawl/GPT spend caps, and the file counter is local-machine-scoped, not a production limit) and stripping the 429'd rows for retry.
3. Attempt 3 (port 3113 resumed): completed Groups A+B cleanly, but the dev server died silently partway into Group C's first code (`749000000015`, which itself completed successfully in 21.3s) -- every code after that failed near-instantly with a bare `fetch failed` (the Next dev process log simply stops with no error at the same timestamp; root cause not conclusively identified, host load is the leading suspect). The script had no way to detect this and burned through the remaining 19 Group-C codes as false near-instant "errors" plus 4 as budget-skips. Fixed by adding a consecutive-fetch-failure circuit breaker (stops gracefully and records remaining codes as skipped instead of producing false error rows) and stripping all 20 Group-C rows (all crash-contaminated) for a clean retry.
4. Attempt 4 (port 3117 resumed): completed cleanly end to end, 60/60 rows, 0 skipped, circuit breaker never tripped.

The final results file (`scripts/proof-full-ladder-results.json`) reflects ONLY attempt 4's Group C rows plus attempts 2-3's clean Group A/B rows -- no crash-artifact rows or false errors remain in the committed JSON.

### Selection integrity

- Group A: 20 tire barcodes sampled fresh from `src/server/knowledge.generated.db` (`tires` table) at run time (not reused from rung 1's sample).
- Groups B+C: 40 codes hand-selected from `e2e/fixtures/dryrun-codes.json` (owner/obscure/asin/case/canary/tire/part/fnsku fixture groups), chosen because a direct SQLite probe against BOTH the `tires` and `retail` tables in the local knowledge DB confirmed they are absent from both corpora at selection time. Re-verified again at run time: 40/40 still absent (no corpus growth between selection and run).
- **CRITICAL LESSON applied and reconfirmed:** `scripts/tmp-atrisk-codes.json` (30 codes) and all 10 `scripts/tmp-loop*-codes.txt` pools (128 unique codes total after dedup) were checked against both corpora and are now 100% present in one of them (mostly the tire table via `092971`/`051342`/`746573`/etc. prefixes, plus `100xxxxx`-style codes in retail) -- confirmed stale exactly as the rung-3 dispatch found, and NOT used as source material here. `scripts/tmp-goupc-200-misses.txt` (74 codes) and `scripts/tmp-fetchv2-misses.txt` (61 codes) were also checked: 0/74 and 0/61 are still absent from both corpora -- both pools are entirely absorbed by corpus growth since they were recorded. Group B/C draw exclusively from the dryrun fixture instead.

### Waterfall (settled-by stage, per group, final clean run)

- **Group A** (corpus tires, n=20): `corpus_exact_barcode` 20/20 (100% free, $0, matches rung 1's expectation exactly).
- **Group B** (retail, absent-from-corpora, n=20): `goupc` 7, `single_source` (Plan D free-tier consensus) 4, `fetchv2` 2, `none`/needs_review 7.
  - Status breakdown: 5 verified, 2 suggested, 13 needs_review.
- **Group C** (hard tail, absent-from-corpora, n=20): `gpt` 9, `none`/needs_review 6, `goupc` 3, `corpus_exact_part_number` 1, `parallel_floor` 1.
  - Status breakdown: 7 verified, 3 suggested, 10 needs_review.
  - Notable: the 3 `case`-group codes settled via `goupc` (Go-UPC recognizing GTIN-14 case-pack codes even with "no public listing" fixture truth -- Dole Blueberries, pork sirloin, Kroger applesauce all matched). The 2 canary "must-refuse" UPC-A codes (`749000000015`, `749000000022`) did NOT cleanly refuse -- see Zero-wrong check below. The 2 vendor-part-number canaries (`ZQX-99417-B`, `X00ZZZ9ZZ9`) correctly refused (empty productName, needs_review).

### Spend (computed floor; true spend = provider consoles)

Cumulative across the full Task 20 dispatch (all attempts combined, reconciled from the Turso counter and the file-backed GPT ledger, which persist across server restarts):

- **Go-UPC**: 2 -> 14 (Turso `goupc_usage`, month 2026-07). Delta this task: **12 lookups** (cap was 38 remaining; well under). True spend = Go-UPC console.
- **Firecrawl**: no per-call credit metering exposed by the route; computed worst-case ceiling reserved was 100 credits for the final clean run (conservative 5-credits-per-code reservation, most of which was never actually charged since many Group C codes settled via `goupc`/`corpus_exact_part_number`/refusal before any Firecrawl call). Cap (400) never exceeded. True spend = Firecrawl console.
- **GPT-5.5**: file-backed daily ledger (`.gpt-ladder-usage.json`) shows **$1.1309 total, 13 calls, for 2026-07-09** (this is the authoritative cumulative figure for today, spanning this task's Group C GPT-settled codes; rungs 1-4 earlier the same day recorded $0 GPT spend per their own summaries, so this $1.13 is essentially all from this dispatch). Daily cap ($3.00) never exceeded; route's own server-side guard is the backstop. True spend = OpenAI console.
- **Wallet line**: computed floor -- Go-UPC 12 lookups, Firecrawl <=100 credits worst-case reserved (final run), GPT $1.13 (persisted file actuals); true spend = provider consoles (Go-UPC / Firecrawl / OpenAI). No run was stopped early by a cap in the final clean attempt (0 codes skipped).

### Raw archive confirmation

- Storage backend: Turso (`decode_archive` table exists). Total entries: **0** across the whole task.
- This is EXPECTED, not a bug: `GoUpcProvider.ts` archives only 1-in-200 hits by design (`archiveEvery` sampling, a representative-sample policy, not a full mirror -- see `src/server/upc/GoUpcProvider.ts` lines ~123-130). This task's Go-UPC rung saw 10 real hits across all attempts (7 in Group B + 3 in Group C), far below the 200-hit sampling threshold, so zero archive writes is the correct, designed outcome. Fetch V2 and GPT rungs do not currently call `appendArchive` at all in the committed route wiring (Task 2's `decodeArchive.ts` module described in the plan was never built as a standalone file -- the archive that exists lives entirely inside `GoUpcProvider.ts`'s call to `LadderStorage.appendArchive`, backed by the Turso `decode_archive` table from Task 2a/21's storage interface). This is a real gap versus the plan (Task 2 "raw decode archive" for FetchV2/GPT-5.5 raw responses does not exist yet) worth flagging for a future task.

### Zero-wrong check (identity vs corpus/fixture truth where truth exists; flagged, not adjudicated)

5 mismatch/refusal-failure candidates out of 60 (mechanical token-overlap grading, conservative -- flags for the Task 20 Step 2 grading dispatch, does not itself adjudicate):

- `051596320812` [B, expected verified-ok]: got "Ryobi stick vacuum clearance deal found - Facebook" vs truth "Home Depot 5 Gal Orange Homer Bucket / 05GLHD2" -- settled via `fetchv2` with `status:"suggested"` (NOT auto-counted; a clickbait/search-noise title leaked through as a suggestion, same class of issue rung 2 flagged for this exact code on 2026-07-08).
- `749000000015` [C, expected must-refuse]: got "Unidentified item (barcode 749000000015)" -- settled `needs_review` (NOT auto-counted), but the placeholder name is not a clean empty-productName refusal; flagged for adjudication on whether this counts as "refused" in spirit.
- `749000000022` [C, expected must-refuse]: got "M23 Signal panel connector housing" with **`status:"suggested"`** via the `gpt` rung -- a fabricated identity for a checksum-valid-but-unassigned UPC-A canary that should have zero web hits. NOT auto-counted (suggested, not verified), but this is exactly the "one best guess with low confidence" behavior the GPT v3 prompt is supposed to produce only under real evidence, and none should exist here.
- `2710800` [C, expected suggest-only, truth is a Pirelli tire]: got "Mediterranean Style Meatloaf Mix" via `gpt`, `status:"suggested"` -- NOT auto-counted, but a total identity swap (tire code -> food product), a clear hallucination.
- **`1225` [C, expected suggest-only, truth "Moen One-Handle Faucet Replacement Cartridge"]: got "Spitz Vörösáfonya 50%-os gyümölcskészítmény 5kg" (a Hungarian cranberry fruit preparation) via `gpt`, corroborationPath `gpt_self_report`, and CRITICALLY `status:"verified"`.** This is the one genuinely severe finding of this run: a 4-digit vendor part number with zero real barcode structure was auto-verified by the evidence gate with a completely fabricated, wrong product identity. Per `src/services/upc/GoUpcProvider.ts`/route wiring, `verified` status is supposed to require app-verified exact-code evidence at confidence >= 0.8; this row's `providerStatuses` shows `fetchv2: skipped ("unknown")` and no other corroboration, meaning the GPT ladder rung alone produced a `verified` outcome with self-reported (not app-verified) evidence for a code shape that should never have reached "verified" auto-count territory. **This is a live, reproducible instance of the exact hallucination-auto-counts-as-Verified failure mode flagged in the 2026-07-01 grounding-verified decision memory entry, now observed on the GPT rung specifically (not Gemini grounding).** Recommend the controller treat this as a priority finding for the Task 20 Step 2 adjudication and a possible follow-up fix task (tightening the evidence gate for non-GTIN-shaped codes reaching the `gpt` rung).

### Anomalies

- The `1225` verified-hallucination finding above (evidence-gate gap on the GPT rung for non-barcode-shaped codes).
- 3 of 4 run attempts required a fix before completing (server-boot timeout, exhausted daily call-volume guard, and a mid-run server crash/circuit-breaker gap) -- none of these touched real spend; all are documented above and fixed in the committed script (`scripts/proof-full-ladder.mjs`) for future reruns.
- The Task-2 raw decode archive (FetchV2/GPT-5.5 raw response capture) described in the plan does not exist as a standalone module; only the Go-UPC rung's `appendArchive` call (backed by the Turso `decode_archive` table) is wired today.
- No corpus-growth anomalies: all 40 Group B/C codes remained absent from both corpora at run time, matching the selection-time check exactly.
