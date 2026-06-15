# Scheduled QA Bots — Weekly Report-Only Plan

**Branch:** `demo-readiness-vercel-partnumber` (base `7090873`).
**Mode:** **Report-only.** Bots inspect, test, screenshot, and recommend. They **never** edit code,
commit, deploy, or modify real Firestore data. **All fixes require human approval.**

> This document describes the plan and adds **one** package script (`qa:weekly-report`). It does **NOT**
> add GitHub Actions, Vercel cron, or any automatic-fix mode (explicitly out of scope for now). Wiring this
> to an actual scheduler is a later, separate, human-approved step.

---

## 1. Goal
Once a week, run the existing QA bot suite in a safe, read-only way, produce a single human-readable report
plus machine-readable results, and **fail loudly if any P0 is found**. A human then decides on fixes.

## 2. Hard rules (non-negotiable)
1. Bots run on a schedule **later** (not wired up yet).
2. Bots do **not** edit code.
3. Bots do **not** commit.
4. Bots do **not** deploy.
5. Bots do **not** modify real Firestore data (they run against the mock/in-memory backend or emulator).
6. Bots only **inspect, test, screenshot, generate reports, and recommend**.
7. If a **P0** is found → the run **fails** (non-zero exit) and reports it.
8. **Fixes require human approval.** No auto-remediation.

## 3. Suggested schedule
- **Weekly**, Sunday night or Monday morning (low-traffic window).
- Aligns with the owner's existing Monday-morning routine.

## 4. Command
```
npm run qa:weekly-report
```

### What the script runs (added in this window — report-only chain)
The existing per-suite bot configs already write their reports/screenshots under `reports/…/latest/`.
`qa:weekly-report` chains the **read-only** inspection suites:

```
qa:bots:security  →  role-security-leak + export-leak  (SecurityLeakBot; P0 gate)
qa:bots:data      →  data-integrity
qa:bots:tire      →  platformOwner-tire-resolution
qa:bots:ux        →  ux-no-training
```

These use Playwright against the app's mock backend (no real Firestore writes, no deploy, no secrets).

### Heavier optional gate (run manually, not chained by default)
`npm run qa:revision` runs `tsc --noEmit` + `eslint` + `next build` + full Playwright + Firebase
**emulator** tests + all bots. It is intentionally **left out** of the default weekly chain because it
requires the Firebase emulator and is heavy/slower — running it unattended would be flaky. Run it manually
(with emulators available) when a deeper pre-release pass is wanted. Document any P0 it surfaces the same way.

## 5. Suggested output layout (for the future scheduler/aggregator step)
```
reports/scheduled-bots/latest/
  WEEKLY_QA_REPORT.md      # human-readable: per-suite pass/fail + P0/P1/P2 recommendations + approval section
  results.json             # machine-readable roll-up { suite, status, p0, p1, p2, findings[] }
  screenshots/             # proof images copied from each suite's run
```
> Today the per-suite reports already land under `reports/agent-bots/latest/` and
> `reports/human-bots/latest/`. A small **read-only aggregator** that copies/rolls these into
> `reports/scheduled-bots/latest/` is a future, human-approved addition (it must not modify source data) —
> it is **not** built in this window to avoid scope creep.

## 6. Report contents (target format)
Each weekly `WEEKLY_QA_REPORT.md` should contain:
1. Run date/time + commit hash.
2. Per-suite result table (security / data / tire / ux): pass | fail, counts of P0/P1/P2.
3. **P0 section** — if non-empty, the run is a FAILURE; list each finding + file + recommended fix.
4. **P1 / P2 recommendations** — prioritized, with suggested (not applied) fixes.
5. **Human approval section** — checkboxes: *"Approve fix for finding #N? (requires a human + a new branch)."*
6. Explicit note: *no code was changed, nothing was committed or deployed by this run.*

## 7. P0 failure policy
- Any P0 (e.g. SecurityLeakBot finds a sensitive-field exposure) → the run exits non-zero so a future
  scheduler marks it failed and notifies a human. **No automatic fix.**

## 8. Explicitly NOT included (now)
- ❌ GitHub Actions workflow.
- ❌ Vercel cron / scheduled function.
- ❌ Automatic-fix mode.
- ❌ Any write to real Firestore or production.

These remain future, separately-approved steps.
