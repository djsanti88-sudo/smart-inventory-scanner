# Teach Bot — self-learning live-app testing harness

A Playwright system that drives the **live** Scanbin app as 3 synthetic business-owner personas, learns
the app a little more every run, and reports every bug / empty field / slow load / nice-to-have plus a
decode-decodeTrace diagnosis. It is **diagnose-only**: it never fixes the app, and it never turns an observed
behavior into an approved test on its own.

> Additive testing infrastructure only. Nothing here modifies product runtime or business-logic source —
> only `e2e/teach/`, `testing/`, `.claude/`, and config are added.

## Non-negotiable rules (owner law)
1. **Diagnose only; no self-rewrite.** The bot may auto-update learned knowledge, coverage, run history, and
   *candidate* tests. It may NOT change orchestration/skill logic, edit `LOCKED_REQUIREMENTS.md`, or promote a
   permanent test on its own. Those change only via a reviewed diff the owner approves.
2. **Observed != correct.** A reproducible behavior can be a reproducible *bug*. Generated tests land in
   `testing/tests/candidates/` and are promoted to `testing/tests/permanent/` only on an owner-approved match
   to a locked requirement / explicit requirement / existing approved test.
3. **Sacred law — flag, never change.** Violations of Scan N = count N, idempotency, vendor-never-auto-verify,
   or tenant isolation become `locked:true` report-only findings. `testing/app-knowledge/LOCKED_REQUIREMENTS.md`
   is never written by code (enforced in `knowledge.mjs`). The decode decodeTrace is observed read-only and may be
   *diagnosed/proposed*, never modified without explicit owner approval.
4. **Secrets never leave.** Passwords (CSPRNG-generated), tokens, cookies are never written to the manifest,
   report, knowledge files, or logs.
5. **Budget honesty.** Hard caps are paid-lookups + time; spend is reported as an estimated floor/upper bound,
   never claimed exact ("true spend = provider console").

## Commands
| Command | What it does |
|---|---|
| `node e2e/teach/teach.mjs --self-check` | **Safe** dry check: prints deployment stamp + the run's lesson plan; zero browser, zero network, zero spend, real knowledge files untouched. |
| `npm run teach` | **OWNER-GATED live run.** Creates 3 real accounts, drives the app, may spend on live decode. Opens at most 2 headed windows at once (split-screen left/right); with 3 personas, runs in batches of 2 then 1. |
| `npm run teach -- --loop --one-window [--persona tire]` | **OWNER-GATED loop.** ONE window, ONE reused account, deepens each round, runs until Ctrl-C. One aggregate decode budget caps total spend. Writes a running `testing/artifacts/<loopId>/LOOP_REPORT.md`. |
| `npm run teach:test` | Unit suite for the harness (`node --test`, 127 tests). |
| `npm run teach:cleanup -- --run-id <id> --dry-run` | List what a run created (accounts/businesses) from its manifest. |
| `npm run teach:cleanup -- --run-id <id> --confirm` | Remove that run's data (manifest-scoped only — no blind sweeps). |
| `npm run teach:regression` | Run the approved permanent tests (`testing/tests/permanent`) against the live URL. |

**Target:** defaults to production `https://inventory-lovat-six.vercel.app`. Override with
`TEACH_TARGET_URL=<url>` (use a preview deployment for a safe shakedown). A live run **creates real Firebase
accounts + data and can spend real money** — trigger it deliberately.

## Budget / limits (env)
`TEACH_MAX_PAID_LOOKUPS` (default 15), `TEACH_MAX_REQUESTS` (400), `TEACH_MAX_MINUTES` (30),
`TEACH_ESTIMATED_MAX_USD` (3, advisory). Hard gates: paid-lookup count + time.

## Architecture (`e2e/teach/`)
- `teach.mjs` — orchestrator. Reads knowledge → run number, loads lessons, launches headed browsers in
  batches of at most `MAX_CONCURRENT_WINDOWS` (default 2, split-screen left/right via
  `personas.computeSplitLayout`; batching via `batchPersonas`) so no more than 2 windows are ever visible
  at once - each batch's windows fully close before the next batch launches (isolated context per persona,
  shared aggregate budget), probes deployment, signs up, runs the plan (fault-isolated per persona), does
  ONE atomic knowledge write at the end, writes a candidates *note* (never auto-promotes), stamps the
  report with URL/git-sha/version/browser/timestamp, prints the spend line. `--self-check` runs against a
  temp knowledge base so it is side-effect-free. `--help`/`-h` prints usage and exits without any side
  effects; an unrecognized flag errors out (exit 1) instead of falling through to a live run.
- `report.mjs` — builds `report.md` + `report.json` (bugs, empty fields, performance, nice-to-haves, decodeTrace
  diagnosis table, created-data list, coverage delta, spend).
