---
description: Reference for running Fable 5, the local review engine (plan attack, build gate, expert layer, hooks).
---

# Fable 5 review engine

Fable 5 is a local, Python stdlib-only orchestrator under `tools/fable5/`. It runs
deterministic checks (tests, lint, build, docs staleness) concurrently, optionally adds
an expert (Claude subagent) layer, and writes evidence to `reports/fable5/<run-id>/`.

## Commands

- `python -m tools.fable5 doctor` - inventory local tools, agents, skills, plugins.
- `python -m tools.fable5 review-plan <path.md>` - attack a Markdown plan before
  implementation. Exit 0 ready, 1 needs work, 2 blocked.
- `python -m tools.fable5 review-build --gate fast` - run the deterministic check
  arsenal for a gate (`fast`, `pr`, `release`, `monthly`).
  - `--plan <path.md>` also reviews and includes a plan in the run report.
  - `--only <check-id> ...` runs only the named checks.
  - `--dry-run` shows the schedule without running anything.
  - `--with-experts` adds the Claude subagent layer (uses the subscription; never
    live paid API calls unless `--allow-paid-fallback` is also passed).
  - `--allow-network` / `--allow-live` / `--allow-paid` / `--allow-mutating` opt a
    check into a risk class it is otherwise safety-gated out of. Off by default.

## Exit codes

0 PASS. 1 needs work / engine error (never treat as a clean pass). 2 BLOCK (plan
blocked or a blocking check failed). 3 refused (run lock already held, or a
hook-triggered run requested a refused flag).

## Where reports live

Each run writes `reports/fable5/<run-id>/report.md` (plus `report.json` and per-check
logs) and updates `docs/reviews/LATEST.json` with the verdict, run id, report path, top
blockers, and a cost note. `LATEST.json` is what the SessionStart hook reads to greet a
new session with the latest verdict in one line.

## Hook-triggered runs (structural guard)

When the Stop hook auto-launches a review after a plan phase completes, it sets
`FABLE5_HOOK_TRIGGERED=1`. Under that env, review-build is deterministic-only in code,
not just by convention: `--with-experts`, `--allow-network`, `--allow-live`,
`--allow-paid`, `--allow-mutating`, and `--allow-paid-fallback` all exit 3 with a
refusal reason if passed; heavy and browser resource-class checks are forced to
skipped; the whole run has a 15 minute wall-clock cap. Only one review can run at a
time (`.fable5/run.lock` + `.fable5/running.json`); a second concurrent invocation
exits 3 naming the PID already holding the lock.

## Billing preflight note

Fable 5 experts run on the Claude subscription (not metered API billing) by default,
and cost is treated as fail-closed unless `--allow-paid-fallback` is passed. Report
`cost_note` always reads "subscription; true spend = provider console" - reconcile any
real spend against the provider console, never trust computed estimates alone.
