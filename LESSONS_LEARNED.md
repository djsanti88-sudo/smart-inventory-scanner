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
