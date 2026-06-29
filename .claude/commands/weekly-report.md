---
description: Run the Smart Inventory weekly report. ONE self-contained HTML owner report (by teams, every item numbered), built by the budget-capped judgment Workflow on top of the qa:bots + inventory-review layers. Two modes only - lean (default) and deep. Report-only unless --apply.
argument-hint: "[--mode=lean|deep] [--deep] [--refresh] [--apply] [--live-accuracy] [--date=YYYY-MM-DD]"
allowed-tools: Task, Read, Write, Edit, Grep, Glob, Bash(npm run qa:bots*), Bash(npx playwright*), Bash(node*), Bash(git*), Workflow
---

You are the **synthesis lead** for Smart Inventory's weekly report. You drive the budget-capped
judgment Workflow over the app's screenshots and bot results, fold in the live decode accuracy bot and
the cost ledger, and render ONE self-contained HTML report for Santiago, a non-engineer owner. Plain
English, grouped BY TEAM, every finding and fix NUMBERED so he can say "do all except #4 and #9".

Arguments: `$ARGUMENTS`
Parse: `--mode=` (default `lean`; `--deep` is shorthand for `--mode=deep`), `--refresh` (re-run
`npm run qa:bots` to regenerate screenshots first; default OFF = judge the latest existing proof),
`--apply` (default OFF -> report-only; you MUST NOT edit app code or touch git when absent),
`--live-accuracy` (default OFF -> the accuracy bot (20 general + 100 tire) runs DRY at $0; ON -> it spends real
third-party cash within the cap), `--date=` (default today).

Honor every project gate: **never deploy, never push, never merge, never run live AI without the
gate, never touch `src/` app code, never bypass the Human Bot Proof Gate, no em dash or en dash in
any report copy, real screenshot paths only.** There are exactly TWO modes. Do not invent a third.

## Step 0 - refresh (only if `--refresh`)
`npm run qa:bots` (mock backend, deterministic, $0). If absent, judge whatever screenshots exist.
If no screenshots exist at all, tell the user to run `--refresh` first.

## Step 1 - evidence (main agent)
Collect, without printing secrets:
- `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD`, `git status --porcelain` (changed files).
- Screenshot manifest (newest first): `e2e/proof/agent-bots/**`, `e2e/proof/human-bots/**`,
  `e2e/proof/daily-*/**`, `e2e/proof/demo-readiness/**`, top-level `e2e/proof/*.png`.
- Bot scorecards: `reports/agent-bots/latest/*.md`, `reports/human-bots/latest/*.json`.
- Intel store if present: `reports/product-intel/_intel/{known-issues.json,scores-history.json,PLAYBOOK.md}`
  (create the folder on first run).
Set `reportDir = reports/product-intel/<date>`.

## Step 2 - live decode accuracy bot (gated spend)
Run `node scripts/weekly-accuracy.ts --out=<reportDir> --date=<date>` (DRY, $0) by default.
- If `--live-accuracy` is set: FIRST state the cap ($0.50 lean / $2 deep) and that real cash will be
  spent, then run `LIVE_AI_TEST=1 THIRDPARTY_CAP_USD=<cap> node scripts/weekly-accuracy.ts --out=<reportDir> --date=<date>` (add `--deep` in deep mode).
  This needs the dev server running with provider keys; if it is in IS_E2E mock or keys are missing,
  the bot stays at $0 and says so.
- If the fixture `data/accuracy/hard-codes.json` is not owner-confirmed, the score is PROVISIONAL.
  The bot writes `accuracy.json` and merges spend into `cost.json`.

## Step 3 - the judgment Workflow
Invoke the Workflow `scripts/weekly-report.workflow.js` with args:
`{ mode, deep, target: "local", date, reportDir, screenshots: [<manifest>] }`.
Model routing (owner policy): Haiku is reserved for mechanical helpers only (none run as agents).
Lean dispatches ~10 core lenses on **Sonnet** plus a final **Opus** qa-triage synthesis. Deep adds the
full fleet on Sonnet, with an **Opus judge panel for every high or blocker finding**, an Opus
completeness critic, and Opus final synthesis. It returns `{ findings, scores, competitors,
priorities, overall, transparency }`. The Claude
fleet runs on the owner subscription (zero out-of-pocket cash); the Workflow stops dispatch if a token
budget is set and reached, and the report says so.

## Step 4 - assemble + render (deterministic)
Read `accuracy.json` and `cost.json` from `reportDir`. Set `cost.claude.agents` to the Workflow lens
count and `cost.claude.estTokens` to a best-effort estimate (label it estimate). Build the render data:
```
{ meta: { product:"Smart Inventory", date, mode, branch, commit, overallScore: overall, overallDelta },
  summary: "<3-4 plain-English sentences YOU (the main agent, Opus) write: biggest win, biggest risk, what to do first>",
  findings, scores, competitors, priorities,
  accuracy: <from accuracy.json, set provisional from the fixture>,
  changed: { since, better, worse, unknown, stillOpen } (diff scores + known-issues vs last run),
  cost: <cost.json>, transparency }
```
Write it to `<reportDir>/data.json`, then render:
`node scripts/lib/report-render.mjs <reportDir>/data.json <reportDir>/report.html`.
The renderer assigns every finding a stable number, groups by team, and FAILS (exit 2) if any em or en
dash slips into the copy. Also write `<reportDir>/findings.json` and `<reportDir>/scores.json`.

## Step 5 - intel + STATUS (always, bounded)
Append NEW issues to `known-issues.json`; bump `last_seen` on re-sightings; flip regressions. Append
this run to `scores-history.json`. End with exactly one line:
`STATUS: mode=<mode> date=<date> overall=<n> new=<n> regressions=<n> thirdPartyUsd=<$> report=<reportDir>/report.html`

## Step 6 - apply (ONLY if `--apply`)
If absent, skip. If present, reuse ONLY the existing `/inventory-review` safe auto-fix gate
(simplicity-enforcer veto, lint+test gate, branch + commit, never push). Do NOT expand auto-fix
behavior. Never touch secrets, firebase, env, resolver/idempotency, or `src/` security logic.

Constraints recap: two modes only; one HTML report; report-only unless `--apply`; no deploy/push/merge;
flood/scrape tests are localhost + mock only; no live AI spend unless `--live-accuracy`; no em or en
dashes; real screenshot paths only.
