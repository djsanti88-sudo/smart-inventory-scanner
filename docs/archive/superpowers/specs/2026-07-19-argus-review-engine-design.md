# Argus Review Engine - Design (2026-07-19)

> Owner-approved design from the 2026-07-19 brainstorming interview. Status: APPROVED, plan next.
> Argus is a local-first, self-improving review engine: Python + PowerShell do the heavy reviewing
> for free on the owner's machine; headless Claude CLI (subscription) is used only for judgment;
> the output is a verdict-gated handoff report that Claude sessions ingest automatically.

## FOUNDATION DECISION (2026-07-19, after verification)

A ChatGPT-built tool `tools/fable5/` (stdlib Python, 12 tests, gate scheduler with light/heavy/
browser lanes, SQLite evidence cache, subprocess safety + allowlist, read-only headless expert
dispatch, plan text-scoring, multi-format reports) was VERIFIED real, working, and safe by a code
review + local test run on 2026-07-19. Owner decision: build Argus ON this foundation TODAY
(Fable 5 orchestrates the build today only; the finished tool must never depend on the Fable model
at runtime - expert default model is sonnet). Hardening already applied and proven green:
validate-agents dash-regex mojibake reverted (CRLF fix kept), semantic-firewall line added to
expert prompts, semgrep exec rule extended to unprefixed child_process imports, expert model
default fable -> sonnet. Capability gap vs this spec (verified): fable5 covers the gate-runner
core; missing = proof-artifact plan audit, docs staleness, risk classifier, per-angle JSON
contracts + adversarial verify, canaries, invariants, learning loop, mutation probes, measured
personas, preview-stress, hook wiring/handoff, weekly sweep. The static-analyzer install list
shrinks: semgrep/gitleaks/osv-scanner/ruff are already installed; ast-grep is DROPPED (semgrep
custom rules fill that role); jscpd/knip/madge remain optional adds.

## Goal

Review everything - executed plans, their diffs, docs, and periodically the whole repo - as
comprehensively as a Fable 5 multi-agent review, while burning as few Claude tokens as possible.
The reviewer must be trustworthy enough to act on without re-checking, and must get smarter and
cheaper every run.

## Owner decisions (interview, 2026-07-19)

| Question | Decision |
|---|---|
| Scope | Plan-vs-reality + executed diff + docs staleness + whole-repo sweep |
| AI engine | Headless Claude CLI (`claude -p`), subscription, explicit models per call |
| Trigger | Claude Code hook fires it automatically when a plan MD phase is marked complete |
| Token intent | Both: reviewer itself token-lean AND plans vetted BEFORE execution |
| Angles | Core four + simplicity/scope + docs/memory sync + UX lens + business personas |
| Personas | 3 on the live app (tire-shop owner, multi-trade retail owner, floor clerk), each answering "Would I pay $150/mo? What's missing? What doesn't fit my workflow/software?" |
| Output | Ranked MD report + PASS/BLOCK verdict + nonzero exit on BLOCK |
| Depth | Local-first: Python/PowerShell do maximum free work; compact packets to AI; handoff back to Claude |
| Free tools | Approved to install (exact list below, shown in plan for final OK) |
| Handoff | Report file + SessionStart hook pointer + PROGRESS.md verdict line |
| Sweep cadence | Weekly, chained into the weekly-report rhythm |
| 10x upgrades | ALL seven approved (verify pass, canaries, invariants, learning loop, mutation probes, risk budget, measured personas) |

## Architecture: three layers

### Layer 1 - FREE local evidence (Python + PowerShell + free tools)

All deterministic, all offline, zero tokens:

- **Gate runner**: runs the mode-appropriate existing npm gates (tsc, lint, vitest unit,
  `test:ledger` when counting files touched, build, e2e, qa:bots for handoff mode), captures
  pass/fail + failure excerpts. Never invents commands: reads them from package.json.
- **Static analyzers** (new, free, local; install list needs owner OK in the plan):
  - `gitleaks` - secret scanning (Go binary, winget)
  - `ast-grep` - structural pattern scanning, native Windows (winget/npm)
  - `jscpd` - copy-paste detection (npm dev dep)
  - `knip` - dead code/exports (npm dev dep)
  - `madge` - dependency cycles (npm dev dep)
- **Plan auditor**: parses the target plan MD - acceptance criteria, proof method per criterion,
  phase checkboxes - and deterministically verifies proof artifacts exist (files, commands,
  screenshots). Criterion without proof = BLOCK candidate.
- **Docs staleness checker**: files/commands referenced in CLAUDE.md / ARCHITECTURE.md /
  COMMANDS.md exist; PROGRESS.md freshness vs plan mtime; broken relative MD links.
