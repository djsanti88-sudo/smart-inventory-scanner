# Progress Checkpoint

> Update this after every phase. If the session loses context, the next run continues from here
> without guessing. Source of truth for status; the approved plan lives in
> `.claude/plans/ultrathink-role-you-are-kind-allen.md`.

## Current phase
**CONSENSUS CROSS-CHECK DECODE (2026-07-02): auto-count only on 2-source agreement. Owner-validated. Not pushed.**

Branch `fix/grounding-ladder`. SUPERSEDES the earlier grounding-first ladder (which auto-counted
hallucinations - the FINDING 1 revisit-trigger below - and, in a later single-source "trust UPCitemdb"
variant, auto-counted ~40% WRONG on 21 hard codes: a women's dress for Member's Mark water, Oreo for Pico).

- **Design (commit dfc86e3):** for an unknown PUBLIC barcode, `resolveUnknownFast`
  (`src/services/ai/parallelResolve.ts`) queries UPCitemdb (`barcodeDbProvider.ts`, free) + gemini-2.5-flash-lite
  grounding (`flashLiteGrounding.ts`, free <=1500/day) CONCURRENTLY. If the two AGREE on identity (>=2 shared
  distinctive tokens, `identitiesAgree`) -> auto-count, ZERO Firecrawl credits. Only on disagreement, spend ONE
  Firecrawl `/search` (2cr, snippets only, `searchIdentifyByBarcode`) returning barcode-CONFIRMED names from
  real result titles. CONSENSUS (`findConsensus`): auto-count the identity >=2 sources agree on; lone source /
  disagreement -> Needs Review. Firecrawl keys exhausted -> degrade to free signals. Wired in `route.ts` ~L411.
- **Local gate:** 885 unit tests / tsc / eslint (edited files) all green (2026-07-02).
- **Owner-validated live proof:** 21 historically-problematic codes (`e2e/fixtures/owner-problem-codes.json`):
  auto-count 1->18/21, 0 wrong auto-counts, Member's Mark water FIXED. Owner double-checked and confirmed the
  system's decodes were RIGHT and their own expected-sheet had errors. Only genuine miss: Home Depot Homer
  Bucket `051596320812` -> a Hampton Bay fan, but lands in Needs Review (SAFE, not a wrong count).
- **Scale proof (2026-07-02, in progress):** ~190 unique real codes (Open Food Facts + corpus) through the
  ladder + rescans to 500 total. NOTE: the app's daily AI-lookup cap (200, `AI_LOOKUP_DAILY_LIMIT`) is a real
  cost guard - it halted an earlier run; raised locally for the scale test only. [results pending]
- **Cost:** Gemini 2.5 grounding free (1500/day); Firecrawl `/search` 2cr only on disagreement, cached once per
  code, 4 keys x 1000 free/mo. ~$0 cash for typical volume. If 2.5 grounding caps -> `gemini-2.0-flash`.
- **Residual risk:** two sources sharing the SAME bad data can still agree -> a real GS1 prefix-brand firewall
  would close it (`brandPrefixMap.json` is currently tire-focused).
- **RESOLVED (was FINDING 1):** grounding-leg hallucination auto-counts - consensus + refusal rejection + the
  "Error"-title / firecrawl code-gate fixes closed it.
- Preview only. NO production deploy (needs explicit owner sign-off - [[no-deploy-without-asking]]).

---

## Prior phase
**FINAL (2026-06-14): decode reverted to "trust the AI" + fast; strict confidence-gating removed; everything else kept.**

Owner directive: the strict confidence gate was sending good products to Needs Review and slowing scans; restore the
fast "trust the AI" behavior and keep the rest. Net result now:
- **Trust-the-AI gate** (`evidenceScoring.decideAutoVerification`): a decode with a USABLE product name auto-adds +
  counts. Needs Review ONLY for: no usable product, provider/verified-catalog conflict, vendor/internal code, private
  data. Source tier / single-provider / "junk-looking" URL / score are metadata, NOT gates.
- **Fast path** (`decodeOrchestrator`): returns as soon as any provider returns a usable product name (no waiting on
  the slow page-fetch) -> products the AI knows resolve in ~2-3s. Obscure codes the AI doesn't know still use the
  page-fetch (~8s on FIRST scan only); every REPEAT scan is instant via catalog/alias.
- **No "Verified AI Decode + Unknown"**: a decode that doesn't auto-save rewrites the feed badge to needs_review.
- **Reverted** the experimental page-fetch speed tinkering (per-site timeout left at the original 7000ms) - owner
  asked to keep decode "as it was". Catalog learning, cleanup recommendations, feedback, settings all kept.

Proof: 244 unit / 9 E2E / tsc / build / eslint green; live-confirmed the two real codes decode to real products.

### Follow-up (2026-06-14): reliability + speed for COLD decodes (cache cleared each test)
- **Reliability** (`scanStore.liveDecode`): a cold lookup reads external barcode DBs that transiently rate-limit, so
  the same code decoded one moment and failed the next. Now: if the first pass returns no usable product, **retry
  once** (throttle clears). Success path unchanged; only a miss pays for the retry.
- **Speed** (`pageFetch.enrichWithPageFetch`): two changes cut the ~8s tail ->
  (1) **race the fetch** - return the moment a page CONTAINING the exact code arrives, don't block on a slow/hung
      sibling site (all sites still run, so nothing is lost);
  (2) **heuristic-first extraction** - read the code-bearing page's own structured data (ld+json / og:title) and
      SKIP the ~6s model-read unless the page doesn't self-describe (the model-read returned no extra specs anyway).
- **Live result:** the two real codes now decode in **50-186ms** (disk-cached) vs 8020ms before, same correct product
  names, still `verified`. A brand-new (uncached) code is ~2-4s (real fetch) instead of ~8s. Repeat scans stay instant
  via catalog/alias.
