# Plan D — Cheap-first grounding ladder (barcode DBs + Firecrawl + Gemini URL-Context), cached

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Identify codes that aren't in the corpus as cheaply as possible: barcode-database APIs (free, cached) first; then read a specific page with the cheapest tool (plain fetch → Gemini URL-Context → Firecrawl 1-credit → Google Search grounding last); cheap AI models before expensive ones; never fail to decode (prefix floor). Every win is cached so a code is paid for once, ever.

**Architecture:** Stacks on Plan C (branch off `fix/verified-suggested-model`). The decode entry is `computeDecode()` in `src/app/api/ai-lookup/route.ts`, which already runs corpus checks (tire + retail) before the AI fast-path. Plan D inserts a **barcode-DB tier** after the corpus checks and **rebuilds the "read a page / ground" step** to use the cheapest tool that works, in order. All external calls are wrapped so tests mock them (ZERO real spend in tests). Live calls fire only in production on a cache-miss.

**Tech Stack:** TypeScript, Next.js server route, Vitest (mocked network), Playwright/curl for the limited live preview proof.

## Global Constraints (COST RULES — copy verbatim into every task's attention)

- **Barcode DBs (UPCitemdb + backups):** free/near-free, cached forever. A verified barcode-DB hit COUNTS AS **Verified** (owner decision) and returns before any AI. This is the workhorse.
- **Firecrawl:** **basic scrape = 1 credit** (`/v2/scrape`, markdown, `onlyMainContent:true`, basic proxy). NEVER JSON/LLM-extract mode (5 cr) — WE extract with our own Gemini Flash. Escalate to stealth proxy only if a page blocks. Rotate keys `FIRECRAWL_API_KEY_1..4`, use whichever has credits, **skip any at 0** (check via error 402/429 and fall to next key, then next tier). Use Firecrawl `maxAge` cache + our own cache.
- **Gemini grounding:** when we HAVE a URL, use the **`url_context` tool** (token-only, free on free tier) — NEVER `google_search` for a known URL. Use `google_search` grounding ONLY as the no-URL last resort (free ≤1,500/day, then $35/1k).
- **AI models cheapest-first:** Gemini Flash (`gemini-flash-latest`/`-lite`) → GPT-5 mini → premium (`gemini-2.5-pro`/`gpt-5`, gated `ENABLE_PREMIUM_MODEL_FALLBACK`) only if needed.
- **Cache every win** back to the catalog/store so repeat scans are free Tier-1 hits.
- **Order (cheapest-first, stop on hit):** corpus → barcode DBs → [plain fetch → Gemini url_context → Firecrawl 1cr → google_search] → cheap AI → prefix floor.
- **Tests NEVER call live providers** (mock fetch / SDK). Live only in prod on cache-miss. Preview deploy only; production needs explicit owner sign-off.
- No em/en dashes in user copy. Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Verification Gate (inherited): each task proven (unit; where user-visible, browser) before advancing; loop-until-fixed via systematic-debugging; never advance while red.

## File Structure (implementers confirm exact shapes by reading)
- `src/services/ai/firecrawlProvider.ts` (exists per code map) — rework to cost-optimized 1-credit basic scrape + 4-key rotation + skip-empty.
- `src/services/ai/groundedSpecFinder.ts` (uses `google_search` today) — add a `url_context` path for known URLs; keep `google_search` as no-URL fallback.
- New: `src/server/retail-knowledge/barcodeDbProvider.ts` — UPCitemdb (+ 1 backup) lookup, normalized, returns structured {name,brand,category,sourceUrl}; mirror `retailKnowledgeIndex.ts` patterns + status/observability.
- `src/app/api/ai-lookup/route.ts` `computeDecode()` — insert the barcode-DB tier after corpus checks (before AI fast-path); a hit returns `aiCalled:false`, decision `verified`.
- Caching: reuse the existing catalog/flywheel write path (grep `applyAiCandidate`, `observeScan`, catalog write) so a barcode-DB/decoded win is cached.

---

### Task 1: Firecrawl provider — cost-optimized + 4-key rotation (the paid tier, built cheap)

**Files:** `src/services/ai/firecrawlProvider.ts` (read it first — adapt to its current shape); new `src/services/ai/firecrawlProvider.rotation.test.ts`.

- [ ] **Step 1 (read + failing test):** Read the current `firecrawlProvider.ts`. Write a test (mock `fetch`) proving: (a) a scrape call hits `/v2/scrape` with `formats:["markdown"]` + `onlyMainContent:true` (NOT json mode); (b) key rotation — when key 1 returns 402/429 (out of credits), it retries with key 2, then 3, then 4, reading `FIRECRAWL_API_KEY_1..4` from env; (c) if all keys are exhausted it returns a clean null/"unavailable" (never throws into the scan). Run → FAIL.
- [ ] **Step 2 (implement):** Implement the cost-optimized single-URL basic scrape + the 4-key rotation (skip-empty, fall to next on 402/429). Return the page markdown/text for OUR extractor to read. Add a `maxAge` param for Firecrawl-side cache. Never use json-extract mode. Basic proxy default.
- [ ] **Step 3:** Test green. `npm run test` (0 failures), `npx tsc --noEmit` clean. Commit.

