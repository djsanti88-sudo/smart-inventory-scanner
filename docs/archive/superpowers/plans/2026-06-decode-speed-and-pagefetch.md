# Plan: Decode speed fix + page-fetch hardening + fast-only models

> Structure follows `PLAN_TEMPLATE.md`. On execution this is also saved to the repo at
> `plans/2026-06-decode-speed-and-pagefetch.md` so it can be pasted into other AIs for review.

## 1. Problem / Context  (self-contained — paste this into any AI for feedback)

**The app:** "Smart Inventory Scanner" — a Next.js 16 + TypeScript web app. You scan a product
barcode. If the code is already in the local approved-alias database it counts instantly. If NOT,
the app auto-runs a "live decode": it asks Gemini + OpenAI (with web search) to identify the
product AND opens public barcode-lookup websites server-side (a "page-fetch" step), reads them, and
independently confirms the exact barcode appears on the page. A confidently decoded product is
auto-added to the count; obscure/unidentifiable codes go to a "Needs Review" queue.

**What's broken (two problems):**
1. **Speed is unacceptable.** Server logs show a single decode takes **24 seconds to 4 minutes**.
   The Scan screen sits on "Decoding with AI…" for minutes, so it feels broken. Cause: each unknown
   code stacks, all in the request the user waits on: (a) AI web search, (b) opening ~5 barcode
   pages, and (c) escalating to slow "pro" models (gpt-5 / gemini-2.5-pro) when it can't find the
   code.
2. **Obscure/foreign codes come back empty.** e.g. a China-registered EAN (`6977228152610`, a
   "PHATOIL Lavender Oil") returns "unknown" from both AIs and the page-fetch gets nothing — even
   though the product IS on go-upc.com (a person finds it in seconds). The page-fetch isn't robust:
   barcode sites rate-limit automated requests (429/403), and some serve JavaScript-rendered shells
   where the product loads after the page opens (a plain fetch never sees it).
3. **(URGENT) Junk / wrong / blank product names are being auto-added** — polluting the inventory.
   Observed in the exported `final-counts.csv`:
   - `710154236681` → name = **"UPC Barcode Search — Look up any UPC, EAN, or ISBN"** (that is a
     barcode-LOOKUP-WEBSITE's page title, not a product).
   - `810118139604` → "Wholesale Acrylic Paint Markers Set … **(likely wholesale listing)**" (a
     hedged AI guess saved verbatim).
   - Scanning aspirin → blank product name.
   Root cause: the page-fetch heuristic (`extractTitleProduct` in `pageFetch.ts`) scrapes the
   `<title>`/`og:title` of whatever page it fetched; when the EXACT code is NOT on any fetched page
   it falls back to `pages[0]` and grabs that site's GENERIC title (e.g. go-upc's search page). With
   auto-add on, that garbage gets created + counted. The existing placeholder guard only catches
   "unknown/no match", not website titles or hedged names.

**Goal:** A decode returns in ≤ ~13 seconds (never minutes) using only fast models (Gemini Flash +
GPT-5-mini); the page-fetch reliably reads real product data (structured-data extraction, rate-limit
handling, more sources) so rare/foreign codes decode; and **no junk/website-title/hedged/blank name
is ever auto-added** — anything that isn't a clean, code-verified product goes to Needs Review.

## 2. Current behavior
- `processScan` (`src/stores/scanStore.ts`): unknown code → creates a review (status "Decoding…") →
  fires `liveDecode` → POSTs to `/api/ai-lookup` (mode `decode`).
- Route (`src/app/api/ai-lookup/route.ts`): runs base providers with retries → page-fetch
  (`src/services/ai/pageFetch.ts`: plain `fetch` of go-upc/upcitemdb/etc., strip HTML, verify code)
  → `decideDecode` → **escalates to pro models when no product** → returns.
- Store auto-adds verified/suggested products; conflict or total no-result → review.

## 3. Goals / Success criteria (measurable)
- Decode P95 ≤ ~13s; never > ~15s. Measured via a new `debug.latencyMs` in the response + logs.
- Live path uses ONLY `gemini-flash-latest` + `gpt-5-mini` (Responses API + web_search). No
  gpt-5 / gemini-2.5-pro in the blocking path.
- Common codes (BIC, Camel, Coke) → Verified + auto-added in seconds.
- Obscure/foreign (`6977228152610`) → decoded via page-fetch structured data, OR a fast clean
  "no match" (not a 4-min hang).
- No regressions: 151 unit + 5 E2E green; zero live tokens in automated tests.

