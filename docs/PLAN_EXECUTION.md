# Plan Execution Playbook (owner-ratified 2026-07-19)

> How EVERY non-trivial piece of work in this project gets planned, attacked, approved, executed,
> and closed. This encodes the owner's standing orders; it overrides default agent habits and is
> subordinate only to a direct owner instruction. Trivial work (per the Engineering Doctrine's
> trivial test) skips the plan machinery but never skips proof.

## The five laws of a plan

1. **Goal first, always.** No plan is drafted until the owner has stated the goal AND the agent has
   offered goal recommendations (sharper, cheaper, or more ambitious framings) for the owner to pick
   from. A plan without an owner-confirmed goal is invalid.
2. **Every plan is attacked before the owner sees it.** Three fixed adversarial reviewers plus one
   rotating specialist attack the draft; the loop repeats until clean (max 3 rounds).
3. **"Done" is a proof, not a feeling.** The goal becomes measurable acceptance criteria with a named
   proof method. The plan is NOT done until that proof passes or the owner explicitly accepts a
   near-miss. This gate is blocking; no partial work is ever presented as complete.
4. **The orchestrator orchestrates; subagents build.** The main session (Fable) never implements;
   every subagent call passes an explicit model (sonnet default, haiku trivial, opus for the hardest
   reviews). Every substantive diff gets two-layer review.
5. **Autonomous between gates.** After plan approval, execute phase after phase without per-step
   approvals. Stop only for the doctrine's true blockers (spend, deploy, real data, scope change).

## Step 1 - Goal interview (mandatory)

- Ask the owner: what is the goal, who is it for, what does success look like?
- ALWAYS respond with 2-3 recommended goal formulations (e.g. tighter scope, measurable target,
  higher-leverage alternative) and say which one is recommended and why.
- Convert the chosen goal into written acceptance criteria, each with a concrete proof method:
  a test command, a QA-bot run, a Playwright screenshot, a preview-URL walkthrough, or a metric.
- Subjective goals ("feels premium") get an objective proxy where possible, plus the owner's explicit
  sign-off as the final proof.
- Write down what is OUT of scope. Ambiguity discovered later goes back to this step, not into guesses.

## Step 2 - Draft

- The orchestrator drafts the plan (use `PLAN_TEMPLATE.md`; brainstorming skill first for creative
  work). Plans live in `docs/superpowers/plans/YYYY-MM-DD-<name>.md`.
- The draft must contain: goal + criteria + proof methods, phases with per-phase gates, files likely
  touched, commands to run, risk gates, cost estimate (tokens and any paid-API WORST CASE per the
  Paid API Cost Truth Rule), and rollback story.

## Step 3 - Attack panel (mandatory before owner review)

Four independent subagents attack the draft. Each returns BLOCKING objections (would make the plan
fail, lose data, overspend, or miss the goal) and non-blocking suggestions.

| Attacker | Angle |
|---|---|
| Feasibility Engineer | Will this work in THIS codebase? Are the named files/functions real? Are estimates honest? Does it collide with existing invariants (TOP-LEVEL LAW, ledger, trust rules)? |
| Risk Skeptic | Data loss, double-count, regression, security/tenant leaks, hidden paid calls, cost blowups, irreversible steps, OneDrive/git hazards. |
| Simplicity Challenger | What should be cut? Is there a cheaper path? Is the goal over-served? Does it bloat the core scan loop? |
| Rotating Specialist | Picked per plan and NAMED in the plan: UX attacker for UI work, tenant-isolation attacker for data/role work, scanner-flow attacker for scan-loop work, cost analyst for paid-API work, etc. |

Loop: revise the plan, re-attack, until ALL attackers report zero blocking objections - max 3
rounds. Whatever disagreements survive round 3 are listed VERBATIM in the plan for the owner.
Attackers run as subagents with explicit models (sonnet default; opus for the final round of a
high-stakes plan).

## Step 4 - Owner approval (one gate)

Present to the owner: the final plan, the surviving objections, the goal + criteria + proof methods,
and the cost worst case. One approval starts autonomous execution. Do not re-ask between phases.

## Step 5 - Execution

- **Orchestrator contract:** the main session decomposes, dispatches, reviews, and reports. Subagents
  write the code. Model tiering is explicit on every dispatch; omitting the model is a violation.
- **Two-layer review on every substantive diff:** the implementer self-verifies (tests + evidence),
  then an independent reviewer subagent reviews the diff. Findings are fixed, not argued away.
- **Autonomous phase progression:** phases proceed without owner check-ins. Respect concurrency caps.
- **End of each phase:** run the phase's gates (relevant suites from `docs/COMMANDS.md`; `qa:revision`
  for handoff-class changes), update `PROGRESS.md` (mandatory - stale PROGRESS.md is a defect), and
  ask the owner to fire `/code-review ultra` for the end-of-phase deep review (the orchestrator
  cannot launch it; it is owner-triggered and billed).
- **Phase reset:** at each phase start re-read the plan, PROGRESS.md, acceptance criteria, and the
  relevant source. Do not run on chat memory.

## Step 6 - Mid-plan pivots

If execution discovers the PLAN is wrong (not a mere bug - bugs use the doctrine's repair loop and
4-attempt circuit breaker):

1. The orchestrator revises the plan and runs the attack panel again on the changed parts.
2. If goal, cost, risk, and scope are unchanged: continue executing, and report the pivot in the
   end-of-phase report.
3. If ANY of goal / cost / risk / scope changed: STOP and ask the owner before proceeding.

Silent pivots are forbidden. Un-attacked pivots are forbidden.

## Step 7 - The done gate (blocking)

- Walk the acceptance criteria one by one; each needs its proof artifact (command output, screenshot,
  bot report, metric) linked or embedded.
- The plan is not done until the goal is hit or the owner explicitly accepts the near-miss.
- Truly blocked: write a checkpoint in `PROGRESS.md`, state exactly what is missing and whose move it
  is, and say so plainly. Never dress a blocker as completion.

## Step 8 - Closeout report

Every plan (and every phase report along the way) ends with:

1. **Recap** - what was asked, what was done, in plain sentences.
2. **Proof** - commands run with results, artifacts, criteria table with pass/fail.
3. **Spend report** - tokens used (subscription: report tokens, never fake dollar amounts); for paid
   APIs: "computed floor $X; true spend = provider console".
4. **Ranked suggestions** - the next highest-leverage moves, ordered, with rough cost.

## Standing gates (never overridden by a plan)

Deploy, git push, paid/live API calls, production DB or credentials, deleting/overwriting real data,
sending emails/messages, publishing - all require explicit owner approval, every time, even
mid-plan. A plan approval is NOT a deploy approval.
