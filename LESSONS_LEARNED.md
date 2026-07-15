# Lessons Learned

Permanent, hard-won lessons. Each one exists because it actually cost us time or trust. Read this
before touching the decode pipeline or debugging a "this should work but doesn't" report.

---

## L1 - Ground-truth product existence + its source BEFORE changing decode code (2026-06-14)

**What happened.** UPC `810118139604` is a real product (*Acrylic Paint Markers Set, 24 Metallic
Colors, 2mm Bullet Tip, SKU 409-24M*), listed on **faire.com** and findable on Google. The app
returned "Needs Review - No provider returned a usable product." Across many turns I made fix after
fix and never got it to decode. It was resolved only when the owner pasted the Google result proving
the product exists on Faire.

**Why I failed (root causes, owned in full):**
1. **Fixed before I diagnosed.** I changed thresholds/timeouts reactively instead of first proving
   where in the lookup chain it broke.
2. **Asserted absence from weak tools.** I concluded "it's not anywhere" from Bing/DuckDuckGo +
   barcode DBs - weak indexes - instead of doing what the owner did: paste the bare number into
   **Google**.
3. **Didn't reproduce the user's exact action.** The owner's repro was "paste the number into
   google.com." I never did that.
4. **Trusted the app's own generic error.** The app said "no provider returned a product," so I
   believed the product was the problem - when the real problem was that the app *never searched the
   open web and silently swallowed provider failures*.
5. **Let rigor decay over a long session.** Wrong-directory test runs (vitest/tsc in the parent
   folder = false green), stacked reactive changes without one-hypothesis-one-change discipline.