## 4. Constraints / non-negotiables
- API keys server-side only; never in the client bundle (existing `keySafety.test.ts` stays green).
- Automated tests never call live providers (mock + `IS_E2E=1`). Live only via `LIVE_AI_TEST=1`.
- Don't break: deterministic alias matching, the auto-add/needs-review rules, scanner focus, Clear
  Cache off the Scan page.
- Be polite to barcode sites (low volume, caching, one short backoff). No heavy headless-browser
  dependency added now (deferred behind a flag).

## 5. Proposed changes

**Priority/order:** **D (URGENT — stop saving junk names) → A (speed) → B (models) → C (hardening).**

**D. Product-name quality gate — never auto-add junk (URGENT)** (`pageFetch.ts`, `decode.ts`, store)
- **Only extract a product from a page that actually contains the exact code** (or a GTIN-13/14
  variant). REMOVE the `pages[0]` fallback in `enrichWithPageFetch` — if no fetched page contains the
  code, return NO product (→ Needs Review), never the first page's generic title.
- **Reject website / generic / error titles** as product names: a blocklist + patterns for
  barcode-site and error titles — e.g. "UPC Barcode Search", "Barcode Lookup", "Look up any UPC/EAN",
  "Go-UPC", "UPCitemdb", "search results", "page not found", "404", "buy …", bare site/domain names,
  "results for", etc. If the extracted/AI name matches → not a product.
- **Reject / clean hedged + low-quality names**: strip trailing parenthetical hedges like
  "(likely wholesale listing)"; reject names whose core is "likely/possibly/maybe/unknown/
  unidentified/no match"; reject empty/blank and absurdly long (> ~120 char) names. Extend the
  existing `PLACEHOLDER_NAME` guard in `decode.ts` into a shared `isUsableProductName(name)` used by
  BOTH the page-fetch extractor and `decideDecode`.
- **Auto-add only a clean, usable name.** If the only candidate name fails the quality gate, the code
  goes to Needs Review (showing the candidate + sources) instead of being silently saved/counted.
- **Clean up existing junk (owner correction: NO new UI):** do NOT add a "remove row" action. The
  existing "Clear cache" (Settings) already wipes learned data — document that as the cleanup path.

**A. Speed — hard time budget + parallelism (CORRECTED: timeout → Needs Review, never partial)** (`route.ts`)
- Wrap the decode in an `AbortController` budget (**hard 13,000ms**); a `setTimeout` aborts it, merged
  with `request.signal`. `Promise.race` alone does not cancel losers — the abort signal does, so pass
  the budget signal into EVERY provider + page fetch (`AbortSignal.any([budget, perCall])`).
- **CORRECTION (owner): on timeout, ABORT all in-flight requests and route the code to Needs Review
  (untrusted). NEVER return a best-so-far/partial result and NEVER auto-add on timeout.** If it is not
  fully verified within 13s, it is untrusted → review.
- Run the 2 providers + N page fetches CONCURRENTLY (`Promise.allSettled`), each with its own short
  timeout (providers ~10s, pages ~5s). Each task catches its own abort/error locally. Concurrency cap ≤3.
- Resolve early ONLY when a verified hit lands (`waitForConfident()` raced against `allSettled`);
  otherwise the budget timer fires → review.
- **Remove the synchronous pro-model escalation entirely** (source of the 4-min tail; no background pass).
- Add `export const runtime = "nodejs"`, `export const maxDuration = 20`, and `debug.latencyMs`.

**B. Models — Gemini Flash + GPT-5-mini only** (`route.ts` + provider modules)
- Base + page-read models = `gemini-flash-latest` + `gpt-5-mini` (Responses API + web_search). Pass
  the abort signal into the provider fetch/SDK calls. Keep env overrides. Remove pro models from the
  decode path.

**C. Page-fetch hardening — the 3 points** (`src/services/ai/pageFetch.ts`)
1. **Source rotation + structured-data extraction.** Keep the prioritized barcode/retail sources
   (go-upc, upcitemdb, barcodelookup, barcodesdatabase, buycott) + the AIs' returned source URLs;
   fetch the top few in parallel. **Extract the product from `<script type="application/ld+json">`
   Product schema and `og:title`/`<title>` in the RAW HTML** — most of these sites embed the product
   in the initial HTML, so this fixes most "JS shell" cases with no browser. Pick the page where the
   exact code (incl. GTIN-13/14 zero-padding variants — already supported) AND a product name appear.
2. **Rate-limit handling.** Detect 429/403/empty → one short backoff (respect `Retry-After`, capped
   inside the 5s budget) then give up politely. Rotate a small set of realistic desktop User-Agents.
3. **JS rendering — NOT in this hotfix (owner correction).** No headless browser (Playwright/Puppeteer).
   Stick to standard `fetch` + structured-data (`ld+json`/`og:title`) extraction from the raw HTML.
