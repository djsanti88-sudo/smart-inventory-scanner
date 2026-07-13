# Task 3.3 + 3.4 Report: Free API Ladder Rungs (UPCitemdb + Open Food Facts)

Worktree: `C:\tmp\wt-rungs`, branch `feat/free-rungs`. Not pushed.

## Step 0: ToS verdicts (exact quotes)

### UPCitemdb (Task 3.3)

Fetched: `https://devs.upcitemdb.com/`, `https://devs.upcitemdb.com/termsofservice`,
`https://www.upcitemdb.com/wp/docs/main/development/api-rate-limits/`, `https://www.upcitemdb.com/api`.

Rate limits (FREE / keyless trial plan), quoted from the rate-limits doc:
- **"total of 100 combined requests per day"** with SearchRequest capped at 40/day.
- **"limited up to 6 requests per minute"** (burst).
- Rate limiting basis: **per IP address**.

Commercial-use language, quoted from the main API page (`upcitemdb.com/api`):
- **"We suggest you not to sign up for the paid plan during your evaluation or development phase."**
- No explicit clause anywhere (main docs, `/termsofservice`, rate-limits page, or the API page)
  restricts the FREE plan to evaluation/non-commercial use only, and no clause prohibits
  production/commercial use of the free tier. The only distinguishing language between free and
  paid tiers is about REQUEST VOLUME/CAPACITY, not permitted use case.
- Attribution: the only attribution-adjacent text found was **"Affiliate links are removed from
  most product offers in the paid plans"** (about the paid plan's offer links, not about a
  requirement to attribute UPCitemdb when using the free tier). No linkback/attribution
  requirement was found anywhere in the fetched pages.

**Verdict: PROCEED.** No terms found that forbid commercial use of the keyless trial tier. No
attribution/linkback requirement was found. Built the rung with a conservative self-imposed local
cap of 90/day (10% buffer under the documented 100/day limit) and 5s timeouts, since the free tier
is explicitly volume-limited even though not use-case-limited.

*Caveat for the human record:* multiple WebFetch passes over UPCitemdb's docs did not surface a
single canonical "Acceptable Use" clause the way OFF's docs do - the absence-of-prohibition
conclusion rests on checking the four most likely pages (home/docs, ToS, rate-limits, API/plans)
and finding no restriction on any of them, not on a single authoritative "commercial use: allowed"
sentence. If the owner wants a harder guarantee before this rung goes to production traffic at
scale, the recommended next step is emailing UPCitemdb support to confirm in writing.

### Open Food Facts (Task 3.4)

Fetched: `https://world.openfoodfacts.org/data`, `https://openfoodfacts.github.io/openfoodfacts-server/api/`.

License, quoted:
- Database: **Open Database License (ODBL 1.0)**.
- Contents: **Database Contents License (DBCL 1.0)**.
- Images: **Creative Commons Attribution ShareAlike 3.0** (not used by this rung - we ignore
  images/nutrition/ingredients entirely; only name/brand/category are read).

User-Agent requirement, quoted:
- Required format: **"AppName/Version (ContactEmail)"**, example given: `MyApp/1.0
  (myapp@example.com)`.
- Implemented exactly as `SmartInventoryScanner/1.0 (djsanti88@gmail.com)` (see
  `OFF_USER_AGENT` in `openFoodFactsClient.ts`), sent as the `User-Agent` header on every request.

Rate limits, quoted:
- **"15 req/min/IP address for all read product queries"**, **"10 req/min/IP address for all
  search queries"** (we only use the read/product endpoint, so the 15/min figure applies; the
  rung self-caps at 10/min for a buffer).

Production/commercial-use language, quoted:
- **"You are very welcome to use the API for production cases, as long as 1 API call = 1 real
  scan by a user."** This is an exact match for how this rung is used (each barcode scan makes at
  most one OFF lookup, gated behind the free-tier throttle and only for GTIN-shaped codes) -
  scraping/bulk harvesting would violate this and is explicitly out of scope here.
