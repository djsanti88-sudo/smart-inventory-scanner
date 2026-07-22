# Fixture plan (missing proof)

## Problem / Context
Fixture plan used to prove the proof-audit blocks criteria with dead or absent proof refs.

## Goals / Success criteria

| # | Done means | Proof |
|---|---|---|
| 1 | A script that does not exist runs clean | `npm run does-not-exist-xyz` |
| 2 | Something happens with no way to check it | none |

## Proof / Testing
- No commands to run here on purpose.

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