### Task 2: Gemini grounding cost fix — URL Context for known URLs

**Files:** `src/services/ai/groundedSpecFinder.ts` (read first); test.

- [ ] **Step 1 (read + failing test):** Read how grounding is invoked today (`google_search` tool via the Gemini SDK/REST). Write a test (mock the Gemini call) proving: given a KNOWN url, the request uses the **`url_context`** tool and NOT `google_search`; given NO url, it uses `google_search` (the last-resort path). Run → FAIL.
- [ ] **Step 2 (implement):** Add a `url_context` code path used when a candidate URL is available (from a barcode DB / search hit); keep `google_search` only for the no-URL case. Extract the specific fields we need (brand/product) from the response. Keep the cheapest model (Flash) for this read.
- [ ] **Step 3:** Test green. `npm run test`, `npx tsc --noEmit`. Commit.

### Task 3: Barcode-DB lookup tier (UPCitemdb + backup), cached, = Verified

**Files:** new `src/server/retail-knowledge/barcodeDbProvider.ts`; test; wire into `computeDecode()`.

- [ ] **Step 1 (failing test):** Write a test (mock fetch) that `lookupBarcodeDb("848983006257")` returns a structured {name,brand,category,sourceUrl} from a mocked UPCitemdb response, and null on a 200-empty / 429. Include the barcode-variant normalization (mirror `retailKnowledgeIndex.barcodeVariants`). Run → FAIL.
- [ ] **Step 2 (implement):** Implement UPCitemdb trial lookup (`https://api.upcitemdb.com/prod/trial/lookup?upc=<code>`) + ONE backup source behind the same interface (rotate/fallback on 429). Expose a status (hit/miss/rate_limited) like the retail observability. Then wire it into `computeDecode()` AFTER the corpus checks and BEFORE the AI fast-path: on a hit, return a `verified` decode with `aiCalled:false` and the structured identity; cache it via the existing catalog write path.
- [ ] **Step 3:** Integration test (mirror Plan B's `decode-corpus.test.ts`): a barcode-DB hit returns `verified`/`aiCalled:false` with providers never called. `npm run test`, `npx tsc --noEmit`. Commit.

### Task 4: Ladder orchestration + caching (wire it all cheapest-first)

**Files:** `src/app/api/ai-lookup/route.ts` and/or `src/services/ai/decodeOrchestrator.ts` (read first); tests.

- [ ] **Step 1 (failing test):** Write tests proving the ORDER and stop-on-hit: corpus hit → no barcode-DB call; corpus miss + barcode-DB hit → no page-read/AI; barcode-DB miss → page-read tier tried in order (plain fetch → url_context → Firecrawl → google_search) with each mocked; and a cache hit on the 2nd scan of the same code short-circuits to Tier-1. Run → FAIL.
- [ ] **Step 2 (implement):** Orchestrate the tiers cheapest-first with stop-on-first-hit; on any win, write to the cache (catalog) so the next scan is a free Tier-1 hit. Ensure a failure in any tier falls through to the next (redundancy — never fail to decode; end at the prefix floor from Plan C).
- [ ] **Step 3:** Tests green. `npm run test`, `npx tsc --noEmit`. Commit.

### Task 5: Gate + preview + limited live proof

- [ ] **Step 1:** Full `npm run test` (0 failures), `npx tsc --noEmit`, `npm run build`.
- [ ] **Step 2 (controller, careful):** After push, run ONE live curl of a known non-corpus code through the deployed `/api/ai-lookup` to confirm the barcode-DB tier resolves it `verified`/`aiCalled:false` end-to-end. Use a single code (spends ~0-1 credit). Capture output.
- [ ] **Step 3:** Commit; controller pushes for the cumulative preview.

---

## Self-Review
- Firecrawl cheap (Task 1), grounding cheap via URL Context (Task 2) — the two paid tiers built cheap first, as the owner prioritized.
- Barcode-DB workhorse + Verified + cached (Task 3). Cheapest-first ladder + cache (Task 4). Proof (Task 5).
- Already done by A/B/C (do NOT redo): counting, corpus lookup, Verified/Suggested labels, prefix floor.
- Cost rules are the Global Constraints — every task inherits them. Tests mock all external calls: building this spends ZERO real credits.
- Out of scope (YAGNI): paid barcode-API tiers, residential proxies, headless-browser search scraping (killed by the spike). Firecrawl low-credit reality is handled by rotation + skip-empty + cache; not a blocker.
