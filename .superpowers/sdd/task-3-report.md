# Task 3 Report: Wider per-code-type pattern door + door counts toward consensus

## Status: DONE

## Commit
`3290874` — feat(fetchv2): wider pattern door + door-snippet verified pairs

## Terminal Proof

Command: `npx vitest run src/services/fetchV2/engine.test.ts -t "pattern-door identity"` (brief's literal test, before any scoring.ts change)
Result: 1 passed — GREEN already (see Concerns: this scenario coincidentally already satisfied the pre-existing vetted-host free-agreement fence, since the brief's fixture uses `go-upc.example.com`, which is in `TRUSTED_DB_HOSTS`)
Exit code: 0

Command: `npx vitest run src/services/fetchV2/engine.test.ts -t "NON-vetted pattern-door"` (added regression test using a non-vetted door host, before scoring.ts change)
Result: 1 failed — `Expected: "verified", Received: "suggested"` — genuine RED for the new corroboration path
Exit code: 1

Command: `npx vitest run src/services/fetchV2` (after scoring.ts + benchmark change)
Result: 3 test files passed, **142 tests passed** (140 pre-existing + 2 new)
Exit code: 0

Command: `npx tsc --noEmit`
Result: clean, no output
Exit code: 0

Command: `npx vitest run --pool=threads` (full project suite; default fork pool crashed with an unrelated Windows worker-fork infra error, not related to this change)
Result: 135 test files passed, 7 skipped, **1097 tests passed**, 30 skipped
Exit code: 0

## Files Changed
- `src/services/fetchV2/scoring.ts`
  - Extended the "balanced" corroboration computation in `decideOutcome`. Built a `labeledSnips`
    pool: `valid` findings with `association.matchedField === "search_snippets"`, `labeled === true`,
    and a non-empty product name. Built `pairPool = [...mediumPlus, ...labeledSnips]`.
  - Replaced the old `mediumPlus`-only pairwise scan with a scan over `pairPool` that requires: two
    findings on different hosts, `identityRelation(...) === "agree"`, AND at least one side of the
    pair is a member of `mediumPlus` (a strong-assoc medium/strong page finding). Two labeled
    snippets alone can never satisfy this path — that is intentionally reserved for the separate
    3-host snippet-consensus rule already in the file.
  - The winner of a corroborated pair is now always the `mediumPlus` side of the agreeing pair
    (`corroboratedWinner`), fixing a latent bug in the old code where the balanced-mode winner was
    hardcoded to `mediumPlus[0]` regardless of which pair actually corroborated — with the pool now
    containing mixed types, `mediumPlus[0]` would have been wrong whenever the first mediumPlus
    finding wasn't part of the agreeing pair.
  - `corroborated` (used by both `strict` and `balanced` modes) is now `corroboratedWinner !== null`.
- `scripts/fetchv2-benchmark.mts`
  - `patternUrls` now returns `selectBarcodeUrls(code).slice(0, 4)` instead of `.slice(0, 2)` (the
    selector already tiers candidates by GTIN class — UPC-12 favors US barcode-DB hosts first,
    EAN-13 favors intl hosts first — so widening to 4 pulls in more of that tiered pool, including
    hosts outside the narrow `TRUSTED_DB_HOSTS` vetted list, e.g. `buycott.com`).
- `src/services/fetchV2/engine.test.ts`
  - Added the brief's exact test verbatim: `"pattern-door identity + one agreeing labeled snippet = verified pair"`.
  - Added one additional regression test, `"NON-vetted pattern-door identity + one agreeing labeled
    snippet = verified via corroboration (not the vetted-host fence)"`, using a `buycott.example.com`
    door host (not in `TRUSTED_DB_HOSTS`) so the new corroboration path is genuinely exercised
    end-to-end, independent of the pre-existing vetted-host fence.

## Investigation Note (why the brief's literal test was already GREEN)
Before touching `scoring.ts`, I ran the brief's test as specified and it passed against the
*unmodified* code. Tracing the pipeline: the door URL `go-upc.example.com` scores `quality: medium`
(supporting tier) with `association.level: strong` (detail-table UPC match, not a query-echo since
the URL has no `?q=` param) — and it also matches `TRUSTED_DB_HOSTS` (substring `go-upc`). The single
discovery provider (`brave`, index 0) populates `freeTitles`, and its one result's title
("Doritos Cool Ranch Tortilla Chips 9.25 oz") agrees with the door's extracted identity on a
different host — which is exactly the pre-existing "vetted DB host + free-agreement fence" rule
(built in an earlier task, confidence 0.8), independent of the corroboration path this task adds.
Because the fixture happens to use a vetted host, both the pre-existing and the new logic reach
`verified`, so the literal test doesn't discriminate between them. To get genuine red-then-green
proof of the new logic, I added a second test using `buycott.example.com` (present in the wider
4-URL `selectBarcodeUrls` pool but absent from `TRUSTED_DB_HOSTS`) with the same labeled-snippet
setup — confirmed RED before the `scoring.ts` change, GREEN after. Both tests are committed; the
brief's required test is present and passing, and the added test proves the new code path is real
and load-bearing (not dead code that happens to never fire in the suite).

## What Changed
A strong-assoc medium-quality page finding (e.g., a pattern-door hit on a barcode-DB host, including
ones outside the narrow vetted list) can now pair with a LABELED snippet finding (a barcode label sat
next to the code in a search result) on a different host whose identity agrees, reaching `verified`
at 0.85 confidence via the existing "balanced: two independent medium sources agree" corroboration
path. Two labeled snippets alone still cannot corroborate this path (that protection is intentional —
the dedicated 3-host snippet-consensus rule already covers snippet-only verification with a higher
independent-agreement bar). Separately, the benchmark's pattern-door URL builder was widened from 2
to 4 per-code-type candidates, using the same GTIN-tiered `selectBarcodeUrls` selection, so more real
runs will encounter non-vetted door hosts that now benefit from this corroboration widening.

## Acceptance Criteria Results
1. Brief's exact test (`pattern-door identity + one agreeing labeled snippet = verified pair`):
   PASS both before and after the change (see Investigation Note for why it was already green).
2. Added regression test (`NON-vetted pattern-door...`): RED before the `scoring.ts` change,
   GREEN after — proves the new pairing logic is real and necessary.
3. `npx vitest run src/services/fetchV2` — 142/142 pass, zero regressions among the 140
   pre-existing tests.
4. `npx tsc --noEmit` — clean.
5. Full project suite (`--pool=threads`) — 1097/1097 pass, 30 skipped, zero regressions.
6. Only `src/services/fetchV2/scoring.ts`, `scripts/fetchv2-benchmark.mts`, and
   `src/services/fetchV2/engine.test.ts` touched (confirmed via `git diff --stat` / `git add` of
   exactly those three files before commit — other pre-existing uncommitted changes in the working
   tree from a different, unrelated task were left untouched).

## Proof Type
- Automated proof: real Vitest execution (142/142 fetchV2, 1097/1097 full suite) + real
  `npx tsc --noEmit` run (clean). All commands were actually run; output shown above, not fabricated.
- Mocked proof: both new/verified tests use fully mocked `fetchPage`/`search` functions (no
  network), consistent with this module's existing dependency-injection test pattern. No live
  provider was called.
- Live proof: none required or attempted — this is a pure decision-logic and benchmark-config
  change; no live AI/search-provider call was made or needed.
- Untested limitations: the benchmark's `patternUrls` widening (2 -> 4) is exercised only by
  existing unit coverage of `selectBarcodeUrls`/`decideOutcome`; a live benchmark run against real
  barcode-DB hosts to observe the wider door's real-world hit rate was not run (would require live
  network access / owner-approved live-provider spend, out of scope for this task).

## Concerns
- One full-suite run using the default fork pool crashed with `Worker exited unexpectedly` /
  `[vitest-pool]: Worker forks emitted error` (environmental Windows fork-pool flakiness, not
  related to this change) — a rerun with `--pool=threads` passed cleanly at 1097/1097. Worth noting
  in case this infra flake recurs on CI.
- The brief's Step 2 ("RED. Today: single medium + single snippet-weak do not pair.") did not hold
  literally for the exact fixture given, because that fixture's door host happens to already be
  covered by a different, earlier-built rule (vetted-host + free-agreement fence). This does not
  affect correctness of the implementation — it only means the brief's chosen fixture is not the
  most discriminating regression test for this specific change. I kept the brief's test as required
  and added a second test that does discriminate, so the new code path has real regression coverage.

## Follow-up: Review Fix (Finding C + Finding B)

### Status: DONE

### Commit
`fix(fetchv2): snippet-conflict guard runs before verify paths; www-normalized host identity`

### Findings addressed
- **Finding C (Critical):** the snippet-conflict scan (the loop over `snips` that returns
  `needs_review` when two snippet identities are "unrelated") sat AFTER the public-barcode verify
  block in `decideOutcome`. The door+snippet corroboration path added by Task 3 could therefore
  return `verified` while a third, disagreeing labeled snippet elsewhere in `findings` was never
  checked - the recycled-code case.
- **Finding B (Important):** `hostOf()` returned the raw hostname, so `www.retailer.com` and
  `retailer.com` counted as different hosts and could falsely corroborate as "independent" sources.

### Fix
- `src/services/fetchV2/scoring.ts`:
  - Moved the `snips` computation and its pairwise "unrelated" conflict check to run immediately
    after the existing `strongAssoc` sibling/conflict loops, BEFORE the `identifier.isPublicBarcode`
    verify block. The 3-host snippet-CONSENSUS logic (the `verified` return for 3+ distinct agreeing
    hosts) was left in its original place, after the verify block - only the conflict scan moved.
  - `hostOf()` now lowercases the hostname and strips a single leading `www.` before returning it,
    so `www.x.com` and `x.com` are treated as the same host everywhere in this file (corroboration
    pairing, vetted-fence self-agreement check, snippet-consensus distinct-host counting, and the
    snippet-only 2-host-agreement check all use this same function).
  - Exported `hostOf` so `index.ts` can share the identical normalization.
- `src/services/fetchV2/index.ts`:
  - Replaced the two ad hoc `new URL(...).hostname` extractions (in the free-provider title
    collection and in the `freeAgree` fence computation) with the shared `hostOf()` import from
    `scoring.ts`, so the free-agreement fence also treats `www.`/bare variants of the same domain as
    one host and cannot be tricked into a false "independent" agreement.

### TDD
Added two tests to `src/services/fetchV2/engine.test.ts` (in the `fetchV2 pipeline` describe block,
after the existing `"NON-vetted pattern-door identity..."` test):
1. `"a third DISAGREEING labeled snippet blocks the door+snippet verified pair (recycled-code guard
   order)"` - a non-vetted door page (Doritos) plus one agreeing labeled snippet (would corroborate
   to `verified` under the old code) plus a second, disagreeing labeled snippet (Charmin toilet
   paper) on the same code. Expects `needs_review` with `conflicts.length > 0`.
2. `"www vs bare domain is the SAME host: no false corroboration pair"` - a non-vetted door page at
   `buycott.example.com` plus a single discovery result at `www.buycott.example.com` (same site,
   `www.` variant) carrying the same identity. Expects the outcome NOT to be `verified` (it must not
   count as two independent corroborating hosts).

### Terminal Proof
Command: `npx vitest run src/services/fetchV2/` (before the fix, tests added)
Result: 2 failed (the 2 new tests), 142 pre-existing passed - genuine RED
Exit code: 1

Command: `npx vitest run src/services/fetchV2/` (after the fix)
Result: 3 test files passed, **144 tests passed** (142 pre-existing + 2 new), 0 failed
Exit code: 0

Command: `npx tsc --noEmit`
Result: clean, no output
Exit code: 0

Command: `npm run test` (full project suite)
Result: 135 test files passed, 7 skipped, **1099 tests passed**, 30 skipped
Exit code: 0

### Acceptance Criteria Results
1. Both new tests RED before the fix, GREEN after - proves each finding was real and the fix
   resolves it.
2. `npx vitest run src/services/fetchV2/` - 144/144 pass, zero regressions among the 142
   pre-existing tests (corroboration, consensus, and conflict tests all still pass unchanged).
3. `npx tsc --noEmit` - clean.
4. Full project suite (`npm run test`, default fork pool) - 1099/1099 pass, 30 skipped, zero
   regressions.
5. Only `src/services/fetchV2/scoring.ts`, `src/services/fetchV2/index.ts` (explicitly allowed for
   the Finding B www-strip), and `src/services/fetchV2/engine.test.ts` were touched for this fix.

### Proof Type
- Automated proof: real Vitest execution (144/144 fetchV2, 1099/1099 full suite) + real
  `npx tsc --noEmit` run (clean). All commands were actually run; output shown above is not
  fabricated.
- Mocked proof: both new tests use fully mocked `fetchPage`/`search` functions (no network),
  consistent with this module's existing DI test pattern. No live provider was called.
- Live proof: none required or attempted - pure decision-logic change.
- Untested limitations: none identified for this specific fix; behavior outside these two findings
  was intentionally left unchanged (verified by the 142 pre-existing tests staying green).

### Concerns
- None. The fix is a pure reordering (conflict scan moved earlier) plus a pure normalization
  (lowercase + strip `www.` in one shared `hostOf` helper used consistently in both files) - no
  other behavior was touched, and the full pre-existing suite confirms no regressions.
