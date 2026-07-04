# Option B Decode Ladder - 150-Code Dry Run (Design)

Date: 2026-07-04
Status: awaiting owner approval
Owner budget cap: **$15.00 hard** (live AI spend for this dry run, guard-enforced in code)

## Goal

Prove or kill the "Option B" decode ladder BEFORE building it into the app, using a standalone
probe over ~150 ground-truthed codes. Both owner requirements must hold simultaneously:

1. **Never count a wrong product.** Zero wrong auto-counts across the whole run. One wrong
   verified result = the gate is redesigned before anything ships.
2. **Few items stuck in Needs Review.** Maximize the share of findable codes that end Verified.

## The ladder under test (per unknown code)

1. **Gemini 3.5 Flash** names the product (~$0.008, 3-8s). Usually right, usually unproven
   (Round 3 measured: it skipped searching on 20/21 codes, so its answers carry no evidence).
2. **Cheap app-side verification** (~free, 2-8s): barcode DBs + fetch of the candidate product
   page; PASS = the exact (normalized) code found in real page text per the REAL
   `EvidenceVerifier` rules (url-only counts only on the existing trusted-host allowlist;
   "not found" pages rejected).
3. **gpt-5.5 escalation** (~$0.07, 4-30s, `search_context_size: low`, reasoning `low`,
   `max_tool_calls: 5`) ONLY when step 2 fails. Its citations feed the same verifier.
4. Still unverified -> Suggested / Needs Review with the best guess attached (prompt v2:
   always return a best guess, flagged `exactCodeFound: false`, confidence <= 0.4).

Auto-count gate (unchanged from production rules): public barcode + app-verified exact-code
evidence + confidence >= 0.8 + no prefix-firewall conflict. Provider self-claims are never
trusted; only app-side verification decides.

## Code-type rules (owner decisions 2026-07-04)

- **ASIN (B0...)**: NEW RULE - fetch `amazon.com/dp/<ASIN>`; a real product page loading =
  deterministic identity proof -> **verified, auto-counts**. A code appearing only in a URL
  still proves nothing (URLs are constructible from any code); the page must actually load as
  a real product page (not 404/search/"not found").
- **FNSKU (X00...)**: publicly unverifiable BY DESIGN (warehouse label private to one seller's
  account; no public Amazon page exists). Expected outcome: **good suggestion, auto-count
  forbidden**. Human approval once -> permanent alias -> deterministic forever.
- **Vendor part numbers**: never treated as public barcodes; win condition = correct identity
  as suggestion + correct refusal to auto-count (identity may verify later via human approval).
- **Public UPC/EAN/GTIN-14**: verified-ok expected where evidence exists.
- **Canaries (nonexistent codes)**: must refuse - any verify on a canary is a run-level FAIL.

## Test set (~150 codes, all sourced/curated by Claude; owner provides nothing)

| Group | ~N | Truth source | Expected outcome |
|---|---|---|---|
| Owner problem codes | 21 | `e2e/fixtures/owner-problem-codes.json` (1 row re-verified: 00016000179998 flagged Mott's-vs-Cheerios) | mixed |
| Fake canaries (invented UPCs + part numbers + X00s) | 10 | by construction | must-refuse |
| Tire barcodes + tire part numbers | 20 | project tire-knowledge corpus | verified-ok / suggest-only |
| Vendor part numbers (tools, filters, auto parts) | 25 | official manufacturer catalogs, multi-source | suggest-only |
| Amazon ASIN | 8 | live amazon.com product pages | verified-ok (new rule) |
| Amazon FNSKU (X00...) | 7 | repo history + representative real-world examples | suggest-only |
| UPC/EAN incl. foreign (EU/Asia prefixes) | 35 | retail knowledge DB (Turso), spot-checked | verified-ok |
| GTIN-14 / ITF-14 case codes | 12 | derived from known products, spot-checked | mixed |
| Club/store-brand obscure | 12 | curated, multi-source | mixed |

Every row: `{code, codeType, truth, expected: verified-ok | suggest-only | must-refuse, source}`.
Ground-truth quality rule: every truth claim multi-source verified during curation; a code whose
truth cannot be defended is replaced, not guessed (the fixture-error incident is the precedent).

## Metrics and pass/fail gates

| Metric | Gate |
|---|---|
| Wrong auto-counts (incl. canaries verifying) | **0, hard fail otherwise** |
| Auto-count rate on findable public codes | >= 70% target |
| Cheap-verify (step 2) success rate | >= 50% = Option B builds; < 40% = fall back to Option C (gpt-5.5-first); between = owner call |
| Wrong suggestions presented above confidence 0.4 | 0 (weak guesses must be flagged weak) |
| Avg cost per code | expect $0.02-0.05; report actual |
| Latency p50 / p95 per stage and end-to-end | report; informs UI copy |

Per-group scorecards (the FNSKU/part-number groups are graded on identity quality + refusal
correctness, not on verification rate).

## Mechanics

- Standalone script(s) in `scripts/` (tmp- prefix), run via tsx/vitest node context so the REAL
  `EvidenceVerifier` + trusted-host + code-type logic from `src/services` is exercised, not a
  reimplementation. No app code changes. No deploys.
- $15 hard budget guard, same pattern as rounds 1-4: cost recomputed from billed usage after
  every call; conservative per-code reserve; stops before any code that could bust the cap.
- Keys: GEMINI_API_KEY + OPENAI_API_KEY from `.env.local` (server-side pattern, never printed).
- Sequential-with-parallelism identical to prior probes; results JSON checked into `scripts/`.
- All fetches obey existing SSRF rules (public hosts only, timeouts, size limits).

## Deliverables

1. `scripts/tmp-ladder-dryrun-results.json` - full per-code, per-stage results.
2. Summary report in chat: per-group scorecard, the 6 gate metrics, build/no-build verdict.
3. PDF report second edition (rounds 1-4 + dry run) in `reports/`.
4. Spend report (actual vs $15 cap).

## Out of scope

- Building the ladder into the app (separate plan after a PASS + owner approval).
- Any deploy, preview or production.
- Live testing through the UI (that comes with the build, via the existing QA bots).

## Decision record

- Owner requires accuracy AND low review load; accuracy is the hard floor.
- Gemini 3.5 Flash chosen as first stage on price ($0.008/code measured) despite no-evidence
  answers; the app's own cheap verification supplies the missing evidence.
- gpt-5.5 chosen as escalation (Round 2: 21/21 usable, always-cited, $0.071/code measured).
- gpt-5.5-pro, gemini-3.1-pro, gemini-2.5-flash-lite, claude-sonnet-4-6 rejected (cost or
  hallucination behavior, Rounds 1/3/4). claude-haiku-4-5 noted as viable third-provider
  fallback (Round 4) - not part of this design.
- ASIN verified-by-page-fetch rule added at owner direction 2026-07-04; FNSKU remains
  suggest-only because public verification is impossible, not merely risky.
