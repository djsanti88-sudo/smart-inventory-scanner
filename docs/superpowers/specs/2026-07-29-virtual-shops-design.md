# Virtual Shops Harness — Design

Design-only document. No code in this round. Written for Lane 3 (docs consolidation), branch
`chore/docs-consolidation`, per master plan §3b-A Lane 3 + docs plan §8b.5.

## Purpose

Four always-on, mock-only virtual "shops" that exercise Scanbin the way real different shops would,
day after day, and log every piece of friction they hit. They are not a replacement for the human-bot
QA fleet (`e2e/human-bots/`, judgment-first, screenshot-driven) or Teach Bot (`e2e/teach/`, learns the
LIVE deployed app). Virtual shops are deterministic, repeatable, mock-backend load/behavior simulators
that build a long-running friction and confidence record per shop archetype, so regressions in real
day-to-day usage patterns show up before a human ever hits them.

## What already exists that this reuses

| Piece | Location | Reused for |
|---|---|---|
| Mock AI status + `/api/ai-lookup` route stub | `e2e/persona-drive.mjs`, `e2e/stress-drive.mjs` (`NO_AI_STATUS`, `page.route`) | Every shop's decode calls stay mocked and free; copy this exact stub, never a live provider |
| Localhost:3400 port restriction pattern | `e2e/persona-drive.mjs` `parseArgs` (hard-throws off-localhost or wrong port) | The allowlist pattern to copy for the virtual-shops' own dedicated port |
| Headless Playwright driver skeleton (screenshot on each flow step, JSON metrics out) | `e2e/persona-drive.mjs`, `e2e/stress-drive.mjs` | Base shape for each shop's daily-loop driver |
| Stress intensities (`light/standard/heavy`, `refreshMidSession`, `offlineReconnect`, batching, rate caps) | `e2e/stress-drive.mjs` `INTENSITIES` | Base shape for Night Shift's resilience loop |
| Messy spreadsheet generator (renamed/shuffled columns, TSV/semicolon, XLSX, junk columns, typo brands) | `e2e/teach/sheets.mjs` | Legacy Tires' ugly-spreadsheet generator, reused as-is |
| Persona-shaped daily loop / codes-per-persona shape | `e2e/teach/personas.mjs` (`PERSONAS`, `codes: {known, unknown, vendor}`) | The shape (not the live-signup flow) for each shop's known/unknown/vendor code mix |
| Reconcile equal/variance/fuzzy scenarios | `e2e/teach/lessons/10-reconcile-equal-diff.mjs`, `13-reconcile-matrix.mjs`, `e2e/teach/reconcileScenarios.mjs` | Legacy Tires' reconciliation ground truth and scoring logic |
| Tire corpus (78,243 tires, `src/server/knowledge.generated.db`) + seed script pattern | `scripts/seed-tires-from-corpus.ts` | Rincon Tire's ~800-row realistic inventory pull (offline SQL read, no network) |
| Human-bot personas / roles / known codes fixture | `e2e/human-bots/fixtures/known-codes.ts`, `e2e/human-bots/scenarios/*.spec.ts` | Reference for role-safe, deterministic known-code selection; QuickFix Auto borrows its "everyday mixed shop" shape |
| Fable 5 Python orchestration of manual drivers | `tools/fable5/personas.py`, `tools/fable5/stress.py` (localhost:3400 guard, log/report dirs, `python -m tools.fable5 ...`) | The wrapper pattern for a new `tools/fable5/virtual_shops.py` |
| Argus review engine (deterministic, zero model tokens) | `tools/fable5/` (`review-plan`, `review-build`) | Gate the harness code itself once built |

Deliberately NOT reused: `e2e/teach/personas.mjs` `signUpPersona`/`loginPersona` (these create real
Firebase accounts against the LIVE deployed app — wrong backend for this harness) and
`playwright.teach.config.ts` (no `webServer`, drives the live URL by design). Virtual shops must run
against the MOCK backend the same way `playwright.config.ts` / `e2e/persona-drive.mjs` do.

## Launch model (commands and configs to add later — none built this round)