- **Diff classifier**: git diff vs merge-base; maps changed files to risk tags
  (ledger > tenancy > decode > server > UI > docs). Decides mandatory gates and which AI angles fire.
- **Persona driver**: local Playwright (mock backend) walks scan-known / scan-unknown / review /
  export flows; records screenshots, task time, step count, failure points.
- **Mutation probes**: for changed source files, apply small mutations (flip condition, swap
  operator) in a temp worktree and check the relevant tests FAIL. Tests that cannot fail are
  reported as weak proof.
- **Invariant contracts**: `invariants.yaml` encodes the product laws (TOP-LEVEL LAW, ledger rules,
  resolver trust rules, key safety, pay-once cap rule). Each maps to a deterministic checker
  (ast-grep pattern or test command) where possible; AI check only where judgment is needed.

Output of Layer 1: `evidence.json` - a compact, structured evidence packet.

### Layer 2 - LEAN AI judgment (headless `claude -p`, subscription)

Each angle = ONE call, compact packet (evidence summary + only relevant diff hunks/screenshots,
size-capped), explicit model, strict JSON output contract:

| Angle | Model | Fires when |
|---|---|---|
| Correctness/bugs | sonnet | code changed |
| Security + tenant leaks | sonnet | code changed |
| Data integrity vs TOP-LEVEL LAW | sonnet | always on ledger/scan-path changes |
| Plan-vs-reality judgment | sonnet | phase/handoff modes |
| Simplicity/scope creep | haiku | always |
| Docs-sync confirmation | haiku | docs flagged stale |
| UX lens | sonnet | diff touches UI files |
| 3 personas | sonnet | handoff/sweep modes |
| Adversarial verify (per finding) | haiku/sonnet | every AI finding |
| Synthesis + verdict | opus | always (one call) |

- **Adversarial verify pass**: every AI finding gets one skeptic call whose only job is to refute
  it against the real code. Only confirmed findings reach the report.
- **Risk-weighted budget**: token budget, angle count, and model tier scale with the diff risk
  score. Docs-only phase = zero AI calls; ledger-touching phase = full depth.
- **Cache**: `.review-cache.json` keyed by file-hash x angle. Unchanged content is never re-sent.
- Live paid provider APIs are NEVER called. `claude -p` on subscription is the only AI spend.

### Layer 3 - Handoff back to Claude

- `docs/reviews/YYYY-MM-DD-<plan>-review.md`: verdict (PASS/BLOCK), what-was-checked ledger
  (every gate/angle run, skipped, or cached - no silent gaps), ranked confirmed findings
  (severity, file:line, evidence link, suggested fix), measured persona scores + $150/mo verdict,
  trend deltas vs previous run, and a ready-to-paste fix packet for the orchestrator.
- `docs/reviews/LATEST.json`: machine-readable verdict for hooks.
- SessionStart hook injects a 3-line pointer (verdict, top blockers, report path) into every new
  Claude session. PROGRESS.md gets the verdict line appended.
- Exit codes: 0 = PASS, 2 = BLOCK, 1 = engine error. Every claim in the report links to its
  artifact (log, screenshot, gate output) - anti-fake-proof by construction.

## Modes

| Mode | Trigger | Contents |
|---|---|---|
| `plan-vet` | manual `/review` or orchestrator, BEFORE execution | Deterministic plan checks (named files/commands exist, cost table present) + 3 attacker angles (feasibility, risk, simplicity). Can replace most in-session attack panels. |
| `phase` | Stop hook detects plan MD phase checkbox flipped to done | Diff review + plan-vs-reality on the completed phase; unit-level gates |
| `handoff` | manual, before handoff/push | Everything: full gates + all angles + personas + mutation probes |
| `sweep` | weekly, chained into weekly-report | Whole-repo deterministic pass; AI only on files changed since last sweep |
| `preview-stress` | orchestrator/owner passes a preview URL (`--target <url>`), e.g. right after Claude launches a new Vercel preview | Stress + chaos battery against the LIVE preview link (owner requirement 2026-07-19, see below) |

## Preview stress testing (owner requirement, 2026-07-19)

When Claude creates a new preview deployment, Argus can be pointed at that live link and batter it:

- **Chaos battery** (Playwright, free): rapid scan bursts (keyboard-wedge speed), refresh
  mid-session, offline -> reconnect -> retry sync, duplicate/rapid repeat scans, long-session
  volume (hundreds of scans), concurrent tabs. After the battery: assert the crown invariant on
  the UI totals - scans issued == rows counted (TOP-LEVEL LAW), no double-counts after retries.
- **Performance measurement** (free, local): latency percentiles per flow (scan -> row visible),
  page-load metrics on cheap-device throttling, error rates, console errors captured.
