# Fable 5

Fable 5 is the repository's Python stdlib-only review engine. It audits implementation plans,
runs deterministic evidence gates, probes changed TypeScript tests, optionally dispatches a
risk-selected Claude expert layer, and writes a verdict with evidence for the next session.
Python 3.11 or newer is required.

From the repository root, use either the Windows wrapper or the portable module form:

```powershell
.\fable5.cmd doctor
python -m tools.fable5 doctor
```

## Commands

### Inspect local capabilities

```powershell
.\fable5.cmd doctor
.\fable5.cmd doctor --json
```

`doctor` inventories local executables, project commands, repository agents, Codex skills, and
installed plugins. It does not run checks or use the network.

### Audit a plan and its proof methods

```powershell
.\fable5.cmd review-plan docs/superpowers/plans/2026-07-19-master-plan.md
```

`review-plan` checks plan structure and audits acceptance criteria in the Goals or Success Criteria
section. Backticked npm scripts must exist in `package.json`, referenced repository paths must
exist, and named screenshot or report artifacts must resolve. A criterion with no recognizable
proof method is blocking. Use `--output-dir <path>` to write JSON and Markdown audit evidence.

### Review a build

```powershell
.\fable5.cmd review-build --gate fast
.\fable5.cmd review-build --gate pr --no-cache
.\fable5.cmd review-build --gate release
.\fable5.cmd review-build --gate monthly
```

The gates increase in depth:

- `fast` runs the local deterministic quality and security evidence.
- `pr` adds PR evidence and automatically runs changed-file mutation probes.
- `release` adds build, browser, and relevant emulator evidence.
- `monthly` adds the broad sweep, mutation probes, and measured personas.

Useful controls include `--plan <path.md>`, `--only <check-id> ...`, `--dry-run`, and
`--no-cache`. Safety-labeled checks stay blocked unless their matching `--allow-network`,
`--allow-live`, `--allow-paid`, or `--allow-mutating` flag is supplied. These approvals are
independent and do not authorize deploys or pushes.

### Run the canary selftest

```powershell
.\fable5.cmd selftest
```

`selftest` copies isolated fixtures into scratch directories and proves the five seeded detectors
catch their defects. It is free, offline, and does not create Git worktrees.

### Stress a local or approved preview

```powershell
.\fable5.cmd stress --target http://localhost:3400 --intensity standard
.\fable5.cmd stress --target https://approved-preview.example --allow-cloud
```

`stress` is never automatic. Local targets must use port 3400. Every non-localhost target requires
`--allow-cloud` for that run. The command defaults to zero unknown scans, caps explicit unknowns at
five, revalidates the known-code fixture, stops on the first `/api/ai-lookup` request or HTTP 429,
and verifies counts from persisted state. Preview runs remain owner-gated.

## Optional review layers

### Claude experts and billing preflight

```powershell
.\fable5.cmd review-build --gate pr --with-experts
```

`--with-experts` uses risk tags to select the smallest useful specialist fleet. Scores up to 3
remain deterministic-only, scores 4 through 7 use medium effort, and scores 8 or higher use high
effort. `--all-agents --with-experts` deliberately selects every local specialist.

Before any expert call, Fable 5 runs `claude auth status`. The expert layer proceeds only when
authentication reports `claude.ai` and no API key source. Every call carries a USD 0.50 budget cap.
Any reported nonzero cost fails closed unless the owner explicitly supplies
`--allow-paid-fallback`. Expert output always reports token and cost evidence. Computed cost is a
floor; true spend = provider console.

### Measured personas

```powershell
.\fable5.cmd review-build --gate fast --personas
```

`--personas`, also enabled by the monthly gate, measures three browser flows on localhost port
3400 and asks the existing value and UX agents for a $150 per month purchase verdict. Browser work
uses the single browser lane. The agent judgments consume Claude subscription tokens and use the
same subscription preflight and fail-closed billing rules.

### Mutation probes

```powershell
.\fable5.cmd review-build --gate fast --mutation
```

Mutation probes run automatically in `pr` and `monthly`, or on any gate with `--mutation`. A
session creates one temporary Git worktree, adds a Windows directory junction to the main
repository's `node_modules`, and reuses that worktree for every mutant. It never runs npm install
or a native rebuild. Only changed TypeScript modules with an exact sibling `.test.ts` file are
eligible. Any sibling test containing `better-sqlite3`, `libsql`, or `@libsql` skips the source
file before the worktree is created. Each session is capped at 10 mutants and each mutant has a
120 second Vitest timeout. Surviving mutants are non-blocking warnings that identify weak tests.

## Reports, verdicts, and exit codes

Each build review writes `reports/fable5/<run-id>/`:

- `report.md` is the complete checked ledger and the report target stored in the latest pointer.
- `report.html` is a visual rendering of the same run.
- `run.json` is stable machine-readable evidence.
- `expert-packet.md` is the minimal specialist context packet.
- `logs/*.log` contains per-check evidence.
- `fix-packet.md` appears when failed or warning results need action. Its finding text is fenced,
  labeled untrusted, and secret-redacted.

After the report is written, Fable 5 atomically updates `docs/reviews/LATEST.json`. The pointer
contains the verdict, run ID, `report.md` path, up to three blockers, generated time, and cost note.
A stale run cannot overwrite a newer pointer.

Exit codes are stable:

- `0`: PASS, or a ready plan.
- `1`: engine error or plan that needs work. Never treat this as a clean pass.
- `2`: BLOCK because a plan proof is missing or a blocking check failed.
- `3`: REFUSED because the run lock is held or a structural safety guard rejected the request.

## Hooks and run lock

The SessionStart hook reads `docs/reviews/LATEST.json`, `.fable5/running.json`, and any pending
preview offer, then prints no more than four status lines. The Stop hook detects a newly completed
plan checkbox, applies a 30 minute per-plan debounce and a four-runs-per-day cap, then starts a
hidden fast review with `FABLE5_HOOK_TRIGGERED=1`.

Hook-triggered runs are structurally deterministic-only. They refuse experts, personas, mutation
probes, stress, and all network, live, paid, or mutating flags with exit 3. They run only the light
resource lane and have a 15 minute wall-clock limit. Every build review also holds the single-run
lock in `.fable5/`; a concurrent review exits 3 rather than racing evidence or caches.

## Cache and configuration

Successful checks are cached in `.fable5/cache.sqlite3`. The key includes the command, Git commit,
Fable configuration, and dirty or untracked file content. `--no-cache` forces fresh evidence;
failed results are never cached.

Edit `fable5.toml` to configure checks, command allowlists, resource lanes, safety labels, risk
rules, and specialist routes. Subprocesses do not use a shell, receive a secret-scrubbed
environment, and are killed on timeout. Use `--dry-run` to inspect scheduling before adding a new
check.