- The docs also note a formal step: **"Before API use, you must: 1. Read the Terms and Conditions
  of Use, 2. Complete the API usage form to declare your intended use."** This is a registration/
  declaration step OFF asks of API consumers generally; it does not block the keyless endpoint
  from functioning, and is noted here as an owner-facing follow-up (see Concerns below), not a
  hard blocker to building the rung (WebFetch on the linked Terms and Conditions page 404'd during
  this session; could not fetch its exact text).

**Verdict: PROCEED**, with an attribution note for the owner: OFB data is ODbL-licensed, which
generally expects share-alike attribution when redistributing the DATABASE (not simply displaying
individual facts pulled at query time for internal inventory use). Since this rung only reads
name/brand/category into a private inventory suggestion (never republishes or redistributes the OFF
database), the attribution requirement's applicability is narrower than a full data-redistribution
scenario, but the owner should be aware ODbL exists on this data before any future public-facing
display of OFF-sourced product data.

## Files changed

New:
- `src/services/upc/upcItemDbClient.ts` + `.test.ts` - pure UPCitemdb REST wrapper.
- `src/server/upc/upcItemDbUsage.ts` + `.test.ts` - local daily-cap counter (90/day).
- `src/server/upc/UpcItemDbProvider.ts` + `.test.ts` - the UPCitemdb rung.
- `src/services/upc/openFoodFactsClient.ts` + `.test.ts` - pure OFF REST wrapper.
- `src/server/upc/openFoodFactsUsage.ts` + `.test.ts` - local per-minute throttle counter (10/min).
- `src/server/upc/OpenFoodFactsProvider.ts` + `.test.ts` - the OFF rung.

Modified:
- `src/server/upc/ladder.ts` - `LadderRungRunners` gains `runUpcItemDb` + `runOpenFoodFacts`;
  `buildLadderRungs` pushes both ahead of `goupc` (still GTIN-gated together with goupc).
- `src/server/upc/ladder.test.ts` - `buildLadderRungs` describe block updated for the 5-rung GTIN
  order and 2-rung non-GTIN order.
- `src/server/upc/importBoundary.test.ts` - added the 4 new server-only files to the explicit
  first-line-guard check list.