- **Backend:** mock only, always. Same contract as `npm run test:e2e` / `e2e/persona-drive.mjs`: `IS_E2E=1`
  (or the harness's own equivalent flag) forces `/api/ai-lookup` to the local stub, never a real key.
- **Port:** the ports table (`CLAUDE.md`) is dev 3000, mock e2e 3100, firebase e2e 3200, qa bots 3300,
  fable5 manual drivers 3400. Virtual shops get the next slot, **port 3500**, reserved in
  `docs/COMMANDS.md` and enforced the same way `e2e/persona-drive.mjs` enforces 3400 (hard-throw if the
  target host/port is anything else).
- **Dev server lifecycle:** the harness controller (a future `e2e/virtual-shops/run.mjs`, mirroring the
  rescued shop-owner plan's controller pattern in `docs/superpowers/specs/2026-07-28-scanbin-shop-owner-plan.md`
  Task 1) spawns `npm.cmd run dev -- --port 3500` with pinned mock env vars, waits for readiness, runs the
  requested shop(s), then terminates only that child process. It never touches a shared/already-running
  dev server.
- **Commands to add (future work, not built now):**
  - `npm run virtual-shops -- --shop rincon-tire` (also `quickfix-auto`, `legacy-tires`, `night-shift`, or
    `--all`)
  - `npm run virtual-shops:test` — unit tests for the shop drivers and data generators (`node --test`)
  - `python -m tools.fable5 virtual-shops <shop>` — Fable 5 wrapper, same shape as
    `python -m tools.fable5 review-build`, for zero-token scheduled/CI-safe runs
- **Explicitly forbidden, always:** no `TEACH_ALLOW_LIVE_DECODE`, no real API keys in the child
  environment, no `playwright.teach.config.ts`, no production/preview URL. Any observed live
  `/api/ai-lookup` POST reaching a real provider during a virtual-shops run is a blocking safety
  incident, same bar as the Teach Bot and shop-owner skill.
- **Reports:** every run writes to `reports/virtual-shops/<shop>/<runId>/` — a `report.md` summary, a
  `report.json` with metrics, a `friction.jsonl` append-only log (one line per friction event:
  `{timestamp, shopKey, dayIndex, phase, severity, description, screenshotPath}`), and screenshots.
  Gitignored, same as `testing/artifacts/` and `reports/fable5/manual/`.

## The four shops

### (a) Rincon Tire — disciplined tire shop, realistic scale

**Goal:** prove the app holds up at realistic tire-shop scale (~800 SKUs) with a careful, low-error
owner — the baseline "this works great when used correctly" case.

**Daily loop:** morning stock count of yesterday's deliveries (30-60 scans of known tire barcodes drawn
from the corpus), a few genuinely unknown codes routed to Needs Review and resolved once, an end-of-day
variance export. Repeats with a slowly growing inventory across simulated days.

**Data sources:** ~800 real tire rows pulled once (offline SQL read) from `src/server/knowledge.generated.db`
via the `scripts/seed-tires-from-corpus.ts` pattern, saved as a static fixture so the shop's inventory is
stable and reviewable, not regenerated per run. Deliberately includes same-model-different-size groups to
exercise `services/catalog/identityMerge.ts` size-aware merge.

**Success metrics:** activation time (time from empty session to first successful counted scan) under a
target threshold; sustained scans/minute close to real wedge-scanner speed; zero lost or duplicated
counts across the full session (Scan N = count N, verified against the seeded ledger); size-merge
correctness (same model + different size never collapses into one product); a variance report produced
and numerically correct at end of day.

**Friction log:** `reports/virtual-shops/rincon-tire/`.

### (b) QuickFix Auto — small repair shop, sloppy scanner habits

**Goal:** prove the app survives a realistic bad-day operator, not just a careful one — the resilience
case for ordinary human error at normal small-shop scale.

**Daily loop:** ~150 mixed non-tire items (oil filters, batteries, wiper blades, shop supplies) scanned
with injected typos (a few extra/dropped digits before Enter), deliberate double-scans of the same code
back-to-back, and mid-scan interruptions (navigate away or reload mid-buffer, then resume). Repeats daily
with a different error pattern seed.

**Data sources:** a ~150-item mixed-catalog fixture (retail-shaped, not tire-shaped) drawn from
`src/server/retail-knowledge/` or a curated static fixture if the retail corpus does not cover the SKUs
needed; an error-injection table (typo positions, double-scan pairs, interrupt points) checked into the
fixture so runs are reproducible.

**Success metrics:** every injected scan still appears in the feed and counts per the TOP-LEVEL LAW
(scan 10 = count 10, even malformed ones); double-scans increment quantity on the same product, never
create a duplicate row; typo'd codes that do not resolve route to Needs Review with an honest reason,
never silently vanish; mid-scan interruption recovery (buffer is not corrupted into the next session).

**Friction log:** `reports/virtual-shops/quickfix-auto/`.

### (c) Legacy Tires — chaos import + reconcile, the "we found you $X" demo

**Goal:** prove the universal import + reconciliation flow turns a genuinely ugly legacy spreadsheet
into an honest, defensible variance report — this shop doubles as the sales-demo generator.

