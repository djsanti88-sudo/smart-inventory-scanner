---
name: continuous-live-testing
description: The full teach-bot orchestration loop against the real live Scanbin app - reads knowledge, runs regression, explores untested risk, captures evidence, and updates persistent knowledge. Owner-triggered only; spends live money and writes real production data.
disable-model-invocation: true
---

# Continuous Live Testing (Teach Bot orchestration loop)

This is the top-level loop that drives a full "teach bot" session against the real, live app at
`https://inventory-lovat-six.vercel.app`. It is **manual-invoke only** - it is never picked
automatically by the model, because it exercises real Firebase signup, may burn paid AI decode
calls, and writes real rows into production. The owner invokes it explicitly.

## Entry points

- `npm run teach` runs the orchestrator (`e2e/teach/teach.mjs`) for a live session.
- `npm run teach:cleanup -- --run-id <id> --dry-run` (then `--confirm`) removes synthetic data a
  run created. Always dry-run first and review before confirming.
- `npm run teach:regression` runs the permanent regression suite
  (`testing/tests/permanent/`) - the trusted, owner-approved subset.

## The loop, in order

1. **Read knowledge first.** Load `testing/app-knowledge/APP_EXPERT.md`,
   `LOCKED_REQUIREMENTS.md` (read-only, sacred), `COVERAGE_MATRIX.json`, and the tail of
   `RUN_HISTORY.jsonl`. Use the `app-expert` skill's guidance for how to read and later update
   this knowledge.
2. **Establish persona + goal.** Pick one of the 3 TEACH-BOT personas (tire shop / cstore /
   supplier, synthetic emails, real Firebase signup - no email verification needed) and state
   what this run is trying to learn or verify.
3. **Run known critical workflows (regression).** Exercise the permanent, trusted test set
   (`testing/tests/permanent/`, or `npm run teach:regression`) to confirm nothing that used to
   work has broken.
4. **Pick one untested area.** Use `risk-based-exploration` to choose at least one
   feature x persona x state x viewport cell that hasn't been covered, or that's stale/error-prone.
5. **Explore via Playwright.** Drive the real app using the `playwright-cli` tools
   (open/goto/click/fill/snapshot/find/eval/press/keydown, `network-state-set online|offline`,
   `response-body`, `console`, `requests`) or the official Playwright MCP tools. Apply
   `real-user-ux` behaviors (misreads, back button, refresh, double-click, abandonment, mobile
   viewport) while exploring, not just the clean happy path.
6. **Check the sacred invariants.** Every run, regardless of what else it explores, must run the
   `data-integrity` checks (scan N = count N, dup-scan increments, unknown stays counted,
   UPC+part-number merge, missing-alias survival, tenant isolation from every angle). These never
   get skipped for time.
7. **Capture evidence and reproduce.** Anything that looks wrong gets the `evidence-and-bug-triage`
   treatment: reproduce (2x unless unsafe), screenshot/trace/console/network evidence, correct
   classification, logged to `testing/app-knowledge/BUGS.md`.
8. **Separate app-bug vs test-bug.** Before touching any test file, decide honestly whether the
   failure is the app's fault or the teach-bot's own script/assumption being wrong. Only real app
   defects get filed as bugs.
9. **Convert stable discoveries into candidate tests - never auto-promote.** If a workflow proved
   itself stable and trustworthy across this run (and ideally prior runs), write or update a
   Playwright test under `testing/tests/candidates/` (untrusted tier). A reproducible BUG is not
   "correct behavior" - never write a candidate test that encodes a confirmed bug as the expected
   result. Promotion from `candidates/` to `permanent/` is a separate, owner-reviewed step, not
   something this loop does automatically.
10. **Update coverage and app knowledge.** Update `COVERAGE_MATRIX.json` and
    `RUN_HISTORY.jsonl` per `risk-based-exploration`, and update `APP_EXPERT.md` per
    `app-expert` with anything newly learned about routes/terminology/workflows/testids.
11. **Compare against prior runs.** Check whether previously open bugs are now fixed, still open,
    or regressed; check whether coverage genuinely grew versus the last entry in `RUN_HISTORY.jsonl`.
12. **Stop at the limit.** Respect whatever time/cost/coverage limit was given for this run (owner
    sets this per invocation). Do not keep spending live API calls or writing more synthetic data
    once the limit is hit - close out cleanly, writing a final summary of what was covered, what
    was found, and what remains.

## Hard rules carried from other skills

- Never edit `LOCKED_REQUIREMENTS.md`.
- Never auto-apply a Playwright healer's fixes to tests in place - see `e2e/teach/HEALER.md`.
- Never treat a confirmed bug's actual behavior as the new expected behavior in a test.
- Never record secrets/PII in knowledge files or evidence.
- This skill writes real production data (via real Firebase signup) - `npm run teach:cleanup` is
  the mechanism to remove it; always dry-run before confirming deletion.
