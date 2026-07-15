# Decode Ladder Improvement Report (2026-07-14)

> Owner questions: is every rung as efficient as it can be, is the GPT rung the best model/prompt,
> are there better new tools, why do leading-zero barcodes fail, and how do we get to
> "never fully unknown" (prefix-level suggestions for everything)?
> Method: full code read of every rung + LIVE empirical probes (owner-authorized, $3 cap) +
> web research (Sonnet subagent, docs only, no signups).
> NOTHING built yet - analysis for the master plan. Companion doc: 2026-07-14-five-aspect-review-findings.md.

## 1. THE LEADING-ZERO BUG - root cause PROVEN (systematic-debugging, Phase 1-3 complete)

Owner symptom: codes with 1-2 leading zeros fail to decode; stripping zeros + Google finds the product.

Live probes (2026-07-14):
- Open Food Facts API: `049000006346` / `0049000006346` / `49000006346` -> ALL HIT (server-side normalization). FREE probe.
- UPCitemdb trial API: same three -> ALL HIT (server-side normalization). FREE probe.
- Go-UPC API: `049000006346` / `0049000006346` -> BOTH HIT (server-side normalization). 2 paid lookups (~$0.02-0.04).
- Tire corpus (`tireKnowledge.generated.json`): `848983006257` HIT, `0848983006257` MISS, `00848983006257` MISS.
  Corpus has 78,202 barcode keys in MIXED lengths: 50,535 x 12-digit, 27,647 x 13-digit, 20 x 14-digit;
  24,350 keys start with '0'.

CONCLUSION: every external provider tolerates zero-padding differences. The misses are OURS:

| # | Sev | Where | Defect |
|---|-----|-------|--------|
| Z1 | CRITICAL | `tireKnowledgeIndex.ts:36` (`normBarcodeKey`) | Strips spaces/hyphens ONLY - no zero-variant handling. Corpus keys are mixed 12/13/14-digit, so a scanner emitting the "other" encoding misses a product the corpus KNOWS. Affects rung 0 (the $0 rung) and therefore poisons everything downstream: the miss falls through to paid rungs or Needs Review. Same-class fix already exists in the repo: `retailKnowledgeIndex.barcodeVariants` (stripped + 12/13/14 padded loop). Best fix: canonicalize keys at corpus BUILD time (one canonical 14-digit key) + canonicalize the lookup; or loop variants like the retail index does. |
| Z2 | HIGH | `fetchV2/normalize.ts:53` | `all = [primary, upcA, ean13, gtin14]` - the zero-STRIPPED short form is NEVER included. Web pages/snippets often print the code without leading zeros (the owner's Google observation); `codeInSnippet` and `snippetEvidence.matchIn` then fail to match, so real evidence is rejected and the rung reports "no usable identity". Also: codes with digits.length < 12 (EAN-8, UPC-E) get NO variants at all (line 43 gate). Fix: add stripped form to `all` + reuse `gtinVariants`. |
| Z3 | HIGH | `decodeCache.ts` (L1) + `decodeCacheStore.ts` (L2) + daily cap | Cache/persist/receipt keys are the RAW code, not `canonicalGtin`. The same product scanned as UPC-A vs zero-padded EAN-13 = two cache entries, two paid ladder runs, two cap slots, and potentially two DIFFERENT verdicts. `canonicalGtin()` exists, is tested, and is production-dead outside Go-UPC's internal cache key. Fix: key L1/L2/receipts by `canonicalGtin(code) ?? code`. |
| Z4 | MED | `gptFromScratch.ts:45` prompt | The literal scanned encoding is passed to GPT; no mention that zero-padded variants are equivalent. GPT may burn its 5 capped searches on the padded form. One sentence ("GTIN zero-padding variants like 00XXXX are the same product - search the shortest form too") likely raises recall on this class. OWNER DECISION needed: touches the "probe parity / no hints" rule - though this is a property of the CODE, not a hint about the answer. |
| Z5 | MED | `ladder.ts:85` GTIN gate + Plan D public gate | UPC-E (8-digit zero-suppressed) is never expanded to UPC-A; its check digit computes over the EXPANDED code, so a scanned UPC-E fails `isValidCheckDigit` -> skips UPCitemdb/OFF/Go-UPC entirely. Camera scan can emit UPC-E. Standard expansion algorithm confirmed (last-digit 0-2/3/4/5-9 rules). Fix: pure `expandUpcE()` before the gate. |

Priority: Z1 (corpus, $0 rung, tires = beachhead) then Z3 (money) then Z2 (recall) then Z5 then Z4.

## 2. GPT RUNG - model + prompt assessment

Current: hardcoded `model: "gpt-5.5"`, `reasoning.effort: "low"`, `search_context_size: "low"`,
`max_tool_calls: 5`, `max_output_tokens: 6000`, 35s timeout, worst-case $0.39/call, actuals billed
from usage + $0.01/search. Prompt v3 (honest-empty; owner probe-validated 21/21, exact-claim 20/21).

What's GOOD (verified): cost caps are the tightest possible on this API; failed/aborted calls billed
at worst case (doctrine-compliant); transient failures never freeze a code; honest-empty prevents
invented products; category always filled (feeds the "never fully unknown" goal).

Improvement candidates:
| # | What | Why | Risk |
|---|------|-----|------|
| G1 | Use Responses API STRUCTURED OUTPUTS (json_schema) instead of "Return JSON only" + regex `{...}` extraction | Eliminates the "model returned non-JSON" failure class entirely (today it's a transient skip = wasted paid call) | None - same answer, guaranteed shape. Does not touch probe parity (format, not content) |
| G2 | Move model name to env (`GPT_LADDER_MODEL`, default gpt-5.5) | "Best version" is an empirical question that changes as OpenAI ships; today re-testing a new model requires a code change | None |
| G3 | Re-run the 21-code probe quarterly (or on any model release) via the EXISTING eval harness before switching | The 21/21 result is the only evidence gpt-5.5 is "the best we've used" - keep it current | Costs one probe run (~$1-2) |
| G4 | Zero-variant sentence in prompt (see Z4) | Direct recall gain on the owner's reported class | Owner decision (no-hints rule) |
| G5 | Do NOT trust `max_tool_calls` alone | Research: documented reliability gap (ignored in deep-research/background mode) + SDK gaps; our 35s abort + worst-case billing is the real backstop and must stay | Keep as-is |

Verdict: the prompt is genuinely well-designed (honest-empty + evidence-graded guessing + always-category).
G1 is the one clear efficiency win; G2+G3 keep "best model" true over time instead of a one-time fact.

## 3. "NEVER FULLY UNKNOWN" - prefix floor status + how to get there

What EXISTS: `prefixFloorName()` ("<Brand> / product unconfirmed") + `prefixIndex` (2 curated seeds +
23,999 derived prefixes from the 4M retail DB + tirePrefixMap for Go-UPC firewall) + barcode anatomy.
It already does what the owner wants... but only on a narrow path.

Gaps to close:
| # | Sev | Gap |
|---|-----|-----|
| P1 | HIGH | The floor only runs inside Plan D, which is gated to upc_a/ean_13/gtin_14. EAN-8, UPC-E, ITF-14 and vendor labels NEVER get a prefix floor. |
| P2 | HIGH | Cap-blocked requests LOSE the floor: `DailyCapExceededError` thrown at pipeline.ts:824 aborts computeDecode and discards `planDStash` - the 429 path returns only the cap message. On a capped day every unknown is a bare "Unidentified item" even when the prefix knows "Goodyear". Fix: catch should return the stash (floor) WITH the honest cap reason. |
| P3 | MED | Coverage skew: 23,999 derived prefixes come from the retail (food-heavy) DB. Good for Nestle-class; thin for tools/auto-parts/tires outside tirePrefixMap. |
| P4 | MED | Amazon-style labels: `detectCodeType` already knows vendor_label/FNSKU/ASIN shapes but the row says generic vendor text instead of "Amazon fulfillment label (FNSKU) - resolve via your Amazon inventory". Zero-cost honesty win. |
| P5 | MED | Brand FAMILIES not surfaced: floor says "BFGoodrich" but not "(Michelin family)". `brandFamilies.ts` exists; annotate the floor name. |
| P6 | LOW | No GS1 authoritative source: Verified by GS1 replaced GEPIR (2024). Web UI is bot-protected; GS1 US Data Hub API = $500/yr + $500 API add-on (owner gate). 30 free searches only. No open bulk prefix->company dataset exists (GS1 data is "public but not open"). Cheapest path: keep deriving from own DBs + curate top consumer prefixes; optionally cache live Verified-by-GS1 lookups on total-miss (ToS check needed first). |

Combined with the existing all-miss reason concatenation, closing P1+P2+P4+P5 achieves the owner's
"at least say WHOSE product it is" for virtually every scannable code, for $0.

## 4. NEW TOOLS RESEARCH (Sonnet agent, docs-only; full detail in agent output)

- KEEP Go-UPC as paid anchor: Digit-Eyes (~$0.0075/lookup but $150/mo commit), Barcode Lookup
  (~$0.02/lookup), Barcode Spider (unpublished pricing = disqualified for a cost-ordered ladder) all
  lose to it. UPCitemdb free tier is actually 100/day (we budget 90 - correct buffer).
- GS1 Verified by GS1: the only authoritative "who owns this prefix" source - fits as a
  brand-owner-only fallback rung, NOT a product rung. $500/yr gate (owner decision). See P6.
- Cappable LLM-search alternatives IF ever wanted: Perplexity Search API (flat $5/1k requests) and
  Tavily (~$8/1k, fixed credits/call) are the only ones with pre-known per-call price = own-code hard
  cap actually works. Exa splits search+contents billing (Gemini-style hidden-unit risk). OpenAI
  `max_tool_calls` has a documented reliability gap - our timeout+worst-case-billing stays the backstop.
- EAN-DB, brocade paid tier, Datakick, POD, Semantics3: UNVERIFIED or defunct - not actionable.

## 5. EFFICIENCY VERDICT PER RUNG (code-read)

| Rung | Efficient? | Notes |
|------|-----------|-------|
| L1/L2 cache | Partly | Raw-code keys (Z3); receipts never expire + run before corpus (finding L1 in companion doc) |
| Tire corpus | NO (Z1) | Exact-string mixed-length keys - the single worst efficiency bug in the ladder |
| Retail index | YES | Has correct variant loop - the reference implementation |
| Plan D | Partly | Grounding arm dead (Gemini ban) so consensus leans on 2 correlated DB votes; floor lost on cap-block (P2) |
| Free rungs (UPCitemdb/OFF) | YES individually | Sequential though (could run parallel); both providers normalize zeros server-side (proven) |
| Go-UPC | YES | Throttle + in-flight dedup + archive; normalizes zeros server-side (proven live) |
| Fetch V2 | Partly | Missing stripped variant (Z2); 25s budget dominates worst-case latency; in-memory cache only (per-instance) |
| GPT-5.5 | YES cost-wise | G1 (structured outputs) is the one clear win; keep 35s/worst-case discipline |
| Cross-rung | NO | No total deadline, no in-flight same-code dedup, cap slot burned on keyless paid phases (companion doc L2/L3/L6) |

## 5.5 NEW FINDING (owner question, 2026-07-14): paid Go-UPC / Fetch V2 wins are NOT durably saved

`classifySourceTier` (pipeline.ts:141-146) persists an L2 "result" only when reasonCode is
"gpt_ladder" OR providerNames contain a legacy marker (gemini/openai/ai-deep/firecrawl...).
"go-upc" and "fetchv2" are NOT in the marker set, so a PAID Go-UPC exact hit or a PAID Fetch V2
verified win (Brave/Firecrawl credits) is never written to the durable L2 decode cache - only the
per-instance L1 memory cache holds it. On another serverless instance / after restart, the SAME code
pays AGAIN (Go-UPC negative cache covers only MISSES, 30d). Nothing paid is merged into the corpus
either. Combined with Z3 (raw-code keys), the app can pay 2+ times for one product today.
Sev: HIGH (money). Fix: add "go-upc"/"fetchv2" to the persist tier (or persist any paid-phase win),
key by canonicalGtin (Z3), and consider a corpus write-back for owner-confirmed decodes.

## 5.6 NEW FINDING (owner question, 2026-07-14): ladder ORDER defect - Plan D runs before the free rungs

computeDecode order is: corpus -> retail -> Plan D (~line 461) -> free rungs UPCitemdb/OFF (~line 801)
-> paid rungs. Plan D internally calls PAID Firecrawl (firecrawlScrapeCheap / searchIdentifyByBarcode)
yet runs BEFORE the two genuinely free rungs - a cost-order violation of the ladder's own doctrine
(free before paid). A code UPCitemdb would have answered for $0 can burn Firecrawl credits first.
Fix: move buildFreeLadderRungs BEFORE Plan D (or fold Plan D's free legs in and defer its paid legs).
Related order defects already logged: receipts replay before the corpus peek (L1), and a free-rung
suggestion stops a cheap paid verification (L4).

## 7. OWNER SESSION DECISIONS + NEW IDEAS (2026-07-14, "just talking" - nothing built)

RATIFIED (owner): PAY-ONCE RULE - every paid decode result MUST be saved so the same code is never
paid for twice. Implementation = the 5.5 fix set: add "go-upc"/"fetchv2" to the L2 persist tier,
key everything by canonicalGtin, and consider corpus write-back for confirmed decodes.

MEROS.IO (owner suggestion; probed live, free):
- It is a free UPC lookup database. Pages: `meros.io/<7-digit-prefix>` = 200 OK, 136KB product
  listings ("UPC Lookup for 0392720#####"); fetchable with our fetchV2Page Chrome UA (the 403 was
  only for bot UAs). Some prefixes 404 (0490000/Coca-Cola) - coverage is partial.
- Fit: a FREE pattern-URL door inside Fetch V2 (its pages print codes + names = snippet-index gold),
  NOT a rung by itself. Data provenance unknown (likely itself aggregated) -> evidence-grade only,
  never truth; EvidenceVerifier + Resolver Trust Rules already enforce that. CHECK ToS before
  production use. No official API found.

PLAYWRIGHT AS A DECODE STEP (owner idea; analysis):
- Framing: Playwright is SELF-HOSTED FIRECRAWL. Firecrawl's paid product is "headless browser +
  anti-bot + proxies as an API"; on mid-tier sites Playwright does the same render for $0 CPU.
- Right shape: NOT a standalone rung - a second FETCHER inside Fetch V2's door system:
  plain fetch (free, ~100ms) -> Playwright rendered fetch (free, 2-5s, JS sites) -> Firecrawl (paid)
  only when both fail. Engine/evidence code unchanged; only the page-getter improves.
- Deployment reality: Vercel functions cannot ship desktop Chromium. Options: @sparticuz/chromium on
  Node functions (works, heavy cold start), a tiny self-hosted render worker (SSRF-guarded), or
  local/batch harvest jobs (the proven DT-harvest pattern) first.
- Honest limit: big-box retailers (Walmart/Target/Amazon: PerimeterX/Akamai) block headless browsers
  - that is precisely what Firecrawl credits buy. Playwright wins on mid-tier sites (barcode
  aggregators, brand/dealer sites) - exactly where the snippet-index insight says barcode evidence lives.

GOOGLE ML KIT (owner link: googlesamples/mlkit iOS vision quickstart):
- ML Kit = on-device barcode SCANNING (image -> digit string), NOT product lookup. The linked repo is
  the NATIVE iOS (Swift) quickstart - unusable in a web app directly.
- We already benefit indirectly: Chrome-on-Android's BarcodeDetector (our camera scan's primary path)
  is backed by Google's same scanning stack; iOS Safari falls back to zxing-wasm as built.
- Advantage today: ~zero for the web app. Real value: IF a native app ships later, ML Kit is the
  right free capture SDK (stronger on damaged/low-light codes).
- Useful idea extracted: OCR FALLBACK for damaged barcodes - when the bars will not scan, read the
  printed human-readable digits (ML Kit Text Recognition natively; tesseract-wasm on web). New idea
  for the capture side of the ladder.

THE RIGHT LADDER ORDER (proposed, supersedes current order; fixes 5.6 + L1 + L4 + free/paid purity):
0. Canonicalize the code (zero variants + UPC-E expansion) - feeds every step below
1. L1 cache (canonical key)
2. Tire corpus + retail index, variant-aware ($0)
3. L2 persisted results + receipts (AFTER corpus, so corpus growth heals frozen codes)
4. Free API rungs IN PARALLEL: UPCitemdb + Open Food Facts
5. Prefix floor computed here (guaranteed "never fully unknown" floor for all outcomes below)
6. Fetch V2 FREE doors: pattern URLs, brocade, meros-style doors, [Playwright rendered fetch]
7. == CAP GATE (first genuinely paid work; charge exactly here) ==
8. Go-UPC (GTIN-gated, ~1 cent exact)
9. Fetch V2 PAID discovery: Brave -> Firecrawl
10. GPT-5.5 (most expensive, always last)
Policy option (owner call): a free-rung suggestion no longer STOPS the ladder before step 8's cheap
exact verify (escalate-past-suggestion). Plan D dissolves into this order: its free legs are steps
2-4, verify-on-page joins 6, paid legs join 9.

## 8. ADDITIONAL IDEAS (pre-master-plan additions, 2026-07-14 - orchestrator proposals, not yet owner-ratified)

| # | Idea | Why it adds accuracy/speed | Cost |
|---|------|---------------------------|------|
| A1 | CROSS-TENANT FLYWHEEL: every human Needs-Review resolution (code->product) feeds the SHARED corpus (anonymized: identity only, never qty/price/tenant), and every verified decode persists prefix->brand learning (prefixIndex already has a "learned_flywheel" source type - in-memory only today). | The compounding moat: each shop's one-time human answer becomes every shop's instant $0 verified decode. Accuracy grows with usage instead of with our crawling. | $0, privacy gate needed |
| A2 | PHOTO-ASSISTED REVIEW: camera scan (already built) snaps ONE product photo alongside an unknown barcode and attaches it to the Needs Review item. | Reviewer resolves visually in seconds instead of guessing from a code string; wrong-identity rate on human resolutions drops (the human sees the actual shelf item). | $0, local storage only |
| A3 | INSTANT BAD-SCAN FEEDBACK: a GTIN-shaped code failing the GS1 check digit gets an immediate "Scan misread - rescan the item" row instead of a doomed 30s ladder run ending in Needs Review. | Misreads happen (dirty labels, angle). Today they waste a full ladder run + a review row; caught at 0ms they cost one rescan beep. | $0, ~20 lines |
| A4 | DECODE OUTCOME LEDGER + AUTO-EVAL HARVEST: persist per-rung outcome/latency/cost per decode; roll up rung precision + cost-per-verified weekly; AUTO-append every production non-decode (and every human override of a decode) to the eval dataset (data/accuracy/). | Institutionalizes "trace every non-decode" as a pipeline instead of a manual habit; thresholds/order become data-driven; the eval set grows from real failures instead of hand-picked codes. | $0 |
| A5 | CASE-PACK (ITF-14/GTIN-14) -> UNIT MAPPING: an indicator-digit >=1 case code resolves to the unit product + pack quantity and offers "add N units". canonicalGtin already keeps case distinct from unit; nothing maps case->unit today. | Warehouse reality: boxes carry case codes. Today a case scan is just another unknown; with mapping it counts N units correctly in one scan. | $0 + corpus field |
| A6 | FREE-QUOTA STEERING: skip UPCitemdb/OFF for codes whose prefix classifies as tire/automotive (they never hit there) - route straight to corpus/Go-UPC. | Saves the 90/day UPCitemdb quota for codes that can actually hit, and cuts 1-2s latency off every tire-shaped unknown. | $0 |
| A7 | ASIN PUBLIC-PAGE DOOR: ASIN-shaped codes (B0...) get amazon.com/dp/<ASIN> as a Fetch V2 pattern URL (public product page); FNSKU/X00 stays honest-labeled (needs seller account, cannot resolve publicly). | Today every Amazon-shaped label is a dead end; ASINs are actually resolvable from the public page for $0. | $0 (bot-wall risk: pairs with the Playwright door) |

Ranked by leverage: A1 (compounding accuracy moat) > A4 (makes all future tuning data-driven) >
A2/A3 (human-loop accuracy + waste kill) > A5/A6/A7 (targeted wins).

## 6. LIVE SPEND THIS TASK

Computed floor: ~$0.02-0.04 (2 Go-UPC lookups). True spend = provider console (per doctrine).
Free: 6 OFF calls, 3 UPCitemdb trial calls (counts against their public trial quota, not our keys).
GPT-5.5: NOT called. Codes probed live: 4 distinct (< 100-code cap). Subagent research: token-only
(subscription). Budget remaining of the $3 authorization: ~$2.96+.
