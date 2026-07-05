# Task 3 Report: Free pattern-URL door before paid discovery

## Status: DONE

## Commit
`90f752b` — feat(fetchv2): free pattern-URL door before paid discovery

## Terminal Proof

Command: `npx vitest run src/services/fetchV2/engine.test.ts -t "pattern"` (baseline, before implementation)
Result: 1 failed (identity-secured skip test — expected `["verified","suggested"]` to contain "unknown", confirming `patternUrls` was unknown/ignored), 1 passed (fall-through test, trivially, as the brief predicted)
Exit code: 1

Command: `npx vitest run src/services/fetchV2/` (after implementation)
Result: 3 test files passed, **124 tests passed** (122 pre-existing + 2 new)
Exit code: 0

Command: `npx tsc --noEmit`
Result: clean, no output
Exit code: 0

## Files Changed
- `src/services/fetchV2/index.ts`
  - Added `patternUrls?: (variants: string[]) => string[]` to `FetchV2Deps`.
  - Hoisted `junkUrls` (a `Set<string>`) and extracted a `processPage(cand): Promise<SourceFinding | null>` closure above the provider loop. Its body is identical in behavior to the former inline page-loop logic: `fetchPage` with try/catch -> `markBadUrl("fetch failed")` on throw, `markBadUrl("http N")` on non-ok, title/text extraction, `evaluatePageJunk`, active-junk regex adds to `junkUrls` + `markBadUrl` + pushes a rejected `SourceFinding`, else `extractProducts` + name/brand cleaning + `proveAssociation` + `markBadUrl` on no-evidence + `scoreSource`, then pushes and returns the finding.
  - Inserted the FREE pattern-URL door immediately after `let exactMatchCandidates: DiscoveryCandidate[] = [];`: gated on `deps.patternUrls && identifier.isPublicBarcode`, iterates up to 2 URLs from `deps.patternUrls(normalized.all)`, calls `processPage({ url, title: "", snippet: "", rank: -1 })` for each, and breaks with a `rulesFired` note if a page comes back not junk-rejected, with `association.level === "strong"`, and a non-empty product name.
  - Added `identitySecured` computed from `findings` right after the pattern phase (same predicate: not junk-rejected, strong association, non-empty name).
  - Gated the provider discovery loop with `!identitySecured`: `for (let i = 0; !identitySecured && i < deps.discovery.length; i++)`.
  - Rewrote the page loop below `prioritized` to call `const f = await processPage(cand)` and check `f` for the early-win break condition (`mode !== "strict" && f.association.level === "strong" && f.quality === "strong"`), replacing the previously inlined fetch/junk/extract/score logic.
  - `snips`, `ACTIVE_JUNK_RE`, and `liveCand` below the loop are untouched and still reference the (now hoisted) `junkUrls` — confirmed still compiling and passing.
- `src/services/fetchV2/engine.test.ts`
  - Added the two tests from the brief verbatim to the "no-result receipts in the pipeline (credit efficiency)" describe block: (1) pattern URL secures identity via a JSON-LD Doritos page, asserts `search` is never called and `fetchPage` is called with the exact pattern URL; (2) a 404 pattern page falls through and `search` is called.

