---
name: risk-based-exploration
description: Pick at least one previously untested feature x persona x state x viewport combination from COVERAGE_MATRIX.json every teach-bot run instead of re-testing the same happy path
---

# Risk-Based Exploration

Live testing against `https://inventory-lovat-six.vercel.app` costs real time and can write real
data - it must never spend a whole run re-covering ground already proven. This skill enforces
that each run pushes the coverage frontier outward.

## Before exploring

1. Read `testing/app-knowledge/COVERAGE_MATRIX.json`. It tracks which combinations of
   **feature x persona x state x viewport** have been exercised, and how recently / how
   successfully.
2. Read `testing/app-knowledge/RUN_HISTORY.jsonl` for recent run summaries - what was covered
   last time, what broke, what's still open.
3. Identify the matrix cells that are: untested (never exercised), stale (not exercised in a
   long time and the app has since changed), error-prone (previously found a bug or flake here),
   boundary (edge-of-range inputs: empty, huge, zero, negative, duplicate, max-length), or
   role/viewport combos nobody has tried (e.g. supplier persona on mobile viewport, or an action
   only an owner role should be able to do, attempted as a lower role).

## Prioritization order for picking today's target(s)

1. Untested feature x persona combos (highest priority - pure coverage gap).
2. Previously errored/flaky combos (need a clean re-check or a confirmed repro).
3. Boundary/edge-case inputs on already-covered features (empty CSV, single-row CSV, 10,000-row
   CSV, barcode with leading zeros, duplicate barcode within one session).
4. Role-crossing checks (does a lower-privilege persona get blocked from an owner-only action;
   does a persona see only their own tenant's data - hand off to `data-integrity` for the actual
   isolation check).
5. Viewport crossing (mobile vs desktop) on features only ever tested in one viewport.
6. Only after 1-5 are considered should a run repeat a known-good happy path (as a lightweight
   regression check, not the main event - full regression lives in `npm run teach:regression`).

## During the run

- Pick **at least one** genuinely new cell before starting the generic regression pass.
- Note in your working notes which matrix cell(s) you are targeting and why, so the coverage
  update at the end is traceable.
- If everything in the matrix looks covered, manufacture a new dimension (a new input shape, a
  new persona combination, a new device size) rather than declaring "nothing left to test."

## After the run

- Update `COVERAGE_MATRIX.json` with the new cell(s) exercised, outcome (pass/fail/flaky), and
  timestamp. Append a summary line to `RUN_HISTORY.jsonl`.
- Do not silently drop a cell that turned out hard to reach - record it as attempted-blocked with
  the reason, so the next run doesn't have to rediscover the same obstacle.