- Proof: 247 unit / 9 E2E / tsc / build / eslint green. No live tokens in tests.

---

## Prior phase
**URGENT HOTFIX (2026-06-14): restore fast verified-decode auto-save; kill "Verified AI Decode + Unknown" rows.**

ROOT CAUSE (confirmed): the confidence gate punishes the most common SUCCESSFUL path. A real decode like
`7705471100046` / `816218028015` returns `decision.status:"verified"`, `exactCodeEvidenceVerifiedByApp:true`
(app fetched the page and confirmed the exact code), but is **single-provider** and sourced from a **Tier-3**
barcode DB. In `evidenceScoring.ts` the cap `if (effectiveTier==="supporting" && !independentAgreement) score=min(79)`
forces the score to 79 < 80 -> `planAutoVerify` returns `needs_review` -> no product created/counted. Meanwhile the
scan-feed row's `decodeStatus` was already set to `decision.status` ("verified") in `liveDecode`, so the row shows the
green "Verified AI Decode" badge while Product stays "-" and status "Unknown".

FIX (A + B):
- A (fast path): when the app independently verified exact evidence (`decision.status==="verified"` &&
  `exactCodeEvidenceVerifiedByApp`) and the name is usable, AUTO-VERIFY regardless of tier/single-provider/threshold -
  still blocked only by real blockers (verified-catalog conflict, no usable name, junk source [weak tier], vendor code,
  private data, no exact evidence).
- B (scoring): app-confirmed strong evidence adds points and skips the Tier-3 supporting cap, so the stored score is
  realistic; the cap still applies to weak/AI-only/non-exact evidence.
- UI: when a decode does NOT auto-save, the feed row `decodeStatus` is set to "needs_review" (never leave a
  "Verified AI Decode + Unknown" row). Exact evidence with no usable name -> Needs Review with a clear reason.

---

## Prior phase
**COMPLETE + VERIFIED (2026-06-14): Confidence-based auto-catalog learning + trusted-source verification (speed-first).**
Plan approved with a speed-first correction: score the evidence the decode route ALREADY returns - zero extra network calls, keep the ~3-4s path. Autonomous TDD after approval.

- **Source tiers** `src/services/catalog/sourceTrust.ts` - one configurable map: Tier 1 registries (gs1/gtin),
  Tier 2 major retailers/marketplaces, Tier 3 barcode DBs/unknown, Tier 4 junk (search/cart/login/category).
