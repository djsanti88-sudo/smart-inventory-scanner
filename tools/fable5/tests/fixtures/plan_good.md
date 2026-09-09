# Fixture plan (good)

## Problem / Context
Fixture plan used to prove the proof-audit accepts criteria with real, existing proof refs.

## Goals / Success criteria

| # | Done means | Proof |
|---|---|---|
| 1 | Unit suite passes | `npm run test` |
| 2 | Plan template stays the canonical structure | `docs/PLAN_EXECUTION.md` |

## Proof / Testing
- Run `npm run test` and require exit code zero.

## Risks / failure modes
- None beyond normal test flake.

## Rollback / recovery
- Revert the fixture file.

## Out of scope
- Everything else.

## Files to touch
- This fixture only.

## Cost / token budget
- Zero. Offline fixture.