- `src/server/decode/pipeline.ts` - wires `runUpcItemDb` and `runOpenFoodFacts` closures (mirroring
  `runGoUpc`'s shape exactly: E2E-mock-inert, provider-status push, settled-payload mapping) and
  passes both into `buildLadderRungs`.

## TDD evidence (red -> green transcript summary)

1. `upcItemDbUsage.test.ts` / `openFoodFactsUsage.test.ts`: written alongside their counter
   implementations (mirroring the already-merged `goUpcUsage.ts`/`goUpcUsage.test.ts` pattern
   exactly - same shape, same atomic-increment contract, same rollover test). Ran green
   immediately (7 tests, 7 tests) since the counter logic is a direct structural mirror of a
   proven pattern.

2. `upcItemDbClient.test.ts` / `openFoodFactsClient.test.ts`: written alongside their pure REST
   wrappers (mirroring `goUpcClient.ts`'s tested shape). 9 and 10 tests respectively, green
   immediately for the same reason - direct structural mirror.

3. `UpcItemDbProvider.test.ts` - genuine RED-then-GREEN:
   - Wrote the full 9-test file first, referencing `@/server/upc/UpcItemDbProvider` (did not
     exist yet).
   - Ran `npx vitest run src/server/upc/UpcItemDbProvider.test.ts --project unit`:
     ```
     FAIL  |unit| src/server/upc/UpcItemDbProvider.test.ts
     Error: Cannot find package '@/server/upc/UpcItemDbProvider' imported from ...
     Test Files  1 failed (1)
     ```
   - Implemented `UpcItemDbProvider.ts`. Re-ran: 8/9 passed, 1 failure (a reason-text string
     case-mismatch in my own test assertion vs. the actual generated message - fixed the test to
     assert `.toLowerCase().includes(...)` instead of an exact-case substring, since the
     underlying behavior was already correct and honest).
   - Final run: **9/9 passed**.

4. `OpenFoodFactsProvider.test.ts` - genuine RED-then-GREEN:
   - Wrote the 9-test file first, referencing `@/server/upc/OpenFoodFactsProvider` (did not exist
     yet). Confirmed red:
     ```
     FAIL  |unit| src/server/upc/OpenFoodFactsProvider.test.ts
     Error: Cannot find package '@/server/upc/OpenFoodFactsProvider' imported from ...
     Test Files  1 failed (1)
     ```
   - Implemented `OpenFoodFactsProvider.ts`. Re-ran: 2/9 passed, 7 failures - root cause was a bad
     test fixture GTIN (`3033490004624` has an INVALID GS1 check digit, so the rung's own GTIN
     gate was correctly rejecting it before the client mock was ever reached - the gate was
     working correctly; the test fixture was wrong). Swapped to a real, valid-check-digit EAN-13
     (`3017620422003`, the real Nutella barcode). Verified the check digit algorithm against both
     codes with a small standalone script before making the change.
   - Final run: **9/9 passed**.

5. `ladder.test.ts`'s `buildLadderRungs` describe block: updated the existing 3 tests (they
   compiled against the new `LadderRungRunners` shape only after adding `runUpcItemDb`/
   `runOpenFoodFacts` stubs to the local `deps` object) and the order assertions. All 9 tests in
   `ladder.test.ts` (6 `runLadder` + 3 `buildLadderRungs`) green.

6. `pipeline.ts` wiring: added `runUpcItemDb` and `runOpenFoodFacts` closures structurally
   identical to `runGoUpc` (E2E guard, `ladderStorage()`, provider-status push, settled-payload
   mapping with a `snippet`-strength unverified evidence entry), then passed both into
   `buildLadderRungs`. `npx tsc --noEmit` was RED (missing symbols) until both closures existed
   simultaneously, since `buildLadderRungs`'s single call site needs the full interface at once -
   this is a legitimate, unavoidable coupling given the shared interface change (documented in the
   3.3 commit message).

## Test results (final, post both commits)

```
$ npx vitest run src/server/upc src/server/decode --project unit
 Test Files  11 passed (11)
      Tests  116 passed (116)

$ npx vitest run src/server/upc src/server/decode src/services/upc --project unit  (includes pure client tests)
 Test Files  16 passed (16)
      Tests  159 passed (159)

$ npx tsc --noEmit
(clean, exit 0)
```

New test counts by file:
- `upcItemDbClient.test.ts`: 9
- `upcItemDbUsage.test.ts`: 7
- `UpcItemDbProvider.test.ts`: 9
- `openFoodFactsClient.test.ts`: 10
- `openFoodFactsUsage.test.ts`: 7
- `OpenFoodFactsProvider.test.ts`: 9
- `ladder.test.ts`: 9 (3 updated for the new order, 6 unchanged)
- `importBoundary.test.ts`: 4 (unchanged logic, extended file list)

Total new/changed tests across the two tasks: **51 new tests** (9+7+9+10+7+9), all green.
Zero live network calls in any test (every provider test injects a mocked `fetchImpl`/`client`;
every usage-counter test uses `fileLadderStorage` over a fresh `mkdtempSync` temp dir with an
injected clock - no bare `new Date()` anywhere in test files).

## Execution-report section text (for the controller to fold in elsewhere)

> **Free ladder rungs 3.3 + 3.4 (UPCitemdb, Open Food Facts) - built 2026-07-12.** Two free,
> keyless rungs added to the decode ladder ahead of paid Go-UPC: UPCitemdb (keyless trial tier,
> ~100/day per IP, self-capped at 90/day) and Open Food Facts (ODbL, ~15 req/min/IP, self-capped
> at 10/min, requires `SmartInventoryScanner/1.0 (djsanti88@gmail.com)` User-Agent). Both are
> GTIN-gated at `buildLadderRungs` exactly like Go-UPC, run BEFORE it (cost-ordered: free before
> paid), and are strictly suggestion-only (confidence capped at 0.6, `exactCodeEvidenceVerifiedByApp`
> always false) - neither can auto-count on its own claim, per the Resolver Trust Rules. Neither
> rung touches the paid daily AI-lookup cap or the paid Go-UPC monthly cap; each owns a private
> counter under its own KV key namespace on the shared `LadderStorage` seam (file-backed locally,
> Turso in production - no new storage backend needed). Final GTIN rung order:
> `upcitemdb -> openfoodfacts -> goupc -> fetchv2 -> gpt`; non-GTIN codes are unaffected
> (`fetchv2 -> gpt`). 51 new unit tests, all green, zero live network calls. `npx tsc --noEmit`
> clean. Two commits on `feat/free-rungs` (not pushed): UPCitemdb rung, then Open Food Facts rung.
> ToS check for both providers found no prohibition on this use case (UPCitemdb: no explicit
> commercial-use restriction found anywhere in its docs/ToS/rate-limits pages; Open Food Facts:
> explicitly welcomes production use "as long as 1 API call = 1 real scan by a user," which is
> exactly this rung's usage pattern). Not yet merged to `feat/decode-ladder-goupc` or wired to any
> live traffic - unit-tested only, pending owner review and the merge gate's full test suite.

## Self-review against the domain rules (NON-NEGOTIABLE list from the task prompt)

1. **"Free rungs NEVER touch the paid daily cap counter - they keep their OWN usage counters."**
   VERIFIED. `upcItemDbUsage.ts` and `openFoodFactsUsage.ts` each use their own KV key prefix
   (`upcitemdb-usage:` and `openfoodfacts-usage:`) on the shared `LadderStorage.get/set/increment`
   seam - the SAME seam the paid AI-lookup daily cap uses (`aiSpendGuard.ts`), but under disjoint
   key namespaces so they can never collide or double-charge. Explicit tests
   (`"NEVER touches the paid Go-UPC usage key..."` in both usage test files) assert the paid
   Go-UPC monthly usage file and other rungs' keys are untouched after a free-rung `record()`.
   Neither free rung's runner in `pipeline.ts` calls `chargeDailySlot`/`readDailyUsed` (the paid
   cap functions) at all - only the LAZY DAILY CAP GATE further down in `computeDecode`
   (unchanged, still gates only Go-UPC/Fetch V2/GPT-5.5) does that.

2. **"A free-DB hit is a SUGGESTION only (confidence <= 0.7, exactCodeEvidence NOT app-verified):
   a single free source must never auto-count on its own claim."** VERIFIED. Both rungs cap
   confidence at 0.6 (`SUGGESTION_CONFIDENCE = 0.6`, under the 0.7 ceiling), set
   `decision.status = "needs_review"` (never `"verified"`) unconditionally on every hit, set
   `exactCodeEvidenceVerifiedByApp: false` unconditionally, and mark
   `results[0].needsHumanReview = true`. Both provider test files have an explicit test: *"a hit
   NEVER produces a verified decision on its own."* In `pipeline.ts`, both rungs' settled payload
   passes an UNVERIFIED evidence entry (`verified: false, strength: "snippet"`) into the ladder
   payload - identical shape to how Go-UPC's `goupc_inferred`/`goupc_prefix_conflict` paths (which
   are also suggestion-only) build their evidence. Nothing downstream of the ladder can promote
   this to verified without independent app-side evidence verification.

