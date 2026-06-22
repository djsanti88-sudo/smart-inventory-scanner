# Decode improvement plan (analysis only — nothing implemented here)

> Companion to `ARCHITECTURE.md` (the real flow) and the eval harness (`src/eval`, baseline in
> `eval-baseline.md`). Recommendations are prioritized by **impact ÷ effort** and grouped by the only three
> levers we have (we do NOT train the models): **prompt**, **retrieval/grounding**, **verification**. Each
> item lists expected impact (against the baseline) + effort + the safety invariants it must not break.

## Baseline (what "better" is measured against)

From `npx vitest run src/eval/eval.test.ts` (mock/offline, representative single-provider page-fetch):

| metric | baseline | target |
|---|---|---|
| identity accuracy (tires) | **100%** | hold ≥100% |
| auto-count rate (of should-auto) | **33%** | 70–90% |
| FALSE auto-count (poison) | **0%** | stay **0%** (hard invariant) |
| specs extracted (tires) | **89%** | ≥95% |

The auto-count gap is the headline: identity is right 100% of the time, but only **33%** auto-count. Why, in
code terms (cited in ARCHITECTURE §4): every decode is effectively **single-provider** (only the page-fetch
returns within the 13s budget; `crossCheckEngine.ts:57-66` → `single_provider`), so the only way to
auto-count is the deterministic **tire corroboration** path (`decode.ts:119-128`), which fires *only* when
the code is in a **STRONG prefix family** AND full specs are present. Codes outside the strong family
(Continental 051342, Nexen 8807622, Goodyear 697662 in the baseline) decode correctly but land at
`suggested` → Needs Review.

## Priority ranking (impact ÷ effort)

| # | Recommendation | Lever | Impact | Effort |
|---|---|---|---|---|
| P0 | (e) Flywheel/deterministic-first to skip AI | retrieval | High (cost/latency) | **S** |
| P1 | (a) Genuine two-provider cross-check | verification | **High** (auto-count 33→~60%+) | **M** |
| P2 | (c) RAG provider grounded in tire data | retrieval | **High** (auto-count + identity) | **L** |
| P3 | (b) Prompt-engineering upgrades | prompt | Med (specs 89→95%+, fewer poisons) | **S–M** |
| P4 | (d) Evidence strictness hardening | verification | Med (keeps FALSE@0 as yield rises) | **S** |

---

## (a) Why decodes are single-provider, and the fix — **P1**

**Root cause (cited):** `decodeProviders()` pushes both Gemini + OpenAI (`route.ts:87-88`), but within the
~13s budget / 10s per-provider timeout (`decodeOrchestrator.ts:98-99`) the grounded models (`gemini-flash-latest`,
`gpt-5-mini`) usually do not return a usable, code-bearing product in time; only the deterministic
page-fetch lands. `crossCheck(a=page-fetch, b=null)` → `single_provider` (0.4) → `decideDecode` suggested
branch → `0.92×0.6 = 0.552` (`decode.ts:158`), below the store's `≥0.9` gate (`scanStore.ts:1603`).

**Fixes (in priority order):**
1. **Treat page-fetch as a first-class agreeing source.** Today page-fetch is one of the three sources but
   the "two-source agree" check still effectively waits for two *model* providers. Make `crossCheck` count
   **page-fetch + ONE model** that land on the same identity as a genuine `agree` (they are independent:
   one is our own retrieval, the other is a grounded model). This converts many single-provider decodes
   into two-source `agree` → `verified`. *Impact: large (most correct identities have a page-fetch source
   already). Effort: M. Invariant: still requires the exact code app-verified in BOTH sources; never one
   source alone.*
2. **Budget/latency rebalance so a second source actually returns.** The fast models rarely finish in 13s
   with grounding. Options: (i) raise the per-provider budget for ONE model only; (ii) run a cheaper
   non-grounded "read the page-fetch text" model as the reliable second opinion (we already have
   `pageReader`, `route.ts:97`). A second independent read of the SAME fetched page that agrees on identity
   is a legitimate cross-check. *Impact: high. Effort: M.*