**Daily loop:** import one ugly legacy-style spreadsheet (misaligned columns, missing part numbers,
renamed/shuffled headers, blank rows, duplicated rows, typo'd brand names — generated via
`e2e/teach/sheets.mjs`'s escalating-messy patterns), then reconcile the imported "book count" against a
seeded ground-truth physical count that intentionally differs by a known dollar amount, producing the
"we found you $X" variance narrative.

**Data sources:** `e2e/teach/sheets.mjs` messy-format generators reused directly; a ground-truth
physical-count fixture with a deliberately seeded discrepancy (known SKUs over/under by a known amount
and known dollar value) so the reconciliation output is checkable against an exact expected number, not
just "did it run."

**Success metrics:** the import never silently drops a row it cannot fully parse (missing part number
routes to a reviewable state, not data loss); the reconciliation report's dollar variance matches the
seeded discrepancy exactly; ambiguous/fuzzy matches stay review-only and are never auto-applied as fact;
the demo narrative ("we found you $X") is reproducible from the same seed.

**Friction log:** `reports/virtual-shops/legacy-tires/`.

### (d) Night Shift — offline and retry resilience

**Goal:** prove nothing is ever lost when the network and the browser session misbehave — the "can this
be trusted to run unattended overnight" case.

**Daily loop:** a scan burst while offline (network stubbed off mid-session, mirroring
`e2e/stress-drive.mjs`'s `offlineReconnect` flag), a page refresh mid-session, then a reconnect that
triggers a retry storm on the pending-sync queue (same scan events retried repeatedly), verifying nothing
double-counts and nothing is lost.

**Data sources:** reuses `e2e/stress-drive.mjs`'s known-codes fixture and intensity/batching shape
(`tools/fable5/fixtures/stress-codes.json`) rather than inventing a new one; no tire-specific data needed
since this shop is about the sync/reliability layer, not catalog realism.

**Success metrics:** zero lost counts across offline -> refresh -> retry-storm -> reconnect; idempotency
holds (retried `idempotencyKey`s never create a second `InventoryCount.scanEventIds` entry); the pending
queue fully drains on reconnect; the UI honestly shows "Saved locally, not synced yet" while offline
rather than a false success state.

**Friction log:** `reports/virtual-shops/night-shift/`.

## Common friction-log schema (all four shops)

Each `friction.jsonl` line:

```json
{"timestamp": "2026-07-29T05:00:00Z", "shopKey": "rincon-tire", "dayIndex": 12, "phase": "morning-stock-count", "severity": "minor|moderate|blocking", "description": "...", "screenshotPath": "reports/virtual-shops/rincon-tire/run-.../screenshots/day12-step7.png"}
```

`report.md` per run summarizes: shop, day index, scans attempted vs counted, metric pass/fail against
this shop's success metrics above, and a short list of any friction events at moderate/blocking severity.

## Build task list (next wave)

1. **(S)** Reserve port 3500 in `docs/COMMANDS.md`'s ports table; document the four `npm run virtual-shops`
   command variants (not yet implemented) next to the existing teach/qa-bots entries.
2. **(S)** Scaffold `e2e/virtual-shops/` with a shared lib: the `NO_AI_STATUS` mock-route stub (copied
   from `e2e/persona-drive.mjs`), the localhost:3500 allowlist guard, and a `frictionLogger.mjs` writing
   the schema above.
3. **(M)** Build the Rincon Tire fixture generator: an offline script pulling ~800 rows from
   `src/server/knowledge.generated.db` (pattern: `scripts/seed-tires-from-corpus.ts`) into a static,
   checked-in JSON fixture, including deliberate same-model/different-size groups.
4. **(M)** Build the Rincon Tire daily-loop driver + metric scorer (activation time, scans/min, zero
   lost/duplicated counts, size-merge correctness, variance-report correctness).
5. **(M)** Build the QuickFix Auto fixture (~150 mixed retail items) + the typo/double-scan/interrupt
   error-injection table and driver.
6. **(M)** Build the Legacy Tires ground-truth physical-count fixture with a seeded known-dollar
   discrepancy, wire it to `e2e/teach/sheets.mjs`'s messy-format generators, and build the reconcile
   scorer that asserts the exact expected variance dollar amount.
7. **(M)** Build the Night Shift resilience driver, reusing `e2e/stress-drive.mjs`'s offline/refresh/retry
   flags and `tools/fable5/fixtures/stress-codes.json`, plus the idempotency/queue-drain assertions.
8. **(S)** Wire all four drivers' output through the shared `frictionLogger.mjs` into
   `reports/virtual-shops/<shop>/` and gitignore that path.
9. **(S)** Add `tools/fable5/virtual_shops.py`, mirroring `tools/fable5/personas.py` / `stress.py`
   (port/host guard, log dir, CLI entry `python -m tools.fable5 virtual-shops <shop>`).
10. **(M)** Add a combined "run all 4 shops" command and an aggregate scoreboard report (pass/fail per
    shop's success metrics, trend across days).
11. **(S)** Document the finished commands in `docs/COMMANDS.md`, cross-link this spec from `AGENTS.md`'s
    testing-conventions section, and add a CI-safe guard test asserting the harness never resolves a
    non-localhost/non-3500 target or a real provider key (same shape as `e2e/persona-drive.mjs`'s existing
    `parseArgs` throw).

All eleven tasks are additive, mock-only, and touch no product runtime code — same boundary the Teach
Bot harness and Fable 5 manual drivers already respect.
