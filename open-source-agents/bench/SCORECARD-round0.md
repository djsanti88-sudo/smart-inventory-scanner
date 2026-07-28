# Scorecard v0 - Round 0 (untaught baseline), 2026-07-23

Judge: Fable (adjudicated from 9 parallel Sonnet grader reports; FP penalty
harmonized to -2 each, cap -6/case; triage -3 applied to every confident
wrong-primary-with-production-fix diagnosis, 0 for hedged non-diagnosis).

## CONTAMINATION DISCLOSURE (found during adjudication)
Cloud subjects (sonnet, codex, agy) auto-loaded project instruction files
(CLAUDE.md/AGENTS.md) via their harnesses. CLAUDE.md contains direct answers to
law-qa and frames bug-01/bug-02. Their scores on those cases are INFLATED.
Local models had no such context. Clean cases for all: bug-03..06, triage,
process. Fix from round 1 on: subjects run from a sanitized directory outside
the repo.

## Totals (/120; * = contaminated cases included)

| Subject | Bugs /60 | Law /40 | Triage /10 | Process /10 | Total | /100 |
|---|---|---|---|---|---|---|
| Sonnet (cloud) | 55* | 40* | -3 | 10 | 102* | 85* |
| Codex (cloud) | 53* | 33* | -3 | 10 | 93* | 78* |
| agy/Gemini (cloud) | 46* | 24* | -3 | 7 | 74* | 62* |
| local coder (Qwen3-Coder-30B) | 5 | 12 | 0 | 3 | 20 | 17 |
| local analyst (gpt-oss-20b) | -10 | 0 | -3 | 0 | -13 | 0 (floored) |
| local chore (Qwen3-8B) | n/a (3 cases only) | 11 | -3 | 3 | 11/60 | - |

Clean-cases-only comparison (bug-03..06 + triage + process, /50):
Sonnet 32, Codex 30, agy 22, coder 8, analyst -11.

## Per-case bug matrix (analyst | coder | sonnet | agy | codex)
- bug-01 delete-drops-counts: -6 (Fable-graded: miss + catalog-trap FP + fabricated syntax error) | 0 | 10 | 8 | 10
- bug-02 markwrong-deletes-qty: 0 | 0 | 10 | 10 | 10
- bug-03 refresh-wipes-tenant: -6 | 0 | 5 | 10 | 10
- bug-04 barcode-stripped: -4 | 0 | 10 | 10 | 3
- bug-05 signout-bypasses-wipe: 10 | 5 | 10 | 10 | 10
- bug-06 retail-unverified: -4 | 0 | 10 | -2 | 10

## Diagnosed failure modes (teach targets)
1. analyst HALLUCINATES findings under pressure (fake typos, "undefined vars"
   from elided context): doctrine #7 (concrete scenario or downgrade) + #2
   (trace, don't recognize) target this. Note bug-05 shows it CAN hit cleanly.
2. analyst REFUSED all law-qa ("CANNOT VERIFY" x20): persona honesty rule
   over-applied when no material provided; needs the trust-ladder rule (#9) -
   answer from best available rung, label the rung.
3. coder DEFAULTS TO ALL-CLEAR ("no bug found" on 5/6 seeded cases): needs
   adversarial stance - the skeptic lens + doctrine #3.
4. EVERY subject failed triage (confident wrong root cause, production-fix
   recommendation): only project knowledge (RAG) fixes this - exactly the
   round-2 teach payload.
5. Sonnet's only bug losses: bug-03 (called the true defect "intentional") -
   even frontier models under-flag when code comments assert intent (doctrine
   #5: names lie).

## Round plan
- R1: doctrine attached (--taught), personas recalibrated (analyst trust-ladder,
  coder skeptic default). Re-run local columns, clean-room. Expect bugs + process
  to move; law-qa to stay low (knowledge-gated).
- R2: + RAG over project docs. Expect law-qa and triage to jump.
- R3: + worked exemplars (Fable-style review transcripts). Iterate to plateau
  (<5 pts gain, 2 consecutive rounds).
- Final: head-to-head vs fresh no-memory Fable, sanitized cases, new held-out
  bug set mined from commits never discussed in-session.