3. **Make the 0.552 honest.** The flat number is `maxConfidence×0.6`; once a real second source exists the
   `agree` branch yields `0.6+0.4·nameSim` (`crossCheckEngine.ts:101`) which clears `≥0.9` for strong
   matches. No threshold change needed — just get the second source.

*Expected: auto-count 33% → ~60%+ (the strong-family-only constraint is removed for two-source agreements);
identity unchanged; FALSE auto-count stays 0 because both sources must app-verify the exact code.*

## (b) Prompt-engineering upgrades — **P3**

Current prompt (`prompt.ts:38-99`) is already strong (bare-code-first search, exact-code trust, tire-spec
requirement, anti-poison tire hint, semantic firewall). Upgrades:
1. **Strict output schema + one retry on malformed JSON.** Today JSON is scraped from free text
   (`geminiProvider.ts:69`, `openaiProvider.ts:73`); a non-JSON answer silently becomes `{}` and *causes*
   single-provider. Add a single "return ONLY the JSON object" retry when parse fails (Gemini can't use
   `responseMimeType=json` with tools, but OpenAI Responses supports a JSON schema). *Impact: med (recovers
   lost second sources). Effort: S–M.*
2. **Force the speed-rating token for tires.** The one baseline miss (`029142815167`, specs `-`) is a
   truncated speed rating. Strengthen the rule to "tire specs are INVALID without a trailing speed letter
   (e.g. 120R, 115T)" and have the page-reader re-extract it. *Impact: specs 89→~95%. Effort: S.*
3. **Sharper anti-poison / exact-code instruction.** Add: "If the page says the scanned code is NOT valid
   or suggests a DIFFERENT code, return needsHumanReview=true and confidence≤0.3 — never adopt the other
   code's product." Mirrors the EvidenceVerifier invalidation guard at the prompt layer. *Impact: defense
   in depth on poison. Effort: S. Invariant: complements, never replaces, the verifier.*
4. **Inject the prefix-family hint more decisively (still non-authoritative).** When `isBrandInPrefixFamily`
   resolves a strong family, tell the model the expected brand to *confirm or refute with evidence* — raises
   the chance both sources agree. Effort: S.

## (c) RAG provider grounded in authoritative tire data — **P2**

**Goal:** a retrieval-augmented provider that grounds identity in OUR data, so decodes don't depend on a
flaky public web search. It implements the existing **Provider port** (`AiProvider` / `DecodeProviderPort`,
`src/services/decode/contract.ts`) and registers alongside Gemini/OpenAI/page-fetch — no pipeline rewrite.

- **Seed corpus (already in the repo):**
  - the **tire prefix table** `src/services/tire/tirePrefixHints.ts` (71 prefixes → brand families, strong/
    weak tiers) — maps a code's GS1 company prefix to the manufacturer.
  - the **catalog flywheel**: every human-approved or app-verified decode writes a `CatalogEntry`
    (`upsertVerified`/`applyAiCandidate`, `scanStore.ts:2031-2036`) keyed by normalized barcode → name/brand/
    specs. This is a growing, verified, code→product corpus.
- **Where more corpus comes from:** (1) approved Needs-Review resolutions (human-labeled gold); (2)
  auto-verified two-source decodes; (3) periodic ingestion of manufacturer spec sheets / a licensed tire
  catalog into the same `CatalogEntry` shape. The flywheel compounds: more scans → more verified entries →
  more deterministic hits → fewer AI calls.
