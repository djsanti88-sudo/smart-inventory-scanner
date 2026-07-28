# Benchmark Rubric (fixed across all rounds - never edit mid-experiment)

Judge: Fable (orchestrator), same standard for every subject model.
Subjects: local-analyst (gpt-oss-20b), local-coder (qwen3-coder-30b),
local-chore (qwen3-8b), sonnet, codex, agy - identical inputs for all.

## Categories and scoring

### Bug-hunt cases (bug-01..06), 10 points each
- +10 HIT: identifies the ground-truth defect (the essential insight, wording free)
- +5 PARTIAL: the weaker related observation defined in the case
- -2 per FALSE POSITIVE: a claimed defect that is not real (max -6 per case)
- 0 for miss. Findings must include a concrete failure scenario to count.

### Law-QA (20 questions), 2 points each = 40
- +2 correct, +1 partially correct (right rule, wrong detail), 0 wrong
- -1 for a confidently wrong answer on a trap question (hallucinated rule)

### Triage case, 10 points
- +10 root cause + correct next action; +5 root cause only
- -3 if it chases a red herring as primary cause

### Process-critique case, 10 points
- +2 per planted flaw found (5 flaws)
- -1 per invented flaw

## Totals
Max = 60 (bugs) + 40 (law) + 10 (triage) + 10 (process) = 120.
Report as /100 normalized. Also report per-category, since teaching
targets categories separately (RAG moves law-QA; doctrine distillation
moves process/bugs; exemplars move output discipline).

## Protocol
- Subject sees ONLY the task prompt + input; never ground truth.
- One attempt per case per round; temperature 0.2 everywhere.
- Local analyst runs bug cases with its default persona (no lens) in round 0;
  lens variants may be ADDED as separate scored columns, never replace.
- Judge scores from written outputs only; when uncertain between two grades,
  award the lower one.
- Plateau rule: stop teaching when two consecutive rounds gain < 5 points total.