- `personas.mjs` — 3 TEACH-BOT personas (tire/cstore/supp, one mobile), synthetic non-deliverable emails
  (`teachbot+<runId>-<key>@scanbin-teachbot.test`), deployment probe (`live_auth` vs `demo_open`), real
  Firebase signup + business-create flow, isolated contexts, CSPRNG passwords (in-memory only).
- `curriculum.mjs` — cumulative selection (`run N = lessons 1..N`), `pickExploration`, `loadLessons` + the
  `LESSON_CONTRACT`.
- `lessonHelpers.mjs` — DOM-based helpers (on prod `window.__scanStore` is NOT exposed, so assertions use
  testids): scan/wedge, feedCount, countedTotal, reviewRow, setOffline, timeToUsable, `attachDecodeTraceCapture`.
- `lessons/1..11` — the curriculum (see below). Each returns `{pass, findings, learned, notes}`.
- `decodeTrace.mjs` — read-only parse of the `/api/ai-lookup` response `debug.decodeTracePath` / `decodeTraceReasons` /
  `gptDecodeSkipReason`: which source settled, did it reach GPT or escape, partial-identity flag.
- `triage.mjs` — classify a finding (`confirmed_app_bug | probable_app_bug | test_bug | test_data_problem |
  environment_problem | flaky`); a suspected app bug must reproduce twice before "confirmed".
- `sheets.mjs` — generates inventory spreadsheets in escalating messy formats (renamed/shuffled cols,
  TSV/semicolon, XLSX, junk cols, typo brands) + Shop-Ware reconcile CSVs.
- `knowledge.mjs` / `manifest.mjs` — atomic read/merge/write of the knowledge files (with the LOCKED guard +
  secret guard); per-run `RUN_MANIFEST.json` (started/completed/aborted) for crash recovery + cleanup.
- `cleanup.mjs` — `teach:cleanup` CLI. `HEALER.md` — how to run the official Playwright healer safely (in a
  disposable worktree, patch for approval — never auto-heal in place).

## Persistent knowledge (`testing/app-knowledge/`)
`LOCKED_REQUIREMENTS.md` (sacred, never auto-edited) · `APP_EXPERT.md` (auto-learned) ·
`COVERAGE_MATRIX.json` · `RUN_HISTORY.jsonl` · `DISCOVERIES.md` · `BUGS.md`. Tests split:
`testing/tests/candidates/` (untrusted) vs `testing/tests/permanent/` (approved). Artifacts (screenshots,
traces, video, `report.md`, `RUN_MANIFEST.json`) go to `testing/artifacts/<runId>/` (gitignored). Only the
orchestrator writes shared knowledge (atomic; personas never write concurrently).

## The curriculum (cumulative: run N runs lessons 1..N + one exploration)
1 signup + first scan · 2 Scan N = count N (L1) · 3 teach an alias · 4 offline/reconnect (L5) ·
5 keyboard-wedge scanner · 6 refresh + duplicate resilience · 7 live decode + decodeTrace trace (budgeted) ·
8 import clean CSV · 9 import messy formats · 10 reconcile equal/different · 11 deep tenant isolation (L6).

> **Lesson 7 is code-gated off by default.** It fires up to 3 real paid `/api/ai-lookup` calls.
> It only runs when `TEACH_ALLOW_LIVE_DECODE=1` is set in the environment; otherwise it skips with an
> honest logged reason (`live_decode_not_opted_in`) and spends nothing. This is enforced in code
> (`lessons/7-live-decode-trace.mjs`), not just by this note.

## Tooling
`@playwright/cli` (terminal Playwright/MCP driver) + official planner/generator/healer agents
(`.claude/agents/playwright-test-*.md`, `.mcp.json`) + 6 project skills under `.claude/skills/`
(app-expert, real-user-ux, risk-based-exploration, data-integrity, evidence-and-bug-triage,
continuous-live-testing — the last is manual-invoke only). Hybrid model: CLI/agents explore + generate;
the Playwright library orchestrates the deterministic 3-browser run; `@playwright/test` runs permanent
regression.

## Current state / honest caveats (as of first live runs, 2026-07-22)
- Prod is in `live_auth` mode (the accounts/multi-tenant build is deployed); signup works end-to-end.
- The lessons were unit-shaped and **not live-verified until the first prod run**, so they **over-report**:
  several first-run "failures" were the harness's own measurement bugs (a lesson not accounting for a
  prior lesson's scan; `countedTotal` summing only `qty-*` cells; a lesson attempting to scan on `/reconcile`
  which has no scan input). Triage every finding before trusting it — that is the point of `triage.mjs`.
- Genuinely worth investigating (report-only, unverified): `/api/reconcile/match` returns 200 for a foreign
  `businessId`; whether unidentified scans count in session totals per the top-level law.
- `teach:cleanup` currently deletes nothing (Firestore delete is a safe TODO stub; Auth users can't be
  deleted from the client) — created accounts/businesses must be removed by hand via the Firebase console.
- Built in an isolated git worktree; the deliverable is a single clean commit with zero product-source
  changes. Not pushed.