- **Retrieval shape:** for a scanned code, (1) exact normalized-barcode lookup in the catalog (deterministic
  hit → no AI at all); (2) prefix-family lookup → candidate brand; (3) embed the catalog's product
  text and retrieve the nearest verified products for the brand+size to ground the model ("here are
  known <brand> tires; identify which the scanned code is"). The RAG provider returns an `AiLookupResult`
  whose `verifiedFacts`/`sourceUrls` cite the corpus, so the **same EvidenceVerifier still independently
  confirms the exact code** — RAG never bypasses verification.
- **Plug-in:** add `createRagProvider()` implementing `AiProvider`; push it into `decodeProviders()` as a
  THIRD agreeing source. A catalog exact-hit can short-circuit before any model call (see P0).

*Expected: auto-count 33% → 80%+ as the catalog grows (most repeat tires become deterministic), identity
robustness up (grounded in verified data, not web noise), AI cost down. Effort: L. Invariant: RAG output is
still evidence-verified + firewall-gated; a corpus entry is never auto-trusted as identity truth without the
exact-code check.*

## (d) Evidence strictness — **P4**

As yield rises (P1/P2), keep FALSE auto-count at 0:
1. **Require the exact scanned code in the WINNING source's real text** (already true: `evidenceVerifier.ts`
   exact-numeric + invalidation guard). Keep it; add a test that any new provider (RAG) is held to the same
   bar. Effort: S.
2. **Do not let a catalog/RAG hit substitute for the exact-code evidence** — a corpus match proposes
   identity; the verifier must still confirm the code in real evidence. Document this as a contract
   invariant (already in `src/services/decode/README.md`). Effort: S.
3. **Keep `TRUSTED_HOSTS` narrow** (`route.ts:56`); never trust url_only on code-echoing crowd DBs. Effort: 0.

## (e) Cost / latency cuts (deterministic + flywheel-first) — **P0 (do first, cheapest)**

1. **Catalog exact-hit short-circuit before any AI call.** If the scanned normalized barcode is already a
   verified `CatalogEntry`, resolve deterministically and skip the whole `/api/ai-lookup` decode. This is
   the flywheel paying off and the single biggest cost/latency win for repeat inventory. *Impact: high
   (eliminates AI calls for known codes). Effort: S — the catalog + lookup already exist
   (`decideLookup`, `scanStore.ts:1076`); make the auto-count path trust a verified catalog hit the same way
   it trusts a corroborated decode.*
2. **Prefix-family pre-filter** to avoid Stage-2 Firecrawl when the family already says "not a tire we
   stock" — saves the reserved `1+6` Firecrawl credits (`route.ts:274`). Effort: S.
3. **Persist the in-memory decode cache** (`decodeCache.ts` is per-process, lost on restart) to the catalog
   so cache survives restarts and is shared. Effort: M.
4. **Drop the redundant page-reader model call** when the page's own structured title already yields full
   specs (the fast-path already prefers the heuristic title, `pageFetch.ts:253-255`) — verify no model call
   fires for clean barcode-DB titles. Effort: S.

---

## Sequencing

1. **P0** (catalog short-circuit + cache→catalog) — cheapest, immediate cost/latency win, builds the
   flywheel substrate RAG needs.
2. **P1** (page-fetch + one model = genuine two-source agree) — biggest auto-count jump for the least code.
3. **P3** (prompt: JSON retry + speed-rating + anti-poison) — recovers lost second sources, lifts specs.
4. **P2** (RAG provider on the Provider port) — the durable, compounding identity win.
5. **P4** (evidence strictness tests for new providers) — keep FALSE auto-count at 0 throughout.

Re-run `npx vitest run src/eval/eval.test.ts` after each to watch the baseline move; add real captured
fixtures (and run `npm run eval-decode -- --live` occasionally, within the cap) to keep the harness honest.

## Non-negotiable invariants (every item above must preserve)

- Two-source **agree** OR full tire corroboration to auto-count; single source on weak evidence never
  auto-counts. The exact scanned code must be app-verified in real text. Firewall blocks non-tire in tire
  context. Poison `745125495781` stays Needs Review. Customer-privacy gate unchanged. These are enforced by
  the four safety tests + the eval harness's FALSE-auto-count==0 assertion.
