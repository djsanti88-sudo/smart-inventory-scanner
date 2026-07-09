# Risk Register

Per `ENGINEERING_DOCTRINE.md`. Significant tasks log risks here: risk, severity, likelihood, mitigation, approval, status.

## A/B/C batch (2026-06-14)

| # | Risk | Severity | Likelihood | Mitigation | Approval | Status |
|---|------|----------|-----------|------------|----------|--------|
| 1 | Junk cleanup deletes real inventory data; `inventory` has no git safety net | High | Low | Full JSON backup auto-downloads BEFORE removal; persisted `lastCleanupBackup` + in-app Undo; only junk-named, unreferenced rows removed | Owner approved A/B/C plan | Mitigated |
| 2 | Removing a product/alias breaks the deterministic resolver | Med | Low | A product/alias is removed only when no surviving good count references it; snapshot enables exact restore | — | Mitigated |
| 3 | Bumping persist version to add a setting wipes learned data (migrate resets to seed) | High | — | Did NOT bump version; read `decodeBudgetMs` defensively (`?? 13000`) | — | Avoided |
| 4 | Client sets an abusive decode budget (e.g. 10 min) | Low | Low | Server-side clamp to [5000, 20000] in `decodeBudget.ts` | — | Mitigated |
| 5 | Firewall expansion over-blocks a real product name | Low | Low | Conservative phrase/word-boundary patterns; regression test asserts real names still pass | — | Mitigated |
| 6 | Undo overwrites scans made after a cleanup | Med | Low | Undo restores additively (merge by id), never a full-state overwrite | — | Mitigated |

No production systems, paid APIs, new dependencies, or external calls were involved. All proof was mocked/local (no live tokens).

## Shared catalog + recommendation-first cleanup (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Approval | Status |
|---|------|-----|-----------|------------|----------|--------|
| 1 | Private/shop/customer data leaks into the global catalog | High | Low | Type separation (CatalogEntry has no private fields); `sanitizeCatalogEntry` drops unknown fields + masks PII/cost; overrides/feedback are businessId-scoped; leak test | Owner rules #3/#4/#6 | Mitigated |
| 2 | AI overwrites a verified catalog entry | High | Low | `applyAiCandidate` never changes a verified entry's identity/status (observe-only); AI writes pending; dedicated test | Owner rules #1/#2 | Mitigated |
| 3 | Catalog-first wiring regresses scan/auto-decode | Med | Low | Pure `decideLookup` + tests; resolver untouched; catalog consulted only on needs_review; full regression suite green | — | Mitigated |
| 4 | Recommendation engine recommends removing a real product | High | Low | Seed/manual + still-counted products never offered; verified-status gate; weak/conflict default unchecked; backup + Undo + final owner click | Owner Q5/rules #7-9 | Mitigated |
| 5 | False-green tests (wrong working directory) | Med | Observed | Always `cd` into inventory before vitest/tsc/eslint; re-ran correctly and fixed the 3 hidden failures | — | Resolved |
| 6 | Stored URLs unsafe (javascript:/file:) | Low | Low | `safeHttpUrl` restricts catalog URLs to http(s) | — | Mitigated |
| 7 | localStorage growth (catalog/feedback) | Med | Low | Feedback ring-buffer (cap 500); catalog bounded by distinct barcodes; persist try/caught | — | Mitigated |

