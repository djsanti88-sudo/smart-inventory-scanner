---
name: playwright-santi
description: Run and manage a Teach Bot session - the self-learning Playwright harness that drives the LIVE Scanbin app as 3 business-owner personas, learns it each run, and reports bugs WITHOUT fixing anything. Owner-triggered only (real accounts + real decode spend). Use when the owner types /playwright-santi to self-check, run, triage, clean up, or run regression.
disable-model-invocation: true
---

# /playwright-santi — drive Teach Bot

You are operating the **Teach Bot** harness (full docs: `e2e/teach/README.md`). It drives the LIVE app as 3
synthetic TEACH-BOT personas, gets smarter each run, and reports findings. Your job is to run it, read what
it produced, and **triage honestly** — never to fix the app.

## Hard rules (never break)
- **Diagnose only.** Never edit product source, the decode ladder, or `testing/app-knowledge/LOCKED_REQUIREMENTS.md`.
  Findings are reports with options; the owner decides fixes.
- **Sacred laws are report-only** (Scan N = count N, idempotency, vendor-never-auto-verify, tenant isolation).
- **Live run is owner-gated.** `npm run teach` creates **real Firebase accounts + data** and may **spend real
  money** on live decode against production. Confirm the target and get an explicit "go" before running it.
  Offer a preview URL (`TEACH_TARGET_URL=<preview>`) for a safe shakedown.
- **Never push, deploy, or auto-promote** a candidate test to `testing/tests/permanent/`.
- **Never print secrets.** Passwords/tokens never appear in your output.

## Modes (parse the argument; if none, ask which)
- **`self-check`** → `node e2e/teach/teach.mjs --self-check`. Safe: no browser, no accounts, no spend.
  Confirms target + the run's lesson plan. **Always offer this first.**
- **`run`** (owner-gated) → confirm target + explicit go, then `npm run teach` (background so the 3 headed
  windows are watchable). Default target is prod `https://inventory-lovat-six.vercel.app`; `run --target <url>`
  or `TEACH_TARGET_URL=<url>` to override. To force the FULL curriculum in one pass without faking the real
  ledger, point `TEACH_KNOWLEDGE_BASE` at a throwaway base whose `RUN_HISTORY.jsonl` has >=12 lines (run
  number = history length + 1; run N runs lessons 1..N; >=12 runs everything incl. the smoke-every-control lesson).
- **`loop`** (owner-gated) → `npm run teach -- --loop --one-window [--persona tire]`. ONE headed window, ONE
  persona, **reuses a single account** across rounds (creds in-memory, no sprawl), deepens the curriculum each
  round (gets smarter), and runs **until the owner presses Ctrl-C** (graceful stop). ONE aggregate decode
  budget caps total paid spend across the whole loop. A cumulative `testing/artifacts/<loopId>/LOOP_REPORT.md`
  updates every round (rounds, run number, deduped findings, coverage growth, spend, "still learning?"). Tell
  the owner the LOOP_REPORT path and that they stop it with Ctrl-C.
- **`triage <runId>`** → read `testing/artifacts/<runId>/report.json` and adjudicate each finding
  **app-bug vs test-bug**. Reproduce before confirming. Remember: lessons can **over-report** (e.g. not
  accounting for a prior lesson's scan, a `countedTotal` helper that only sums `qty-*` cells, or a lesson
  scanning on a page with no scan input). Present the honest split with options; do not trust `pass/fail`
  blindly.
- **`cleanup <runId>`** → `npm run teach:cleanup -- --run-id <runId> --dry-run` (then `--confirm` only if the
  owner says so). It is manifest-scoped (no blind sweeps). NOTE: Firestore delete is currently a stub and Auth
  users can't be deleted from the client — list the exact accounts/businesses for **manual Firebase-console**
  removal.
- **`regression`** → `npm run teach:regression` (approved permanent tests vs the live URL).

## After any run, always report
1. Pass/fail per lesson **with your triage** (which failures are real app questions vs harness measurement bugs).
2. The **ladder diagnosis** table (which rung settled, reached-GPT-or-escaped, partial identity) if any traces
   were captured.
3. The **spend line** verbatim (estimated floor/upper - "true spend = provider console").
4. The **created-data list** (accounts + businesses) so the owner can clean up.
5. Anything sacred-law-flagged (`locked:true`) — surfaced, never acted on.

## Get smarter every run (required)
The point of this skill is to grow more fluent in the app on every invocation. Each run MUST:
1. **Read prior knowledge first** — `testing/app-knowledge/APP_EXPERT.md` (routes, roles, terminology,
   workflows, verified testids, decode-ladder fields), `COVERAGE_MATRIX.json`, `RUN_HISTORY.jsonl`,
   `DISCOVERIES.md`, `BUGS.md`. Start from what is already known; do not re-derive it.
2. **Learn, then persist what's new** — after the run, append to `APP_EXPERT.md` anything newly learned about
   how the app really behaves (a new route/screen, a corrected/added testid, a workflow quirk, an actual
   response shape), append notable behaviors to `DISCOVERIES.md`, update `COVERAGE_MATRIX.json` (feature x
   persona x state x viewport), and append the run to `RUN_HISTORY.jsonl`. These writes are the orchestrator's
   single atomic end-of-run write. **Never** write `LOCKED_REQUIREMENTS.md`.
3. **Cover more each time** — the curriculum is cumulative (run N re-proves lessons 1..N) and picks one new
   untested area (`pickExploration` / `risk-based-exploration`), so coverage strictly grows.
4. **Fix the harness's own understanding, not by silent self-rewrite** — when a lesson's selector/step turns
   out wrong on the live app (a test-bug, not an app-bug), capture the corrected reality in `APP_EXPERT.md` /
   `DISCOVERIES.md` immediately (that is learning). Any change to the LESSON CODE or orchestration that acts on
   it is a **reviewed diff the owner approves** (see the no-self-rewrite rule) — the skill gets smarter by
   accumulating knowledge and owner-approved improvements, never by auto-editing its own logic into drift.
5. **Accumulate candidate tests** — stable, trustworthy discoveries become `testing/tests/candidates/` notes;
   the owner promotes the good ones to `testing/tests/permanent/`. Over time the regression suite deepens.

Net effect: every `/playwright-santi run` starts from a richer `APP_EXPERT.md`, tests more of the app, and
proposes better-targeted next steps than the run before.

## Reference
`e2e/teach/README.md` (architecture + current caveats), and the companion skills `data-integrity`
(the invariants to check) and `evidence-and-bug-triage` (repro + classification bar).