- **PAID-SAFETY RAILS (hard requirement)**: a stress run must NEVER burn paid decode rungs.
  Stress scans use corpus-known codes only by default; unknown-code scans are capped to a tiny
  explicit number (default 0, flag-gated); the runner respects the daily cap and stops on any 429;
  request rate is throttled. A preview pointing at real cloud backends is refused unless the owner
  passes an explicit `--allow-cloud` flag (doctrine gate: live/paid actions stay owner-gated).
- Results feed the same report: stress section with metrics, failures, and verdict impact.
- One persona pass MAY reuse the preview screenshots (same $150/mo question against the real
  deployed app instead of localhost) at no extra collector cost.
- **Never-forget reminder (owner decision 2026-07-19)**: the target URL is passed explicitly
  (`--target <url>`), but a hook detects new preview URLs appearing in session output and injects
  a reminder so the orchestrator ALWAYS offers the owner the stress run. A config toggle
  (`autoRunPreviewStress: ask | auto`) lets the owner later flip from "ask me each time" to
  "just run it". Default: ask. Stress intensity default: standard (~300 scans, 3 tabs, ~10 min),
  flag-adjustable.

## Self-improvement (the compounding loop)

- **Findings ledger** (SQLite `review/argus.db`): every finding -> confirmed / false positive /
  recurrence, with fingerprint.
- **Rule promotion**: recurring confirmed defect classes get promoted into deterministic ast-grep
  rules (pay tokens for a bug class once, catch it free forever). Promotions are proposed in the
  report, owner-visible, applied to `review/rules/` on acceptance.
- **False-positive suppression**: verified-refuted patterns are auto-suppressed in future runs.
- **Canary self-test**: fixture corpus of real past defects (double-charge cap bug, quantityDelta:0
  ledger gap, markWrong-deletes-quantity, salmon-as-beer wrong-verify, cap-in-browser leak) as
  seeded diffs. `argus selftest` must flag every canary or Argus's own build fails. Runs in the
  reviewer's test suite.
- LESSONS_LEARNED.md gets appended when a new defect class is confirmed.

## Component layout

```
scripts/review/               # Python package, stdlib only (no pip deps)
  __main__.py                 # entry: python -m review <plan.md|--sweep|--selftest> --mode ...
  config.py                   # paths, budgets, model tiers, size caps
  evidence/
    gates.py                  # npm gate runner (subprocess, timeout, excerpt capture)
    static_tools.py           # gitleaks/ast-grep/jscpd/knip/madge wrappers + normalizers
    plan_audit.py             # plan MD parser + proof artifact verification
    docs_check.py             # staleness + link checks
    diff_scan.py              # git diff, risk classifier
    personas.py               # Playwright driver wrapper (calls existing e2e infra)
    mutation.py               # targeted mutation probes in a temp worktree
    invariants.py             # invariants.yaml loader + deterministic checkers
  brain.py                    # headless claude -p calls, JSON contract, verify pass, budget
  cache.py                    # file-hash x angle cache
  ledger.py                   # SQLite findings ledger + rule promotion + suppression
  report.py                   # MD report + LATEST.json + PROGRESS.md line + fix packet
  selftest/                   # canary corpus + runner
  rules/                      # promoted ast-grep rules
  invariants.yaml
tests (python): scripts/review/tests/  # stdlib unittest; canaries are part of it
hooks: .claude/settings.local.json     # SessionStart pointer + Stop-hook trigger (PowerShell)
command: .claude/commands/review.md    # /review slash command
```

## Error handling

- Any collector failure degrades gracefully: the angle is marked SKIPPED with the reason in the
  what-was-checked ledger; it never silently disappears and never crashes the run.
- `claude -p` timeouts/malformed JSON: one retry with repair prompt, then the angle is SKIPPED
  (reported). Engine errors exit 1, never fake a PASS.
- Long gates run with hard timeouts; hook-triggered runs are detached (PowerShell Start-Process)
  so they never block a Claude session.
- OneDrive/watcher hazards: all temp work in the scratchpad/temp worktrees, never in synced dirs.

## Testing the reviewer itself

- stdlib unittest for plan_audit, diff_scan, cache, ledger, report (fixture plans + fixture diffs).
- Canary self-test suite (above) is the acceptance gate for every Argus change.
- A dry-run mode `--no-ai` runs Layer 1 only, for fast local iteration and CI.

## Out of scope (v1)

HTML dashboards, auto-applied patches, additional personas/angles, Task Scheduler nightly runs,
push notifications on BLOCK, replacing qa:bots (Argus calls existing infra, does not rebuild it).

## Open items for the plan

- Exact install commands + versions for the free tool set (owner OK gate).
- Stop-hook detection details (checkbox diff heuristics) and debounce.
- Token/size caps per packet; per-mode wall-clock targets (phase < 10 min).
