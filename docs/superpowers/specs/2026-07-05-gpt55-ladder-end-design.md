# GPT-5.5 Ladder End ("search from scratch") - Design

Owner-approved decisions, 2026-07-05. Build 1 of 3 (then: polish structurer, batch-approve UI).

## Goal

When Fetch V2.3 ends a scan with no product identity, GPT-5.5 automatically runs a web search
FROM SCRATCH (input = the code only, zero handoff evidence) and its answer is trusted per the
owner's rule, with production-grade cost protection.

## Owner decisions (locked)

1. **Trigger:** automatic on scan, whenever fetchV2 yields no verified/suggested identity.
   Gated by the existing daily cap, circuit breaker, and emergency stop.
2. **Trust:** NO app-side re-verification of GPT's answer. The gate is GPT's own self-report:
   - `exactCodeFound === true && confidence >= 0.8` -> **Verified + auto-count**.
   - `0.5 <= confidence < 0.8` (or exactCodeFound true below 0.8) -> **Suggested** (one-tap approve).
   - `confidence < 0.5` -> attached to the Needs Review item as background info only, never a
     tappable candidate (canary-proof: prompt v2 always guesses by design).
   - Two deterministic house rules still stand in front of auto-count (they are ours, not a check
     of GPT): the catalog brand-prefix firewall (`prefixBrandConflict`) and the code-type rule
     (X00/FNSKU/vendor codes never verify).
3. **Config (the 21/21 setup, verbatim):** model `gpt-5.5`, Responses API, tool
   `web_search` with `search_context_size: "low"`, reasoning effort low,
   `max_output_tokens: 6000`, **`max_tool_calls: 6`** (owner raised from 5), prompt v2
   (always-best-guess JSON contract: brand/productName/specs/gtin/confidence/exactCodeFound/
   basis/sourceUrls), **10s AbortController cap**.
4. **Cost truth:** a timed-out/aborted call is budgeted at FULL worst case
   (~30K in + 6K out tokens + 6 x $0.01 searches ~= $0.10/code). The daily cap counts worst case
   per attempt, not observed usage. Wallet reports say "computed floor $X; true spend = OpenAI
   console".
5. **Persistent cache (added to this build):** verified results + no-result receipts move from
   process memory / local JSON into the existing SQLite/Turso data layer, keyed by
   `normalized.primary`, so production (serverless) stops re-crawling and re-spending on repeat
   codes. fetchV2's `FetchV2Cache` gets a DB-backed implementation behind the same interface;
   GPT results and GPT no-answers are cached the same way. Receipts remain permanent; only the
   owner's manual force-retry overrides.

## Architecture (reality-corrected 2026-07-05 after recon)

RECON FACT: fetchV2 is benchmark/test-only today - the LIVE ladder is `computeDecode` in
`src/app/api/ai-lookup/route.ts` (corpus -> Turso retail -> Plan D resolveUnknownFast -> AI fast
-> escalation -> deep Stage 2). The GPT-5.5 rung therefore ends THAT ladder; full fetchV2
integration into the live path is a separate future build.

COST FACT (probe-verified pricing): worst case per call = 30K in x $5/M + 6K out x $30/M +
6 searches x $0.01 = ~$0.39. OpenAI usage IS observable per response and max_tool_calls IS
enforceable, so budgets count ACTUALS, with a per-call precheck `spent + 0.39 <= cap`.
Observed probe average ~$0.05-0.09/call.

- `src/services/ai/gptFromScratch.ts` - pure service, fetch injected (DI), no React/next
  imports. Builds prompt v2, parses/validates the JSON reply (bad JSON -> contained error ->
  needs_review), maps to the outcome tiers above.
- Final rung in `computeDecode`: runs ONLY when every prior rung produced neither verified nor
  suggested; key server-side; 10s abort; kill switch + daily counters gate it; IS_E2E forces mock.
- New daily DOLLAR guard for this rung (env `GPT_LADDER_DAILY_USD`, default 3.00) counted at
  actuals alongside the existing call-count cap.
- Scan store integration: fires after fetchV2 returns empty; feed row shows
  "Decoding (ladder)..." then the tiered outcome. A Verified GPT result creates the product,
  writes the permanent alias (idempotency key reused on retry), and auto-counts once.
- Decode queue: scans burst faster than decodes; unknown codes enter a FIFO queue with
  concurrency 1-2 so Brave pacing and provider limits are respected. Counting is NEVER blocked
  by the queue (count-first contract).
- Spend panel: Settings shows today's ladder spend (computed floor), calls made, cap remaining,
  breaker state. Every GPT auto-count is logged with its sourceUrls for later audit; a sampled
  disagreement audit is a weekly-report hook (reports only, never gates).

## Testing / proof gates

- All automated tests mock the OpenAI API (fetch mock / page.route; `IS_E2E=1` forces mock).
  Cases: strong answer auto-counts once (idempotent), 0.6 -> suggested, 0.3 -> review-info only,
  bad JSON, timeout abort, cap exhausted, breaker open, X00 code never calls out,
  brand-prefix conflict blocks auto-count, cache hit skips the call entirely.
- Persistent cache: unit tests on the DB-backed cache (receipt survives "restart" = new instance).
- ONE live proof run (owner pre-authorized in the autonomous-run order): the 10 canaries FIRST,
  then the 53-code ladder residue (`scripts/fetchv2-ladder-handoff.json`), batched with the same
  grade-vs-truth discipline as the v2.3 campaign. HARD budget stop at $7.00 counted from response
  usage actuals with per-call precheck `spent + 0.39 <= 7`; canaries must produce ZERO
  auto-count-tier and ZERO suggested-tier results.
- Playwright: scan an unknown (mocked GPT) -> row shows ladder decode -> auto-count appears;
  count-contract stays green.

## Out of scope

Confirming/upgrading the Suggested pile with GPT (owner chose batch-approve UI instead);
any change to fetchV2's own decision rules; production promotion (preview only until sign-off).
