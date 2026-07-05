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

## Architecture

- `src/services/fetchV2/ladder/gptSearch.ts` - pure service, fetch injected (DI), no React/next
  imports. Builds prompt v2, parses/validates the JSON reply (bad JSON -> contained error ->
  needs_review), maps to the outcome tiers above. Exposes `gptSearchFromScratch(code, deps)`.
- Server route extension (existing `/api/ai-lookup` family): OpenAI key stays server-side; the
  route enforces the 10s abort, the daily cap (worst-case accounting), breaker, emergency stop.
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
- ONE live proof run, owner-approved before execution: the 53-code ladder residue
  (`scripts/fetchv2-ladder-handoff.json`) + the 10 canaries, batched with the same
  grade-vs-truth discipline as the v2.3 campaign. Budget cap ~$7 worst case; canaries must
  produce ZERO auto-counts and ZERO tappable suggestions.
- Playwright: scan an unknown (mocked GPT) -> row shows ladder decode -> auto-count appears;
  count-contract stays green.

## Out of scope

Confirming/upgrading the Suggested pile with GPT (owner chose batch-approve UI instead);
any change to fetchV2's own decision rules; production promotion (preview only until sign-off).
