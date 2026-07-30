# Fetch V2 "Search-Index Evidence" upgrade - design (2026-07-04, owner-approved)

Owner decisions: snippet consensus CAN verify (auto-count); build snippet tier + quoted-query
escalation + containment-agreement + size normalization as ONE package; keep it simple.

## Problem
The barcode-to-product mapping often lives in the SEARCH INDEX (merchant feeds -> result
titles/snippets), not in fetchable page bodies (eBay/JS pages). Fetch V2 only trusted page bodies,
so tires resolved 3/30 despite correct answers sitting in the discovery results it already held.
Separately: the sibling/conflict guard called name-containment pairs ("Beef Chunks" vs "Grabill
Country Meats Beef Chunks, 27 oz") conflicts, and tire sizes written "215X65R16" failed matching.

## Components
1. `src/services/fetchV2/pageEvidence/snippetEvidence.ts` (NEW, pure):
   `snippetFindings(candidates, variants)` -> code-carrying candidates (digit-boundary exact match
   on title+snippet) with firewall-cleaned identities.
2. `scoring.ts` decideOutcome additions (runs AFTER page-level paths, BEFORE weak suggestion):
   - any code-carrying snippet naming an UNRELATED product vs the rest -> needs_review (conflict).
   - >=3 code-carrying candidates on >=3 distinct hosts, all identities pairwise agree -> verified
     conf 0.85, sourceQuality medium, codeLocation "search_snippets".
   - >=2 agreeing hosts -> suggested conf 0.6.
3. `sources/discovery.ts`: braveProvider unchanged; pipeline escalates ONCE to firecrawlSearch with
   the QUOTED query ("CODE") when Brave yields zero code-carrying candidates (owner's comillas move;
   Google-grade index; 2 credits, leftovers only).
4. `siblingGuard.ts`: token-containment >=80% of shorter in longer -> agree; size conflict only when
   both sides carry package sizes AND units are comparable (oz-vs-oz, g-vs-g...; a grams value vs an
   oz value is ignored - serving-size noise); tire sizes normalize X/x -> "/".

## Safety gates (verify-capable snippets demand them)
- All 10 canaries live: refused, zero snippets carry an invented code (proven signal, re-proven).
- Recycled Frito-Lay codes: never verified (conflict rule fires on disagreeing snippets/pages).
- Zero-wrong-auto-count gate on every run; suite + tsc green; TDD watched-fail for every rule.

## Acceptance (owner: "200 codes, nearly perfect, don't overcomplicate")
- 200-code DB-sampled benchmark (100 retail + 100 tire) + 10 canaries, web-only, no AI, no DB reads.
- Iterate fix loops until: precision of attempts >=95%+, attempt rate maximized (retail ~95%,
  tires materially above the 10% baseline), canaries clean, 0 wrong auto-counts.
- Deliverables: results JSON, PDF + xlsx per-code report, failure-reason analysis, spend ledger.

Out of scope: marketplace item-specifics extraction, barcode-DB candidate pool, GPT escalation,
any production wiring. No commits/deploys without owner sign-off.