**The rule (do this every time a decode "should work but doesn't"):**
Establish, IN ORDER, before changing any decode threshold/timeout/confidence -
1. Does the product exist online? (Paste the **bare code into Google** - the user's own action.)
2. Which source has it? (Faire / retailer / marketplace - not just barcode DBs.)
3. Did the app actually search that source?
4. Did the app fetch + read it?
5. Did a provider fail / time out / get rate-limited?
6. Did the app hide that behind a generic message?
No guessing. No "it's not anywhere" from weak engines. No fixing step 3-6 before confirming 1-2.

**What's now in the code so this can't silently recur:**
- Per-provider status is captured, never swallowed (`decodeOrchestrator.ts`).
- The open web is actually searched on a Stage-1 miss (`firecrawlProvider.ts`), and AI-cited URLs are
  read (`pageFetch.ts` `extraUrls`).
- Honest reason codes - the app never says "not found" when a provider failed (`decodeFallback.ts`).
- A permanent mocked regression for `810118139604`.

---

## L2 - Always run gates with an explicit project `cd` (no wrong-folder false green) (2026-06-14)

Running `vitest`/`tsc` from `C:\Users\djsan` (the parent) matched 500+ unrelated files / "tsc not
found" and produced misleading output. Every gate runs from `C:\Users\djsan\inventory`, and the
proof run prints `pwd` first. A green result from the wrong directory is not a green result.

---

## L3 - Fix the class of failure, not the one symptom (2026-06-14)

The owner asked for a fix that makes "this class of failure" impossible, not a patch for one barcode.
That is why the hotfix added diagnostics (tell failure modes apart), open-web discovery (search where
the product actually lives), honest reasons (never lie about why), and SSRF safety (because arbitrary
URLs are now in scope) - not just a special-case for `810118139604`.

---

## L4 - Diagnose with separate budgets before blaming "the product" (2026-06-14)

The first hotfix's honest diagnostics were what finally showed the truth: 810118139604 failed live not
because it's unfindable, but because (a) the AI providers timed out at 10s and (b) Firecrawl scraped only
the top 3 results sequentially while the real listing (Faire) ranks #4. The fix was operational, not a
mystery: give the FALLBACK its own deeper budget and parallelism while keeping the fast path fast, and
race the finders so the first verified result wins. Lesson: when a lookup "should work but doesn't,"
instrument each stage with its own timing/coverage signal first - the failure is usually a budget or
coverage gap, not the data. Sequential top-N + a one-size timeout hides both.

## L5 - Cache hard-won lookups so you never re-pay (2026-06-14)

A deep open-web decode costs real time and credits. Once it succeeds, the same barcode must never pay
again. A tiny per-process decode cache (successes only) plus the durable client catalog/alias layer makes
the expensive path a one-time cost per code. Proven: 2nd live call returned in 7ms, cached, zero spend.

---

## L6 - Windows reserves the default Supabase ports (2026-06-14)

`supabase start` failed binding 54322 with "An attempt was made to access a socket in a way forbidden by
its access permissions." That is NOT a port-in-use error - Windows WinNAT/Hyper-V reserves port ranges
(`netsh interface ipv4 show excludedportrange protocol=tcp`), and the default Supabase 542xx ports fell
inside them. Fix: remap all ports in `supabase/config.toml` to 553xx (above every excluded range). Check
the excluded ranges first rather than guessing. (The Supabase stack now lives in
`archive/supabase-foundation/`; the WinNAT lesson applies to ANY local service ports.)

## L7 - This CLI gates `gen types` behind a token even for local (2026-06-14)

`supabase gen types typescript --local` (and `--db-url`) errored with LegacyPlatformAuthRequiredError.
Workaround: set any `SUPABASE_ACCESS_TOKEN` value and use `--db-url` against the local Postgres - it
introspects directly (pulls postgres-meta once). Documented in SUPABASE_SETUP.md.

## L8 - Prove RLS with authenticated clients, never the service role (2026-06-14)

The service role BYPASSES RLS, so a "tenant isolation" test that uses it proves nothing. The real proof
signs in as two normal users and asserts User B cannot read/insert(forged)/update/delete User A's rows.
Service role is fine ONLY for setup/teardown (creating/deleting test users). Encoded as a standing rule.

---

## L9 - Firestore multi-tenant LIST needs path-based tenancy (subcollections) (2026-06-14)

Top-level tenant collections with a rule like `allow read: if isMember(resource.data.businessId)` work
for single-doc `get` but FAIL on `list`/query with "evaluation error" - during query authorization
Firestore evaluates the rule with `resource == null`, so dereferencing `resource.data` throws. The robust
fix is to store business data in SUBCOLLECTIONS `/businesses/{businessId}/...` and derive the tenant from
the PATH wildcard. Then get/list/create/update/delete all enforce `isMember(bid)` uniformly and forged
businessId is impossible. Lesson: design Firestore multi-tenancy around the path, not a resource field.

## L10 - Isolate rules-unit-testing by projectId; don't share one emulator project across files (2026-06-14)

Two test files using the same projectId (+ singleProjectMode) and running in parallel had their
`clearFirestore()` calls race, producing intermittent "evaluation error"/denials. Fix: a unique
`projectId` per test file in `initializeTestEnvironment` (and drop `singleProjectMode`) so each file gets
an isolated emulator namespace. Deterministic and parallel-safe.

---

## L11 - Never compute live-API spend from response metadata; unmeterable units get worst-case reserves (2026-07-05)

Gemini 3 grounding billed ~$6 while the response metadata computed $0.53. Gemini bills EVERY executed
search query ($14/1K) but `webSearchQueries` lists only CITED queries (~3 reported vs ~394 billed) - a
~100x undercount. The rules now (also in the global CLAUDE.md cost-truth rule):
1. Before the FIRST live run on any provider/feature, read the pricing page for per-use fees billed
   outside token counts and verify each billed unit is observable in the response. Not observable =
   UNMETERABLE: budget guards reserve the documented WORST CASE per call, not the observed average.
2. Prefer providers with enforceable tool-call caps (OpenAI `max_tool_calls`). Gemini grounding has NO
   cap control - never run it unattended on hard/unfindable inputs. (This is why Gemini is permanently
   out of the decode ladder.)
3. A client-aborted or timed-out call is still billed server-side - count it at worst case.
4. Reconcile every live run against the provider's billing console BEFORE quoting spend: report
   "computed floor $X; true spend = provider console".

---

## L12 - Charge a usage cap exactly once, inside the paid compute; fast 429s poison mass-scan results (2026-07-09)

`checkAndIncrementDaily` is a side-effecting check: calling it on two paths of one request double-billed
the daily cap, and charging it BEFORE the decode-cache peek made cached zero-spend repeats burn slots.
The counter showed 232/200 when only ~27 paid computes had happened, and every subsequent scan returned
a fast 429 the UI displayed as "Unidentified item". Rules:
1. Exactly ONE cap charge per genuine paid compute, applied INSIDE the paid rung, AFTER the free
   corpus/cache peek. Free hits are never charged.
2. In a mass-scan harness, an all-`other`/~10ms result pattern means CAP EXHAUSTION, not a resolver
   failure - check the counter before concluding anything about decode quality.
3. Cap blocks must surface their honest reason in the UI, never a generic unknown label.

---

## L13 - Server truth can be 99% right while the UI shows 40%; prove through the real UI (2026-07-10)

On a 100-code preview run the SERVER verified 99/100, but the UI counted only 40: every additional size
of an already-verified tire model collapsed into a fuzzy "link to existing product?" review suggestion
(sizes live in `specs*` fields, not in slug product names), plus one false brand-prefix conflict between
Michelin and its own subsidiary BFGoodrich. Neither defect is visible in unit tests or server logs -
only the browser bot run caught them. Rules:
1. The UI proof gate (qa bots / Playwright through the real preview) is NOT optional for
   resolution-path changes; unit green + server logs are insufficient.
2. When merging identities, ask what field actually distinguishes real-world variants (size, pack
   count) and whether that field even appears in the name being compared.
3. Corporate brand families (one company, many brands, many GS1 prefixes) must be modeled from
   evidence, or the firewall rejects a company's own products.

## L14 - A persist version bump can wake dormant migrations (2026-07-12)

**What happened.** The variance feature bumped scanStore persist v6 -> v7. That bump made a
pre-existing product-structuring backfill run for the first time on fresh installs, which leaked a
raw "UPC ... Fits ..." string into the customer-facing Model column. The feature itself was clean;
the bump activated old code nobody was looking at. Caught only because qa:bots ran at the merge gate.

**Rule.** Any persist version bump gets the customer-clean-names bot (and qa:bots:security) run
against a FRESH profile before merge, not just unit tests. Migrations are execution triggers, not
just data reshapes.

## L15 - Idempotency must be proven against the REAL store target (2026-07-12)

**What happened.** CSV import's double-apply test passed against a hand-mocked ImportTarget while
the real buildStoreImportTarget silently dropped the importId parameter - genuine re-uploads were
double-merging quantities. The mock proved the algorithm; the real wiring was broken.

**Rule.** Every idempotency claim needs a test through the real store/component wiring (upload
twice, assert deep-equal state), not only through a mocked target interface.

## L16 (2026-07-15) - Parallel-subagent hygiene on one working tree
- A shared git index races: two agents' commits swept each other's staged files. Rule now standing:
  subagents commit ONLY via pathspec (git commit -m ... -- <files>) and verify git show --stat HEAD.
- Self-check sweeps must include src/app/ (route tests were outside two agents' sweeps and broke silently).
- Background Bash inside subagents may never re-notify them; long verifications belong to the orchestrator.
- Intentional behavior changes (L6, AM-7, A3) each broke sibling tests asserting the OLD behavior; the fix
  is value-level fixture updates with assertions intact - never weakening, never forcing green.

## L17 (2026-07-15) - Request-shape traps on /api/ai-lookup
- The route reads cleanCode/rawCode, never body.code; omitting mode:"decode" routes to LEGACY Gemini lookup
  (3 accidental legacy calls made this session - always read the route contract before curling an API).

## L18 (2026-07-15) - E2E fixture codes must be real GS1
- Any 12-14 digit fixture code in tests must carry a valid check digit now (A3 refuses misreads at 0ms);
  generators should compute the check digit, not hardcode it.