- **NO in-memory Map cache (owner correction).** Serverless containers spin down and destroy a
  module-level Map, so do not build a custom TTL cache. Rely on native Next.js `fetch` caching or
  pass through directly.

## 6. Files to touch
- **`src/services/ai/decode.ts`** — extract a shared `isUsableProductName(name)` (item D); use it so
  junk/website/hedged/blank names → needs_review (replaces today's narrow `PLACEHOLDER_NAME`).
- `src/app/api/ai-lookup/route.ts` — budget/AbortController, parallel orchestration, best-so-far
  collector, drop pro escalation, flash-only, `debug.latencyMs`, `runtime`/`maxDuration`.
- `src/services/ai/pageFetch.ts` — **only extract from a page containing the exact code (remove the
  `pages[0]` fallback); reject site/error titles via `isUsableProductName`**; parallel rotation,
  LD+JSON/structured extraction, 429/403 backoff + UA rotation, `Map` cache, deferred headless hook.
- `src/stores/scanStore.ts` — auto-add only when `isUsableProductName(best.productName)`; otherwise review.
  (No UI changes this hotfix — owner correction.)
- `src/services/ai/openaiProvider.ts`, `geminiProvider.ts` — accept + pass an `AbortSignal`; confirm
  fast models.
- `.env.example` — `DECODE_BUDGET_MS`, page timeouts, `ENABLE_HEADLESS_RENDER=false`.
- Tests: `src/services/ai/pageFetch.test.ts` (LD+JSON extraction, 429 backoff→skip, cache,
  code-variant match), route/store behavior; keep store + 5 E2E specs green.
- `plans/2026-06-decode-speed-and-pagefetch.md` (persist this plan), `PROGRESS.md`, `DECISIONS.md`.

## 7. Testing strategy (multiple angles — REQUIRED before I deliver anything)
1. **Unit (mocked fetch, no tokens):**
   - **Name-quality gate (item D):** `isUsableProductName` rejects "UPC Barcode Search — Look up any
     UPC, EAN, or ISBN", "Barcode Lookup", "Go-UPC", "404 / page not found", "(likely wholesale
     listing)" hedges, blanks, and over-long strings; accepts "BIC Classic Pocket Lighter",
     "PHATOIL Lavender Essential Oil". `enrichWithPageFetch` returns NO product when no fetched page
     contains the exact code (regression for the `710154236681` website-title bug). `decideDecode`
     → needs_review when the only name is junk → the store does NOT auto-add.
   - LD+JSON extraction from sample go-upc/upcitemdb HTML; 429 → backoff→skip→next; cache hit avoids
     2nd fetch; GTIN-variant match; time-budget helper returns best-so-far on timeout.
2. **Store + E2E (mocked):** fast decode → auto-add; placeholder name → review; conflict → review;
   scanner focus retained; all 5 existing E2E specs stay green.
3. **Live smoke (`LIVE_AI_TEST=1`), run 2–3× across DIFFERENT code types**, measuring latency +
   outcome each time: US retail (BIC `070330645936`), beverage (`012300197410`), foreign/obscure
   (`6977228152610`), vendor label (X00…), and a made-up/unfindable code (must fast "no match", not
   hang). Re-run to confirm cache + rate-limit stability.
4. **Latency gate:** assert each live decode ≤ ~15s; record numbers in `LIVE_SMOKE_OUTPUT.txt`.

## 8. Risks / trade-offs
- Dropping pro models slightly reduces coverage on the very hardest codes; structured-data + more
  sources compensate, and a 13s answer beats a 4-min one.
- `Map` cache is per-process (lost on restart, not cross-instance) — fine now; Redis later.
- Polite scraping can still be Cloudflare/IP-blocked; caching + low volume mitigate; blocked codes
  go to review fast (acceptable).
- Time-budget partial results must be clearly labeled so a half-baked guess is never auto-added
  (only verified / suggested-with-real-evidence auto-adds).

## 9. Out of scope
- Headless-browser rendering (deferred behind a flag), real DB/Firebase, Amazon Seller API,
  background deepening queue.

## Verification (end-to-end)
- `npm run test`, `npx tsc --noEmit`, `npx next build`, `npx eslint src`, `npx playwright test` —
  all green, no tokens.
- Then `LIVE_AI_TEST=1 npm run live-decode-smoke` run 2–3× across the code types above; confirm
  latency ≤ ~15s and correct outcomes; save output to `LIVE_SMOKE_OUTPUT.txt`.
- On execution, also save this plan to `plans/2026-06-decode-speed-and-pagefetch.md` and update
  `PROGRESS.md` / `DECISIONS.md`.