- **Deterministic evidence score** `evidenceScoring.ts` - 0-100 from evidence (not the AI's confidence number),
  with caps (AI-only <=60, Tier-3-only <=79, Tier-4 <=50). `decideAutoVerification` applies safety/conflict/
  AI-only gates BEFORE the threshold (lowering it can't bypass them).
- **Planner** `catalogAutoVerify.ts#planAutoVerify` - pure; consumes the existing decode response
  (decision + best result + cited source URLs) -> auto_verify | auto_count | needs_review.
- **Store wiring** (`liveDecode`): replaced blanket auto-add with the score gate. Strong (exact-barcode evidence
  + score >= threshold + no conflict + safe) -> auto-saves VERIFIED to catalog + counts, no approval. Tier 1 exact
  = 100, Tier 2 exact = 90+. Weak/conflict/unsafe/AI-only-no-evidence -> Needs Review (with score + reasons);
  a usable-named below-threshold result also writes a PENDING catalog candidate. `autoAddDecodedProducts=false`
  is a master "manual mode" gate (everything -> review). No extra network calls (scoring is synchronous).
- **Catalog/2nd-scan:** an auto-verified barcode resolves on the next scan via local alias/catalog-first with NO
  AI call. AI never overwrites/downgrades a verified entry. Shop override still beats global catalog.
- **Settings:** autoCatalogLearningEnabled (true), autoVerifyConfidenceThreshold (80, UI 70-95),
  trustedSourceAutoVerifyEnabled (true), aiOnlyAutoVerifyAllowed (false). No persist-version bump.
- **Data (additive):** CatalogEntry += autoVerified/autoVerifyReason/evidenceScore/sourceTier/evidenceSummary/
  blockingReasons; CatalogVerifiedBy += "evidence_score"; FeedbackEventType += auto_verified_catalog_entry /
  catalog_candidate_blocked / trusted_source_match; UnknownCodeReview += autoVerifyScore/blockingReasons.
- **UI:** Settings "Auto-catalog learning" section; Needs Review row shows confidence score + blocking reasons.

**Proof (mocked, no tokens):** 238 unit (+28) across 32 files; 8 E2E (+1 `auto-verify.spec.ts`); `tsc`/`next build`/
`eslint` clean. New unit: sourceTrust / evidenceScoring / catalogAutoVerify / autoVerify.store. The E2E proves:
strong scan auto-verifies + counts (no review), exactly ONE decode call, second scan makes ZERO AI calls, weak ->
Needs Review. Policy change (suggested-without-exact-evidence now -> review) updated `autoDecode.test.ts`,
`scanStore.test.ts`, `catalogFirst.test.ts`, and `auto-decode.spec.ts`. Bug caught by TDD: trusted-bonus-off path
reduced tier points but not the cap (a Tier-1 source slipped through at 90) - fixed via an effective-tier used for
both points and caps.

---

## Prior phase
**COMPLETE (2026-06-14): Recommendation-first cleanup + local shared-barcode-catalog foundation + feedback loop.**
Plan presented + owner-approved (with one correction: shop override checked BEFORE global catalog). Autonomous TDD after approval.

- **Local catalog abstraction (no cloud dep).** New `src/services/catalog/` — `catalogTypes`, `catalogProvider` (the
  future-cloud seam), `localCatalogProvider` (pure, offline-first), `sanitizeCatalog`. Lookup order (corrected):
  local approved alias/product (resolver) -> **private shop override** -> shared verified catalog -> weak/AI -> Needs Review.
- **Catalog-first wiring** in `scanStore.processScan`: a verified override/catalog hit resolves + counts with **NO AI call**
  (works offline/no-key). Misses + weak/conflict hits fall to AI. Proven: verified hit -> `fetch` not called.
- **AI never overwrites a verified entry** (`applyAiCandidate` only observes/bumps a verified entry; pending entries only).
  Owner approval -> `upsertVerified`; AI auto-add -> pending. Privacy: global catalog stores only sanitized
  barcode/product/evidence (no businessId/price/notes); shop overrides + feedback are businessId-scoped, never merged up.
- **Feedback loop** `src/services/feedback/` — capped ring-buffer event log (private/local); events recorded for
  catalog/override/AI hits, approvals, rejections, conflicts, cleanup, undo.
- **Recommendation-first cleanup** `src/services/cleanup/recommendations.ts` + `<CleanupRecommendations>` — grouped by
  reason (barcode_lookup_site, store_nav_text, search_result_title, website_title, pre_firewall_junk, orphaned,
  too_generic, low_evidence_ai, duplicate_candidate, conflicts_verified_barcode) with confidence + explanations.
  High-confidence defaults checked, weak/conflict unchecked. Owner presses the final button; JSON backup downloads
  first; Undo restores additively. Store: `applyCleanupSelections(ids)` + reframed `cleanupJunkCounts` (apply all high).
- Settings: new "Shared barcode catalog" status (verified/pending counts) + recommendation-first "Clean up inventory".

**Proof (mocked, no tokens):** 210 unit (+27) across 28 files; 7 E2E (cleanup spec rewritten to the recommendation
flow + budget persistence); `tsc --noEmit`, `next build`, `eslint src` all clean. Screenshot `e2e/proof/cleanup-recommendations.png`.

**Caught mid-build (doctrine clean-env gate):** a `vitest run` executed in the parent dir (C:\Users\djsan) and
discovered 528 unrelated test files (false green). Re-ran with explicit `cd` -> surfaced 3 real bugs (confidence-floor
rejected owner-verified entries; one weak test name). Fixed both. Lesson logged.

---

## Prior phase
**COMPLETE (2026-06-14): A/B/C batch — firewall expansion + configurable decode budget + reversible junk cleanup.**
Operated under the new global doctrine `C:\Users\djsan\.claude\ENGINEERING_DOCTRINE.md` (plan presented + owner-approved before any edit; autonomous TDD after approval).

- **A — firewall expansion** (`decode.ts`): added barcode-aggregator + store-nav strings to `SITE_BLOCKLIST`
  (ean-search, eandata, barcodes.com, gtin lookup, buy upc, product lookup, add to cart, your cart, all
  categories, ...) and mirrored sites into `TITLE_SITE_SUFFIX`. Conservative; real names still pass.
- **B — configurable decode budget**: new `Settings.decodeBudgetMs` (default 13000); Settings UI number
  input (`setting-decode-budget`); `liveDecode` sends `budgetMs`; the route CLAMPS it server-side to
  [5000, 20000] via new pure `decodeBudget.ts` (client cannot request an abusive budget). **No persist
  version bump** (would have wiped learned data) — read defensively with `?? 13000`.
- **C — reversible junk cleanup**: pure `junkCleanup.ts#findJunkCounts` (only removes a product/alias if
  no surviving good count references it); store `cleanupJunkCounts()` (snapshots removed rows) +
  `undoCleanup()` (additive restore, preserves post-cleanup scans); persisted `lastCleanupBackup`.
  Settings "Clean junk product rows" button downloads a JSON backup BEFORE removal, then shows Undo.

**Proof (mocked, no tokens):** 183 unit (+18) / 7 E2E (+2: `e2e/cleanup.spec.ts`) pass; `tsc --noEmit`,
`next build`, `eslint src` all clean. New tests: `decodeBudget.test.ts`, `junkCleanup.test.ts`,
`cleanupJunk.test.ts`, +cases in `decode.test.ts`/`autoDecode.test.ts`. Screenshot `e2e/proof/junk-cleanup.png`.
The junk-PRESENT cleanup path is proven end-to-end in E2E by injecting a v3 localStorage blob (version
matches so migrate is skipped); store tests are the authoritative proof of the cleanup/undo logic.

**Reconciliation:** the earlier hotfix note "No UI changes (no FinalCountTable remove row)" was
superseded by the owner's explicit A/B/C approval (current owner instruction outranks older notes). See
`RECONCILIATION.md`. Risks logged in `RISK_REGISTER.md` (data loss mitigated by backup + Undo; `inventory`
is not a git repo, so those are the only rollback paths).

---

## Prior phase
**APPROVED: decode speed + junk-name firewall + fast-models hotfix** (2026-06). Plan:
`plans/2026-06-decode-speed-and-pagefetch.md` (template: `PLAN_TEMPLATE.md`). Executing via strict TDD.

### Approved corrections (owner)
- Timeout (13s) -> route to **Needs Review** (NEVER return partial / auto-add).
- **No** in-memory module-level Map cache (serverless containers destroy it).
- **No** UI changes (no FinalCountTable "remove row"); backend/store/route only.
- **No** headless browser; standard `fetch` + `ld+json`/`og:title` extraction only.

### Phases (TDD, autonomous loop, exit 0 required)
1. Product-name quality gate (`isUsableProductName`): blocklist website/error titles
   ("UPC Barcode Search", "Barcode Lookup", "Go-UPC", "404", "search results", "page not found"),
   strip/reject AI hedges ("(likely ...)"); pageFetch only extracts from a page containing the EXACT
   code (no `pages[0]` fallback), prefer `ld+json`; junk -> Needs Review, never auto-added.
2. 13s AbortController budget + `Promise.allSettled` concurrency; timeout aborts all -> Needs Review.
3. Fast models only: `gemini-flash-latest` + `gpt-5-mini`; remove gpt-5 / gemini-2.5-pro from sync path.
4. Polite 429/403 (one backoff then skip). No headless. No Map cache.

### Definition of done
- Unit tests prove `710154236681` (website title) + `810118139604` (hedged) -> Needs Review (firewall).
- Unit tests prove the 13s timeout aborts cleanly and returns NO partial data.
- `npm run test` + `npx tsc --noEmit` 100% green (also build/eslint/playwright; no live tokens).

### STATUS: COMPLETE + VERIFIED (2026-06-14)
All 4 phases shipped + a name-cleaning follow-up. Mocked loop: **165 unit / 5 E2E** pass;
`tsc --noEmit`, `next build`, `eslint src` clean; zero live tokens.
- New `decodeOrchestrator.ts`: one `AbortController` 13s budget; providers + page-fetch run
  concurrently and race a `confident` (verified) resolver; on budget-hit it aborts everything and
  returns Needs Review (never partial).
- `decode.ts`: `isUsableProductName` + `cleanProductName` (junk firewall). Follow-up: `cleanProductName`
  now also strips barcode-site title cruft `"... — UPC/EAN <code> — Go-UPC"` / `"... | Barcode Lookup"`
  (the separator class includes the EM dash `—`, which the earlier regex missed); real hyphens and
  parentheticals like `(Texas)` are preserved (unit-locked with the exact live strings).
- `pageFetch.ts`: only extracts from a page containing the exact code (no `pages[0]` fallback);
  `ld+json` prioritized; 429/403 -> one short backoff then skip; UA rotation; signal passthrough.
- `route.ts`: fast models only (`gemini-flash-latest` + `gpt-5-mini`); pro removed from sync path;
  returns `debug.latencyMs` / `timedOut` / `budgetMs`.

### Live proof (LIVE_AI_TEST=1, 3 code types) — see LIVE_SMOKE_OUTPUT.txt
- `070330645936` (BIC): **verified**, fetched_source, **8.0s**, timedOut false.
- `6977228152610` (PHATOIL lavender, previously empty): **verified** via page-fetch, **8.0s**.
- `710154236681` (junk): **needs_review**, productName "" (firewall held), 10.0s, timedOut false.
- Speed: was 24s-4min -> now ~8-10s (under the 13s budget). Early-exit aborts the slow AI calls once
  the page-fetch verifies (smoke shows gemini/openai "not called" because page-fetch won the race).
- Note: the live names above were captured BEFORE the em-dash cruft fix, so they show the
  "— UPC <code> — Go" tail; the fix (unit-proven on those exact strings) yields
  "Exclusive Smokes Bic Lighter Texas" / "Phatoil Lavender Essential Oil ...".

---

## Prior phase
**LIVE UPC DECODE FIXED (web search + grounding)** (2026-06). See LIVE_DECODE_DIAGNOSIS.md + LIVE_SMOKE_OUTPUT.txt.

### Live decode fix summary
- Root cause: providers weren't using web search/grounding (no sources extracted) + ladder buried
  results in blank Needs Review + numeric evidence missed GTIN zero-padding.
- Fixed: Gemini `google_search` grounding (+groundingMetadata extraction); OpenAI Responses API
  `web_search` tool (+url_citation extraction); prompt searches for exact code; ladder = any product
  -> Suggested with sources; EvidenceVerifier matches UPC/GTIN padding variants; no retry on 4xx;
  review shows per-provider results + sources + evidence even when product name empty; GET status +
  POST debug diagnostics; scripts/live-decode-smoke.ts (LIVE_AI_TEST=1 gated).
- Live proof (real calls): 012300197410 -> "Camel Crush Regular Menthol Cigarettes, Box" via OpenAI
  web search, exact code in sources, evidence url_only, Suggested. 070330645936 (BIC) -> OpenAI
  couldn't match confidently; Gemini blocked by 429 quota.
- Honest blockers (owner-side, not app bugs): Gemini key is 429 (out of quota) -> grounding can't run;
  OpenAI web_search returns URLs but few snippets -> evidence stays url_only (not Verified). Fix:
  restore Gemini billing and/or set ENABLE_PREMIUM_MODEL_FALLBACK=true.
- Tests: 141 unit (+decode ladder, +GTIN variant); 5 E2E specs; tsc/build/eslint clean. Live smoke
  run once with explicit authorization; output saved to LIVE_SMOKE_OUTPUT.txt.

---

## Prior phase
**AGGRESSIVE AUTO DECODE MODE COMPLETE** (2026-06). Builds on scanner-focus + evidence work below.

### Auto-decode summary
- Unknown scans now AUTO-run the live decode pipeline (Gemini + OpenAI, app-verified, cross-checked)
  when AI is on and a key is configured - no longer passive Needs Review first.
- Gating (with explicit reasons surfaced on the scan row): AI off, live disabled, auto-decode off,
  emergency stop, offline, missing keys, daily cap, circuit breaker open.
- Server route: GET status (key availability, NO secrets) + POST decode with per-provider retries
  (2x) and premium-model fallback (1x) when weak/conflict. IS_E2E=1 forces mock-only.
- Store: aiStatus + refreshAiStatus + setEmergencyStop + setAiStatus; processScan auto-fires
  liveDecode; liveDecode updates the feed row (Decoding -> Verified/Suggested/Conflict/Needs review)
  + aiStatus.lastAttempt/Provider/Failure.
- UI: feed decode badges (Decoding/Verified AI Decode/Suggested/Conflict); scan-page Auto-decode
  status + missing-keys warning; Settings "Live AI status" panel (mode, gemini/openai configured or
  missing, premium, last attempt/provider/failure, daily count, Emergency stop, Refresh).
- Trust preserved: verified decodes still need human approval unless autoAcceptVerifiedDecodes is on.
  Vendor/FNSKU/internal never auto-verify. Keys server-side only (keySafety.test.ts proves it).
- Tests: 136 unit (incl. 10 autoDecode + key-safety); 5 E2E specs (auto-decode + decode + resolver +
  scan + scanner-focus) all passing; tsc + build + eslint clean. NO live tokens.
- Proof: e2e/proof/auto-decode-01-feed.png, -02-review.png, -03-deterministic.png.
- Manual live test: see MANUAL_LIVE_TEST.md (code 878106003504).

---

## Prior phase
**SCANNER-FOCUS FIX COMPLETE** (2026-06). Builds on evidence-verification work below.

### Scanner-focus fix summary
- Bug: a "Clear Cache" button on the Scan page could hold focus, so the scanner's trailing Enter
  fired its confirm dialog instead of submitting the scan.
- Fix: removed Clear Cache from the Scan page (it lives ONLY on Settings now). The ScannerInput
  already auto-focuses on mount and refocuses after every submit (any result) - that logic is kept.
- Files: src/app/(app)/scan/page.tsx (button removed), src/components/scanFocus.test.tsx (new),
  e2e/scanner-focus.spec.ts (new), e2e/resolver.spec.ts + e2e/decode.spec.ts (clear via Settings now).
- Tests: 125 unit passing (+6 scanFocus); 4 E2E specs passing; tsc + build + eslint clean.
- Proof: e2e/proof/scanner-focus-fix.png. No live AI tokens used.

---

## Prior phase
**EVIDENCE-VERIFICATION + CROSS-CHECK COMPLETE** (2026-06). Builds on the resolver hotfix.

### Evidence/cross-check summary
- AI may claim exactCodeEvidence; the APP verifies independently (EvidenceVerifier). Model self-claim
  never decides truth.
- New pure services: `src/services/ai/{evidenceVerifier,crossCheckEngine,decode}.ts` (+tests).
- Route `/api/ai-lookup` gained "decode" mode (dual provider + server-side verify + cross-check) and
  an `IS_E2E=1` mock-only safety gate. Store gained `liveDecode`. UI shows Verified AI Decode /
  Suggested / Conflict + evidence strength + app-verified flag; "Live decode" button; Settings
  `autoAcceptVerifiedDecodes` (default OFF).
- Trust preserved: "Verified AI Decode" still needs human approval unless owner opts into auto-accept.
- Tests: 119 unit passing; e2e/decode.spec.ts + resolver.spec.ts + scan.spec.ts all passing; build +
  tsc + lint clean. NO live AI tokens used (unit mocks fetch/engines; E2E mocks via page.route + IS_E2E=1).
- Proof: e2e/proof/decode-01-statuses.png, decode-02-approved.png, decode-03-deterministic.png.

---

## Prior phase
**RESOLVER ACCURACY HOTFIX COMPLETE** (2026-06). V1 build below was complete; this hotfix corrects
product-identity accuracy. See RESOLVER_AUDIT.md + FINAL_REPORT.md.

### Hotfix summary
- Bug: AI auto-accept trusted AI guesses as verified identity and persisted them as aliases
  (855724007602->Laird, 078742051451->Leviton, X004DY7YUT->Amazon FBA Label).
- Fix: trust flags (`Product.verified`, `Alias.approved`); deterministic resolver returns Known
  only from approved/verified data; AI is suggestion-only (no auto-save); X00/vendor labels ->
  Needs Review; persist v3 migrate purges poisoned data + "Clear local cache" button.
- Files: src/services/resolver.ts (new), aliasMatcher.ts (gates), codeTypeDetector.ts (vendor),
  types.ts, seed, scanStore.ts, NeedsReviewTable/LiveScanFeed/settings/scan UI; RESOLVER_AUDIT.md.
- Tests: 94 unit passing (TDD red->green), e2e/resolver.spec.ts + e2e/scan.spec.ts both passing,
  build + lint + tsc clean. Proof: e2e/proof/resolver-01..04.png.
- USER ACTION: refresh the browser once so the v3 migrate purges old poisoned localStorage (or
  click "Clear cache" on the Scan screen).

---

## V1 status
**COMPLETE** — all 5 phases done. See FINAL_REPORT.md.

## Overall status
- [x] Phase 0: scaffold Next.js 16 + TS + Tailwind v4 into `inventory/`; install deps
- [x] Phase 1: types + pure services + 49 unit tests passing
- [x] Phase 2: Zustand store + scanner buffer + live feed + final table + sync + CSV + auth + scan page
- [x] Phase 3: Needs Review UI + resolution + products page + settings page
- [x] Phase 4: AI provider abstraction + circuit breaker + sanitized XML prompt + logs + AI route
- [x] Phase 5: Playwright E2E (1 comprehensive test passing) + 9 proof screenshots + final report

## Final results
- Unit: `npm run test` -> 11 files, **80 tests passing**.
- E2E: `npm run test:e2e` -> **1 test passing** (full flow), artifacts in `e2e/proof/`.
- `npm run build` green (routes /, /login, /products, /review, /scan, /settings, /api/ai-lookup).
- `npm run lint` clean. `npx tsc --noEmit` clean.
- Proof: 01-login, 02-scan-before, 03-live-feed, 04-final-counts, 05-needs-review, 06-image-hover,
  08-pending-sync, 09-retry-sync, 10-alias-learned + final-counts.csv (grouped, with scan_event_ids).

## Post-V1 enhancements (live)
- Real Gemini key wired in `.env.local` (gitignored); verified working (Coke UPC -> 0.98 confidence).
- Auto-enrich: enabling AI auto-calls lookup for new unknown codes (gated by cap/breaker/online).
- Auto-accept: confident AI suggestions (>= settings.autoAcceptConfidence, default 0.85, and not
  needsHumanReview) auto-create the product, learn the alias, and count it - no manual review.
  Low-confidence stays in Needs Review. New Settings toggles: autoAcceptAiSuggestions + threshold.
- Distinguishable names: generic/duplicate AI names get the scanned code appended (so each Amazon
  FNSKU stays a distinct row); clean unique names (real barcodes) are left as-is.
- "Create new" review form pre-fills from the AI suggestion.
- Persist bumped to version 2 with a migrate that backfills the new settings into existing stores.
- 83 unit tests passing; lint + tsc clean.

## Exact next command (if resuming for enhancements)
- `npm run dev` then open http://localhost:3000 (login is a local demo button).
- AI is on for the user's browser (persisted). To reset, clear site data for localhost.
- Possible next: Amazon Seller (FNSKU -> ASIN -> product) integration for real FBA-label names;
  prefill richer fields in create form; bulk catalog import.

## Phase 3 + 4 result
- 80 unit tests passing (11 files). `npm run build` green: routes /, /login, /scan, /products,
  /review, /settings, and dynamic /api/ai-lookup.
- Phase 3: NeedsReviewTable (link/create/ignore/AI-lookup per row), review page, products page,
  settings page (wired to updateSettings). Alias learning + offline/retry + CSV already in store.
- Phase 4: circuitBreaker service (+test), ai/{provider,prompt,mockProvider,geminiProvider,
  openaiProvider}.ts, server-side /api/ai-lookup route (sanitizes, provider chain -> mock fallback),
  store.lookupUnknown (gated by enabled/online/daily-cap/breaker; logs; never silent).
  AI defaults OFF and mock; real providers throw "not configured" without a key (no paid calls).

## Next tasks (exact)
1. `npx playwright install chromium` (one-time).
2. Write `e2e/scan.spec.ts`: login -> scan sequence -> grouped counts -> Needs Review ->
   image hover -> CSV export -> pending sync -> retry no-double-count. Screenshots to e2e/proof/.
3. `npm run test:e2e`. Then `npm run test` (units) for the final combined result.
4. Write the final report (required format) + update this checkpoint.

## Phase 2 result
- 71 unit tests passing (10 files). `npm run build` green (Next 16, routes /, /login, /scan).
- Store: full optimistic processScan, pending sync queue, idempotent retrySync, resolveUnknown
  (alias learning), offline/simulate-failure toggles. Components: ScannerInput (buffer proven),
  LiveScanFeed, FinalCountTable, ImageHoverPreview, SyncStatusBar, ExportButtons, badges, Nav,
  AuthGuard, StoreHydrator. Pages: login, scan, (app) layout, root redirect.
- CSV export service done + tested (grouped counts, BOM, injection guard).
- NOTE: build runs via Turbopack; `--no-turbopack` only affected scaffold, dev still works.

## What is complete
- App scaffolded (Next 16.2.9, React 19.2.4, Tailwind v4, Zustand 5, Vitest 4, Playwright 1.60).
- Continuity files: CLAUDE.md, DECISIONS.md, TESTING.md, this file.
- Configs: package.json scripts, vitest.config.ts (projects split), vitest.setup.ts,
  playwright.config.ts (port 3100), .env.example.
- `src/types.ts` — full data model + service value objects.
- Pure services (all framework-free, node-tested):
  scanCleaner, codeTypeDetector, sanitizer, idempotency, aliasMatcher, inventory, mockDb.
- `src/seed/seedData.ts` — 5 demo products (tire x2, beverage, supplement, tool) + aliases.
- **49 unit tests passing** across 7 service suites.

## What files changed (Phase 1)
- CLAUDE.md, AGENTS.md (generated), DECISIONS.md, TESTING.md, PROGRESS.md
- package.json, vitest.config.ts, vitest.setup.ts, playwright.config.ts, .env.example
- src/types.ts
- src/services/{scanCleaner,codeTypeDetector,sanitizer,idempotency,aliasMatcher,inventory,mockDb}.ts
- src/services/*.test.ts (7 files), src/seed/seedData.ts

## What tests passed
- `npx vitest run --project unit` -> 7 files, 49 tests passing.

## Next tasks (exact)
1. Build `src/stores/scanStore.ts` (Zustand + persist, full ScanEvent fields, pending queue).
2. Build `src/stores/syncService.ts` (idempotent retry against mockDb).
3. Build `src/components/StoreHydrator.tsx`, `ScannerInput.tsx`, `LiveScanFeed.tsx`, `FinalCountTable.tsx`.
4. Build `src/app/scan/page.tsx`, auth guard + login, root layout/nav.
5. Add store + component unit tests (dom project). Run `npm run test`.

## Blockers
- None.

## Guardrails (do not violate)
- No deploy. No paid APIs. No real business systems. AI stays mocked unless explicitly approved.
- No keys in client code. No secrets committed.

## Hotfix: decode diagnostics + open-web source discovery (2026-06-14)

### Why
UPC `810118139604` (a real product - *Acrylic Paint Markers Set, 24 Metallic Colors, 2mm Bullet Tip,
SKU 409-24M*, listed on faire.com, findable on Google) repeatedly returned "Needs Review - No provider
returned a usable product." Root causes (verified in code): (a) only 5 hardcoded barcode-DB URLs were
ever fetched - the open web was never searched; (b) AI-cited URLs were never passed to the page reader;
(c) provider errors were silently swallowed (`.catch(() => {})`); (d) one generic message masked every
failure cause (rate-limit, timeout, error, never-searched, genuinely-not-found all looked identical).

### What shipped (fast path UNCHANGED - zero extra calls on success)
- **Per-provider status** (`decodeOrchestrator.ts`): `ProviderStatus` (provider/status/latencyMs/
  errorCode/sourceUrls) captured instead of swallowed; `classifyProviderError` maps 429->rate_limited,
  timeout->timeout, other->error; `recheck()` early-exits on first usable product.
- **SSRF guard** (`urlSafety.ts`, NEW): `isSafePublicUrl` blocks loopback/private/link-local/CGNAT/
  metadata/`file://`/non-http(s)/bare-host/`.local`/`.internal`; `filterSafeUrls` dedupes + caps.
- **extraUrls reader** (`pageFetch.ts`): AI-cited URLs are now read (SSRF-filtered) alongside the
  barcode DBs; a "Product Not Found" page that merely echoes the code is rejected (no false match).
- **Firecrawl Stage-2 fallback** (`firecrawlProvider.ts`, NEW): runs ONLY on a Stage-1 miss, gated by
  `FIRECRAWL_API_KEY` (absent -> `search_provider_unavailable`, decode still works), capped <=3 scrapes,
  provider-cited URLs tried first, every candidate SSRF-filtered, mocked in all tests (zero credits).
- **Stage-2 gate** (`decodeFallback.ts`, NEW): `shouldRunFallback` = no product AND not timed-out AND
  not a conflict AND not E2E -> a normal successful scan adds ZERO extra network calls.
- **Honest reason codes** (`decodeFallback.ts` + route + `scanStore.ts`): `provider_rate_limited`,
  `provider_timeout`, `provider_error`, `product_not_found_after_search`, `search_provider_unavailable`,
  `fallback_discovery_found_product`, etc. The Needs-Review row now shows the server's honest reason -
  it never says "not found" when a provider actually failed/timed-out/was rate-limited.
- **Cheap-only models confirmed**: reader fallback uses `GEMINI_FAST_MODEL` (gemini-flash-latest);
  OpenAI stays gpt-5-mini. Gemini-flash is always the first option.

### Gates (all green, run in C:\Users\djsan\inventory)
- `npx vitest run` -> 35 files, 274 tests passed
- `npx tsc --noEmit` -> clean
- `npx eslint src e2e` -> clean
- `npx next build` -> success
- `npx playwright test` -> 10/10 passed (incl. `decode-diagnostics-open-web-fallback.spec.ts`)

### Proof
`e2e/proof/decode-diagnostics-open-web-fallback.png` - 4 scenarios: fast path (product shows, ONE POST,
no fallback) / Faire-type open-web fallback (810118139604 found + counts) / provider rate-limit (honest
"rate-limited" reason, never "not found") / truly unlisted (`product_not_found_after_search`).

### Pending (owner action)
- Add `FIRECRAWL_API_KEY=fc-...` to `.env.local` (tool-blocked from editing it). Until then the live
  open-web fallback is gracefully disabled (`search_provider_unavailable`); everything else works.
- Optional: one live smoke of 810118139604 after the key is set + dev server restart.

## Hotfix pt.2: deep + parallel fallback with separate budgets (2026-06-14)

### Why
The first hotfix's diagnostics proved 810118139604 still failed live for two reasons: AI providers timed
out at 10s (never cited the Faire URL) and Firecrawl scraped only the top 3 results sequentially (Faire
ranks #4) in 56s. Owner approved a tuning with SEPARATE budgets: keep the fast path fast, give the
fallback real time + coverage.

### What shipped
- **Separate budgets.** Fast path unchanged (~13s, no Firecrawl on success). Fallback runs ONLY on a
  hard fail and gets a deep budget: grounded AI re-run (25s per provider) + Firecrawl, with a ~30s hard
  cap on the whole fallback.
- **Parallel racing fallback** (`fallbackRunner.ts` `raceFinders`): the deep AI re-run (gemini grounded
  + openai mini + page-fetch via the orchestrator with `requireVerifiedEarlyExit`) and Firecrawl run
  CONCURRENTLY; the FIRST verified + usable product wins and the losers are aborted (saves time/credits).
- **Firecrawl tuning** (`firecrawlProvider.ts`): opens up to 6 safe candidates IN PARALLEL; prefers
  product/listing URLs over search/cart/login/category noise (`urlPreferenceScore`); reports
  `coverageMissed` when more results existed than it could open; best-effort credit tracking.
- **Decode cache** (`decodeCache.ts`): a decoded barcode never re-pays for AI/Firecrawl in the running
  server (successes only; failures stay retryable).
- **Reason codes**: added `fallback_coverage_missed`; the generic "no provider returned a usable product"
  is replaced by the honest reason on every needs-review path.

### Gates (C:\Users\djsan\inventory)
vitest 291/291, tsc clean, eslint clean, next build success, playwright 10/10.

### LIVE proof (owner-authorized, see LIVE_FALLBACK_PROOF.md)
810118139604 -> **verified** "Acrylic Paint Markers Set, 24 Metallic Colors" (Faire, SKU 409-24M) in
**16s** (was 66s); Firecrawl won in 6s opening 6 candidates in parallel. Second call **7ms, cached**,
zero spend.

## Phase 1: decode benchmark harness + validation run (2026-06-14)

### Built (approved)
- `src/services/benchmark/benchmarkAnalysis.ts` (+22 unit tests): pure CSV parse, path classifier,
  honest accuracy verdict, latency stats (p50/p95), Firecrawl-credit + AI-call estimators, summarizer.
- `scripts/benchmark-decodes.ts` (`npm run benchmark`): reads `benchmarks/phase1_100_codes.csv`,
  sequential decode via the real `/api/ai-lookup`, records latency/path/verdict/cache/credits, cache
  double-run proof, HARD 400-credit Firecrawl guard, writes csv/json/summary.md/cost.md.
- `benchmarks/` templates (`phase1_100_codes.csv` seeded w/ 4 real codes, `.sample.csv`, `README.md`).
- Route: `debug.firecrawlCreditsEstimated` + `firecrawlCandidates` (reserved worst-case up front so the
  fallback hard-cap can't hide spend from the cost guard).
- E2E `e2e/phase1-benchmark.spec.ts`: fast / fallback / catalog-cache (no 2nd POST) / needs-review /
  not-found -> `e2e/proof/phase1-100-code-benchmark.png`.

### Harness-validation run (4 real codes - NOT the 100-code benchmark; the 100 needs the owner's list)
- fast path: 070330645936 **85ms**, 6977228152610 **101ms** (p50 101ms) - barcode-DB hits, 0 credits.
- fallback: 810118139604 **14.3s** verified via Firecrawl (7 credits).
- not-found: 710154236681 **40s** honest needs_review (7 credits reserved+spent searching).
- cache: **3/3** resolved codes confirmed cached on 2nd call (20-31ms, 0 spend).
- Validation caught + fixed 2 harness bugs: cache-confirmation false-negative; Firecrawl credit
  under-count on cap-abort.
- Finding: 6977228152610 failed under back-to-back load (go-upc rate-limited us) but resolved in 101ms
  clean - fast path depends on barcode-DB availability. Grounded AI providers consistently time out and
  contributed no wins (page-fetch + Firecrawl did the resolving).

### Gates: vitest 313/313, tsc clean, eslint clean, next build success, playwright 11/11.

### Pending owner input
- Drop ~100 real barcodes into `benchmarks/phase1_100_codes.csv` -> `npm run benchmark` for the full run.
- Phase 2 is PLANNED ONLY (PHASE2_TIRE_DB_PLAN.md); not started. Awaiting "approve Phase 2".

## Launch MVP Phase 1: Supabase backend, schema, RLS, Auth, business separation (2026-06-14)

NOTE: the earlier "Phase 1: decode benchmark" entry was the **Lookup Benchmark Sprint** (renamed; see
LOOKUP_BENCHMARK_SPRINT.md), NOT this Launch MVP Phase 1.

Branch: `phase1-supabase-foundation`. Scope = foundation + proof ONLY (scan/count NOT rewired; Phase 2).

### Done
- Local Supabase (CLI + Docker). Ports remapped to 553xx (Windows reserves 542xx). `supabase start` +
  `supabase db reset` clean.
- Migrations: `supabase/migrations/20260614000001_init.sql` (12 tables, every tenant table has
  business_id) + `..._2_rls.sql` (RLS on all tables, is_member/has_role helpers, create_business RPC,
  grants). `supabase/seed.sql` (demo AUTO + TIRE shop, sample products, global catalog).
- Auth: Supabase email/password (`src/lib/auth.ts`, `supabaseClient.ts`, `supabaseServer.ts`,
  `AuthGuard.tsx`, `login/page.tsx`). Guarded E2E bypass (`src/services/auth/authBypass.ts`) - impossible
  in production, proven by `authBypass.test.ts`.
- Business creation + admin/counter membership: `create_business` RPC + `/business` page.
- Typed repositories: `src/services/db/repositories.ts` (+ generated `database.types.ts`).
- Security: service-role key server-only (`server-only` import); `keySafety.test.ts` extended.

### Proof (all PASS, captured in PHASE1_LAUNCH_REPORT.md)
supabase start OK; db reset OK (migrations + seed clean); **tenant-isolation 6/6 via authenticated user
clients**; repositories integration OK; vitest 318 passed / 7 skipped; tsc clean; eslint clean; next
build OK; playwright 11/11 (auth bypass keeps them green).

### Next owner decision
Review the Phase 1 proof. Phase 2 (wire scanStore + count/session mutations onto the repositories,
audit-log writes, alias-approval + CSV on backend) does NOT start until approved.

## Backend pivot: Supabase -> Firebase foundation (2026-06-14)

Owner changed backend direction (already has a Firebase/Google account). Replaced the Supabase Phase-1
foundation with an equivalent, PROVEN Firebase foundation. Branch: `firebase-foundation`. EMULATOR-FIRST,
SECRET-FREE (demo project `demo-smart-inventory`); foundation + proof only (scan/count NOT wired - Phase 2).

### Done
- Deps: +firebase, +firebase-admin, +@firebase/rules-unit-testing; removed @supabase/* + supabase CLI;
  stopped the Supabase Docker stack.
- Firebase config: firebase.json (auth+firestore emulators), .firebaserc, firestore.rules,
  firestore.indexes.json; scripts `emulators` + `test:firebase`.
- Libs: src/lib/firebaseClient.ts (browser, emulator-aware), src/lib/firebaseAdmin.ts (server-only).
- Data model src/services/db/types.ts; subcollection repositories src/services/db/firebase/repositories.ts
  (/businesses/{bid}/...). Auth rewritten to Firebase (auth.ts/AuthGuard/login/business page); kept the
  provider-agnostic authBypass.
- Security: firestore.rules - tenancy by path, owner/admin/counter/viewer roles, append-only audit,
  global catalog read-only, forged-businessId impossible. keySafety.test.ts retargeted to Firebase Admin.
- Supabase removed from runtime (src grep clean) + archived to archive/supabase-foundation/.

### Proof (all green)
Firebase emulator: tenant-isolation 9/9 (authenticated users) + repo round-trip 1/1 = **10/10**.
vitest 318 passed / 10 skipped (emulator tests skip w/o emulator); tsc clean; eslint clean; next build OK;
playwright 11/11 (auth bypass). No secrets committed; .env* git-ignored.

### Deferred (Phase 2)
Wire scanStore scan/count/session onto the Firebase repos; audit writes; alias approval; CSV; member-mgmt
UI; create the real cloud project (`smart-inventory-scanner`) + deploy rules.