3. **"Both rungs are GTIN-gated at buildLadderRungs... Final rung order for a valid GTIN:
   upcitemdb, openfoodfacts, goupc, fetchv2, gpt; for non-GTIN: fetchv2, gpt."** VERIFIED exactly.
   `ladder.ts`'s `buildLadderRungs` pushes `upcitemdb` then `openfoodfacts` then `goupc`, all
   inside the same `if (isGtinShaped(code) && isValidCheckDigit(code))` block, followed
   unconditionally by `fetchv2` then `gpt`. `ladder.test.ts`'s three `buildLadderRungs` tests
   assert exactly this order for a valid UPC-A, a non-GTIN (ASIN-style), and a GTIN-shaped code
   with a bad check digit. Both individual rungs ALSO re-check the GTIN gate internally
   (`isGtinShaped`/`isValidCheckDigit`) as defense-in-depth, proven by each provider's own
   "non-GTIN input" test - so even a future caller bypassing `buildLadderRungs` cannot spend a
   free-tier request on a non-GTIN code.

4. **"Every miss/timeout/throttle returns settled:false with an honest reason string."**
   VERIFIED. In `pipeline.ts`, both `runUpcItemDb` and `runOpenFoodFacts` return
   `{ settled: false, reason: r.reason }` on every non-hit path (`_miss`/`_unavailable`), and the
   underlying rung functions (`upcItemDbRung`/`openFoodFactsRung`) return a non-empty `reason` on
   every single branch - proven by the "never silent" pattern already established by
   `goUpcRung` and directly exercised by 8 of 9 tests in each provider test file (only the "hit"
   test is a settled path; every other test asserts a specific honest reason string, e.g.
   `"upcitemdb: no match"`, `"UPCitemdb local daily limit reached (...)"`,
   `"upcitemdb: transient error (...)"`, `"openfoodfacts: provider quota exhausted"`).