No cloud dependency added (owner rule #11). No live AI, no deploy, no persist-version bump.

## Confidence-based auto-verify (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Auto-saving a wrong product without approval | High | Low | Deterministic evidence score (not AI's word) + exact-barcode-evidence required + conflict/unsafe gates before threshold + tier caps + never overwrite verified | Mitigated |
| 2 | Added latency / slower scans | Med | Low | Zero new network calls - scoring is synchronous on the existing decode response; decode budget untouched; E2E asserts exactly one decode call + zero on 2nd scan | Mitigated |
| 3 | Over-sending good results to review | Med | Low | Fast path anchored on the existing accurate "verified + exact-evidence" signal; Tier 1/2 exact auto-verifies at 100/90+ | Mitigated |
| 4 | Lowering the threshold bypasses safety | High | Low | Safety/conflict/AI-only gates applied before the threshold; unit-proven at threshold 70 | Mitigated |
| 5 | Behavior change (suggested no longer auto-counts) surprises owner | Med | Confirmed | Approved by owner; 4 tests updated to the new policy; documented | Resolved |
| 6 | Junk/SEO/cart/login source treated as trustworthy | Med | Low | sourceTrust junk-page detection -> Tier 4 (cap 50, blocked); unit-tested | Mitigated |

No cloud dependency, no live AI in tests, no destructive migration, no persist-version bump.

## Hotfix: verified-decode fast path (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Verified decoded products show "Unknown"/uncounted (the reported regression) | High | Was occurring | Fast path auto-saves app-verified exact-evidence decodes regardless of tier/single-provider; regression test + live smoke confirm | Fixed |
| 2 | Fast path lets a wrong product through | Med | Low | Fast path runs AFTER all real blockers (conflict, no-name, junk source, vendor code, private data, no-exact-evidence); only app-INDEPENDENTLY-verified exact evidence qualifies | Mitigated |
| 3 | "Verified AI Decode + Unknown" misleading badge | Med | Was occurring | Feed decodeStatus rewritten to needs_review whenever a decode does not auto-save | Fixed |
| 4 | Speed regression | Med | Low | Scoring stays synchronous; no new network calls; live smoke ~8s (unchanged); 2nd scan zero AI (asserted) | Mitigated |

Live smoke: 2 calls (owner-authorized cap), keys configured, e2e=false. No live tokens in automated tests.

## Hotfix: decode diagnostics + open-web source discovery (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Real products (e.g. 810118139604) stuck in Needs Review because the open web is never searched | High | Was occurring | Stage-2 fallback reads AI-cited URLs then Firecrawl-discovered pages; mocked regression + E2E prove the Faire product now resolves | Fixed |
| 2 | Fast path slowed by the new fallback | High | Low | `shouldRunFallback` runs Stage 2 ONLY on a Stage-1 miss (no product, not timed-out, not conflict, not E2E); E2E asserts exactly ONE POST on a fast-path success | Mitigated |
| 3 | App says "not found" when a provider actually failed/timed-out/was rate-limited | High | Was occurring | Per-provider status captured (no more `.catch(()=>{})`); honest reason codes; `product_not_found_after_search` emitted only after a search was attempted; E2E asserts the rate-limit row never shows "not found" | Fixed |
| 4 | SSRF via arbitrary AI/Firecrawl URLs (internal/metadata/loopback) | High | Possible | Every arbitrary URL filtered through `isSafePublicUrl` before fetch; unit tests cover loopback/private/link-local/CGNAT/metadata/file/non-http(s); E2E-equivalent unit proves Firecrawl never scrapes an unsafe candidate | Mitigated |
| 5 | Firecrawl credits/cost burned (esp. in CI) | Med | Low | Gated by `FIRECRAWL_API_KEY` (absent -> graceful `search_provider_unavailable`); capped <=3 scrapes/failed barcode; ALWAYS mocked in automated tests | Mitigated |
| 6 | Secrets (Firecrawl key) leaked into logs/commits | High | Low | Key read server-side from env only, never logged, never in client; `.gitignore` excludes `.env.local`; `.env.example` lists the NAME only | Mitigated |
| 7 | A "Product Not Found" page that echoes the code is treated as a match | Med | Was possible | Reader rejects not-found pages that only echo the code; requires the exact code AND a usable identity; unit-tested | Fixed |

No cloud dependency in tests, no live AI/Firecrawl in tests, no destructive migration, no persist-version bump.

## Hotfix pt.2: deep + parallel fallback, separate budgets (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Deep fallback slows NORMAL scans | High | Low | Separate budgets: fast path unchanged (~13s, no Firecrawl on success); deep fallback runs ONLY on a hard fail (`shouldRunFallback`); unit + e2e assert no fallback on success | Mitigated |
| 2 | Fallback runs unbounded / 60s+ chains | High | Was occurring | Finders RACE concurrently (not chained); first verified wins, losers aborted; ~30s hard cap (`raceFinders`); live proof 16s (was 66s) | Fixed |
| 3 | Fallback returns a wrong/guessed product | Med | Low | Fallback requires app-VERIFIED exact-code evidence (`requireVerifiedEarlyExit`) + usable identity before it wins; decided on the winner alone to avoid false conflicts | Mitigated |
| 4 | Firecrawl credit/cost blowup (6 parallel scrapes per fail) | Med | Low | Only on hard fails; decode cache means a barcode never re-pays; product-URL preference spends the budget on pages that can carry a product; best-effort credit tracking | Mitigated |
| 5 | Double AI spend (fast pass + deep re-run) | Low | Confirmed | Accepted per owner spec (deep grounded re-run is the point); only on hard fails; cached after first success | Accepted |
| 6 | Stale cache serves wrong product | Low | Low | Cache keyed by exact code; product identity is stable; successes only; per-process (cleared on restart); client catalog is the durable layer | Mitigated |

## Phase 1: benchmark + Phase 2 planning (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Benchmark burns uncontrolled Firecrawl credits | High | Low | Runner tracks credits (reserved worst-case up front) + HARD stop at 400; cache means re-runs re-pay nothing; sequential | Mitigated |
| 2 | Fake/invented benchmark codes misrepresent accuracy | High | Was possible | No invented codes; validated on 4 real codes; accuracy only graded with ground truth; honest verdict buckets | Mitigated |
| 3 | Cost under-counted (cap-abort hides Firecrawl spend) | Med | Was occurring | Reserve credits before the call, refine to actual after; validation caught + fixed | Fixed |
| 4 | Fast path fragile under load (barcode-DB rate limiting) | Med | Observed | Documented finding (6977228152610 failed under load, fine clean); fallback covers it; Phase 2 reduces DB dependence by preloading the catalog | Noted |
| 5 | Grounded AI providers time out, adding latency/cost with no wins | Med | Observed | Documented; Firecrawl + page-fetch carry resolution; recommend owner consider trimming grounded-AI in fallback (separate tuning) | Noted |
| 6 | Phase 2 naive per-barcode scrape => ~35k credits for 5,000 tires | High | Would occur if built naively | Phase 2 PLAN mandates catalog-page harvest + 100-record pilot to measure real per-record cost BEFORE scaling; not executed | Planned/controlled |
| 7 | Phase 2 executed prematurely | High | Low | Hard phase boundary; plan-only doc; no DB/scrape/large Firecrawl; waits for explicit "approve Phase 2" | Controlled |

## Launch MVP Phase 1: Supabase foundation (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Cross-tenant data leak (Business B reads/writes A) | Critical | Was unguarded | RLS on every tenant table (is_member/has_role); proven by 6/6 authenticated-client negative test incl. forged business_id | Fixed |
| 2 | Recursive RLS via helper functions | High | Possible | Helpers SECURITY DEFINER + search_path='' owned by postgres (BYPASSRLS) -> no re-eval of memberships RLS; documented | Mitigated |
| 3 | Service-role key leaked to client bundle | Critical | Low | server-only import on supabaseServer.ts; keySafety.test.ts fails on service-role usage/import/NEXT_PUBLIC in client dirs | Mitigated |
| 4 | E2E auth bypass usable in production | High | Low | NODE_ENV==="production" hard-off; browser needs explicit webServer-only flag; proven by authBypass.test.ts | Mitigated |
| 5 | create_business privilege/bootstrap abuse | Med | Low | SECURITY DEFINER + search_path=''; rejects unauthenticated; atomic business+admin membership; execute granted to authenticated only | Mitigated |
| 6 | Windows port conflicts block local stack | Med | Was occurring | Ports remapped to 553xx (outside WinNAT excluded ranges); documented in SUPABASE_SETUP.md | Fixed |
| 7 | Breaking the 11 e2e specs / scan path via auth swap | Med | Low | E2E bypass; scanStore untouched; full gate sweep green | Mitigated |

## Backend pivot: Firebase foundation (2026-06-14)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Cross-tenant data leak | Critical | Was a concern | Path-based subcollection rules; proven by 9/9 authenticated-user isolation test (read/list/insert/update/delete all blocked for non-members) | Fixed |
| 2 | Forged businessId write | High | Possible | Writes only under /businesses/{bid} you're a member of; bizFieldOk check; proven | Mitigated |
| 3 | list/query auth bypass or breakage | High | Was occurring (top-level) | Subcollections make list rules path-based (no null-resource error); list proven for member + denied for non-member | Fixed |
| 4 | Service account / Admin leaked to client | Critical | Low | firebaseAdmin.ts server-only; keySafety retargeted to Firebase Admin patterns | Mitigated |
| 5 | E2E bypass usable in production | High | Low | NODE_ENV==="production" hard-off; proven by authBypass.test.ts | Mitigated |
| 6 | Half-Supabase/half-Firebase runtime | Med | Was a risk | Supabase removed from runtime (src grep clean) + deps removed + archived; single backend | Fixed |
| 7 | Accidental cloud writes / secrets | High | Low | Emulator-first demo project; no cloud project/deploy; no service account; .env* git-ignored | Mitigated |
| 8 | Windows emulator port conflicts | Low | Low | Auth 9099 / Firestore 8080 / UI 4001 (outside WinNAT excluded ranges) | Mitigated |

## Live AI probe billing (2026-07-05)

| # | Risk | Sev | Likelihood | Mitigation | Status |
|---|------|-----|-----------|------------|--------|
| 1 | Provider bills components invisible in the API response (Gemini grounding queries fired during thinking; only cited ones appear in `webSearchQueries`) -> real spend ~11x computed ($6 vs $0.53) | High | Confirmed | LESSONS_LEARNED L11 + CLAUDE.md cost-truth rule: worst-case reserve for unmeterable units (~$0.28/grounded Gemini call), reconcile with provider console after EVERY live run before quoting spend | Mitigated (process) |
| 2 | Gemini grounding has no max-query cap; unattended runs on hard codes can silently burn budget | High | High on hard codes | Prefer OpenAI `max_tool_calls` for capped tool use; never point Gemini grounding at hard/unfindable code batches unattended; owner-set Google spend cap stays ON as backstop | Open (inherent) |
| 3 | Client-side timeout aborts recorded as $0 while server still bills | Med | Confirmed | Count aborted calls at worst case in budget guards | Mitigated (process) |

## Tire-corpus data quality (2026-07-08, Go-UPC benchmark)

| # | Risk | Sev | Likelihood | Mitigation | Approval | Status |
|---|------|-----|-----------|------------|----------|--------|
| 1 | Corpus row 086699294739 named `pilot_alpin_sport_4_suv` but external evidence + fixture correction say Michelin Pilot Sport 4 SUV (wrong model name would mis-grade/mislabel) | Low | Confirmed | Fix at next tire-corpus regeneration (out of scope for this task) | — | Open |
| 2 | Corpus row 8859305548272 size 265/75R16 vs Go-UPC 245/75R16 (size mismatch) | Low | Confirmed | Fix at next tire-corpus regeneration (out of scope for this task) | — | Open |