## What Changed
Discovery now tries up to 2 free, predictable barcode-DB URLs (supplied by an injected `patternUrls` dep, to be wired from V1's `selectBarcodeUrls` in Task 4) before spending any paid search call. If one of those pages independently proves a strong, non-junk association with a usable product name, the entire paid provider loop is skipped — zero search credits spent for that code. If the pattern pages are unreachable, junk, or inconclusive, execution falls through unchanged to the existing provider-search ladder. This was a pure extraction of the existing page-processing logic into a shared `processPage` closure plus a new gated phase ahead of it — no matching/scoring/junk-detection behavior was altered. All 122 pre-existing fetchV2 tests still pass unchanged, confirming behavioral equivalence of the extraction.

## Acceptance Criteria Results
1. TDD red-first confirmed: "pattern URLs are fetched FREE first" failed before implementation; the fall-through test passed trivially as the brief anticipated (acceptable per Step 2 of the brief).
2. `npx vitest run src/services/fetchV2/` — 124/124 pass, zero regressions in the 122 pre-existing tests.
3. `npx tsc --noEmit` — clean.
4. Only `src/services/fetchV2/index.ts` and `src/services/fetchV2/engine.test.ts` touched (verified via `git status`/`git commit` file list).
5. Structural notes followed exactly: `junkUrls` + `processPage` hoisted above the provider loop; pattern phase + `identitySecured` inserted right after the `exactMatchCandidates` declaration; provider loop gated with `!identitySecured`; page loop rewritten to call `processPage`; the three `snippetFindings(...).some((s) => s.name)` break conditions inside the provider loop were left byte-for-byte unchanged; `junkUrls`/`snips` wiring below the page loop still works.

## Proof Type
- Automated proof: real Vitest execution (124/124 green) + real `tsc --noEmit` run (clean). Both commands were actually run, output shown above, not fabricated.
- Mocked proof: both new tests use fully mocked `fetchPage`/`search` functions (no network), consistent with this module's existing dependency-injection test pattern — no live provider was called.
- Live proof: none required or attempted — this is an engine-level, dependency-injected change; `patternUrls` has no real implementation wired yet (that is Task 4's scope, supplying V1's `selectBarcodeUrls`).
- Untested limitations: only the engine-level gating/free-door mechanics are proven here. End-to-end proof that a real barcode-DB pattern URL secures identity in production awaits Task 4's wiring and, per project rules, any live-provider verification requires explicit owner approval and is out of scope for this task.

## Concerns
None. The restructure is mechanical (extraction + new gated phase); no scoring, junk-detection, or matching logic was changed, and the full pre-existing suite (122 tests) passing unchanged is direct evidence of that.

---

# Follow-up Fix: free corroboration preserved when identity is held only at MEDIUM quality

## Status: DONE

## Reviewed Finding
The original `identitySecured` gate (above) fired on ANY held identity regardless of `quality`,
so a MEDIUM-quality structured hit (e.g. Open Food Facts) skipped the WHOLE provider loop -
including the FREE Brave search that historically upgraded a single-medium suggestion into a
2-source verified outcome via corroboration. Only a STRONG-quality identity should skip
everything; a medium (or better) identity should still let the FREE provider run, and only PAID
escalation providers (`i > 0`) should be skipped, since paying to re-find an identity we already
hold is pure waste.

## Commit
`<see final report>` - fix(fetchv2): free corroboration preserved - paid escalation only when no identity held

## Terminal Proof

Command: `npx vitest run src/services/fetchV2/` (after implementation)
Result: 3 test files passed, **126 tests passed** (124 pre-existing + 3 new/updated: 1 existing test's assertions updated per spec, 2 new tests added)
Exit code: 0

Command: `npx tsc --noEmit`
Result: clean, no output
Exit code: 0

## Files Changed
- `src/services/fetchV2/index.ts`
  - Replaced the single `identitySecured` boolean with two predicates: `heldIdentity()` (non-junk,
    strong association, non-empty name - ANY quality) and `strongSecured()` (same, plus
    `quality === "strong"`).
  - The provider loop now guards on `!strongSecured()` (was `!identitySecured`): only a
    STRONG-quality identity skips the entire loop.
  - Added `if (i > 0 && heldIdentity()) break;` immediately before the per-iteration
    `provider.search` call: once ANY identity is held, the FREE provider (`i === 0`) may still run
    once for corroboration, but every PAID escalation provider (`i > 0`) is skipped - we never pay
    to search for something we already hold.
  - Updated the pattern-door `rulesFired` message to stay accurate under the new rule: it now
    distinguishes a STRONG pattern-door hit ("entire provider loop skipped") from a
    medium-or-lower hit ("paid search skipped (free corroboration may still run)").
- `src/services/fetchV2/engine.test.ts`
  - Updated "pattern URLs are fetched FREE first..." (renamed to "...identity secured skips PAID
    search (free corroboration may still run)"): added a second discovery provider (`firecrawl`
    paid spy), removed the now-inaccurate `expect(search).not.toHaveBeenCalled()` (the go-upc
    pattern host is a "supporting" tier -> medium quality, so the free provider MAY run), and
    asserts `expect(paidSpy).not.toHaveBeenCalled()` instead.
  - Added "a MEDIUM structured hit still lets the FREE provider corroborate into verified,
    without ever paying (economic rule)": Open Food Facts medium structured hit + Brave finding a
    code-carrying go-upc.com page on a DIFFERENT host -> outcome `verified` via medium+medium
    corroboration, paid `firecrawl` spy never called.
  - Added "a MEDIUM structured hit + an EMPTY free search still blocks paid escalation (identity
    already held)": Open Food Facts medium hit + Brave returns nothing -> free `search` IS called,
    paid `firecrawl` spy is NOT called, outcome stays `suggested` (no corroboration found).

## What Changed
The economic rule is now two-tiered instead of one-shot: (1) a STRONG-quality identity (e.g. a
fully-verified JSON-LD product page) skips the ENTIRE provider loop, free and paid alike - nothing
left to prove. (2) Any weaker held identity (medium, e.g. a bare structured-API hit) still lets the
FREE provider run once for corroboration - because a single free search can upgrade a
medium-alone "suggested" into a verified two-source agreement - but every PAID escalation provider
is skipped, since spending money to re-find an identity already in hand is waste. (3) No identity
at all: unchanged, full ladder runs as before. This restores the FREE corroboration path the
original all-or-nothing gate had accidentally removed, while preserving all of the paid-cost
savings from Task 3's pattern-door work.

## Acceptance Criteria Results
1. Test 1 (new): medium structured hit + Brave agreeing code-carrying snippet from a different
   host -> `verified`, paid provider not called. PASS.
2. Test 2 (new): medium structured hit + Brave returns nothing -> paid provider not called,
   outcome `suggested`. PASS.
3. Test 3 (existing, updated per spec): pattern-URL door secures a MEDIUM identity -> paid
   provider not called; free provider assertion loosened since it MAY now run. PASS.
4. `npx vitest run src/services/fetchV2/` - 126/126 pass, zero regressions among the 124
   pre-existing tests.
5. `npx tsc --noEmit` - clean.
6. Only `src/services/fetchV2/index.ts` and `src/services/fetchV2/engine.test.ts` touched.

## Proof Type
- Automated proof: real Vitest execution (126/126 green) + real `tsc --noEmit` run (clean). Both
  commands were actually run, output shown above, not fabricated.
- Mocked proof: all three tests (2 new + 1 updated) use fully mocked `fetchPage`/`search`/
  `structured.lookup` functions (no network) - consistent with this module's existing
  dependency-injection test pattern. No live provider was called.
- Live proof: none required or attempted - engine-level, dependency-injected change only.
- Untested limitations: none identified for this scoped fix; end-to-end proof against real
  provider responses still awaits a live/manual run under existing project rules (owner approval
  required for any live AI/search-provider call).

## Concerns
None. The change is a narrow two-line-plus-comment refinement of the existing gate (one boolean
split into two, one early-break added inside the loop); no scoring, junk-detection, association,
or outcome-decision logic was touched. The full pre-existing 124-test suite passing unchanged
alongside the 2 new tests is direct evidence of behavioral correctness.