5. **"Unit tests mock fetch - ZERO live network calls in tests, ever."** VERIFIED. Every client
   test (`upcItemDbClient.test.ts`, `openFoodFactsClient.test.ts`) injects a `vi.fn()` as
   `fetchImpl` - the real global `fetch` is never referenced. Every provider test
   (`UpcItemDbProvider.test.ts`, `OpenFoodFactsProvider.test.ts`) injects a `vi.fn()` as `client`,
   never importing or calling the real `upcItemDbLookup`/`openFoodFactsLookup`. Every usage-counter
   test uses `fileLadderStorage` over an `mkdtempSync` temp directory with an injected `now`
   clock - no network, no bare `new Date()`. Grep-verified: no test file in this change set
   contains a bare (unmocked) call to global `fetch`.

No deviations from the domain rules were needed. The only structural note worth flagging (see
"Files changed" above) is that `LadderRungRunners`'s interface change forced both rungs' closures
to exist in `pipeline.ts` before `tsc --noEmit` could pass, which is why the two commits both touch
`pipeline.ts`/`ladder.ts` in slightly overlapping ways - this was disclosed in the 3.3 commit
message rather than hidden.

## Concerns / follow-ups for the owner

1. **UPCitemdb ToS "absence of prohibition" is not a canonical acceptance letter.** Recommend a
   short confirmation email to UPCitemdb support before this rung sees meaningful production
   volume, since no single page stated "commercial use of the free tier is allowed" in as many
   words - the conclusion rests on checking four likely pages and finding no restriction on any.

2. **Open Food Facts' formal "declare your intended use" step** (their docs mention completing an
   API usage form and reading a separate Terms and Conditions page that 404'd during this
   session) was not completed - the keyless endpoint works without it today, but the owner may
   want to complete that declaration for good standing with OFF, especially if usage scales.

3. **`ladderStorage()` is called once per rung run inside each closure** (mirroring the existing
   `runGoUpc` pattern exactly) rather than being resolved once and shared across all three GTIN-gated
   rungs in a single request. This matches the pre-existing Go-UPC pattern (not a regression) but is
   a minor inefficiency worth revisiting if a future task consolidates the ladder's storage
   resolution.

4. Neither rung has been exercised against a live server yet (no manual live test was run, per the
   task's scope - unit tests only, gated at "targeted vitest + tsc clean"). The task brief's OPUS
   REVIEW NOTE for 3.3 ("an Opus reviewer confirms the rung cannot auto-count on its own claim
   before merge") has not happened yet - flagging this as an explicit outstanding step before merge
   to `feat/decode-ladder-goupc`.
