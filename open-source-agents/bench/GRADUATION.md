# Graduation Gate - when the fleet is officially "badass"

Owner-ordered stop rule (2026-07-26). The teach loop runs until BOTH gates pass.
Qualification mode: the fleet identifies, reviews, and suggests ONLY - it never
writes app code. It is a complement to frontier models, not a substitute.

## Gate 1 - Held-out benchmark thresholds (objective)
A FRESH case set (mined from commits/defects never used in teaching or in
rounds 0-3; authored by Sonnet agents, ground truth sealed) where the taught
fleet must score, in a single run, no retries:

| Category | Threshold | Rationale |
|---|---|---|
| Law/knowledge QA (recall role + crib/RAG) | >= 32/40 | Beat every contaminated cloud score except Sonnet's |
| Triage (lens + crib) | >= +5/10 | Flip the case class every frontier model failed |
| Process critique (taught) | >= 8/10 | Hold the current level on unseen material |
| Bug-hunt (taught + exemplars) | >= 12/60 with FP total <= 4 | Honest bar: catch easy/medium seeded defects with near-zero fabrication - NOT frontier depth |
| Domain skills (ledger / import / decode-trace / hygiene) | >= 60% rubric points per skill | Each new skill demonstrably works on a real artifact |

## Gate 2 - Blind frontier review (subjective, the "badass" verdict)
A FRESH Fable instance (no project memory, no involvement in teaching) receives
the fleet's outputs on the held-out set, unlabeled, alongside outputs from
Sonnet and agy on the same cases, and answers: "Rank these reviewers. Would you
want reviewer X as a standing voice in your review panels - yes/no, and why."
PASS = the fleet is ranked a clear "yes, I'd want this voice" with specific
strengths cited - not merely "acceptable".

## Anti-gaming rules
- Held-out cases are sealed: authored after teaching freezes, never seen by any
  teaching material author, verified disjoint from exemplar/benchmark commits.
- No threshold tuning after the held-out run starts. A fail = another teach
  round, then a NEW held-out set (never re-run the same sealed set twice).
- Speed and $/call are reported alongside scores in the final artifact but do
  not gate graduation (the fleet's economics are already its advantage).

## Loop economics (standing)
- GPU rounds: $0, overnight-preferred, resource-guarded (85%/92%).
- Grading/production: Sonnet agents. Adjudication/payload design: Fable only.
- Report cadence: scores per round to the owner; no mid-round check-ins.
