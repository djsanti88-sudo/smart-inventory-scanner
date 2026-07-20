# Canary plan

## Problem / Context
Canary tests verify detectors.

## Goals / Success criteria
- All 1 canary checks must pass. Proof: `tools/fable5/fixtures/selftest/plan.md`.

## Proof / Testing
- Review the fixture and require a ready verdict.

## Risks / failure modes
- A detector could miss its seeded defect.

## Rollback / recovery
- Remove the scratch directory.

## Out of scope
- Production changes.

## Files to touch
- The fixture plan only.

## Cost / token budget
- Local checks use zero paid API calls.
