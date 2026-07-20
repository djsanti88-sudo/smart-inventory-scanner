# Fable 5

Fable 5 is the repository's local-first review arsenal. It attacks plans before implementation,
runs deterministic code and security evidence concurrently, routes the resulting packet to only
the relevant specialists, and produces reports that can be inspected without spending AI tokens.

It uses only the Python standard library. Python 3.11 or newer is required.

## Start here

From the repository root:

```powershell
.\fable5.cmd doctor
.\fable5.cmd review-plan docs/superpowers/plans/2026-07-19-master-plan.md
.\fable5.cmd review-build --gate fast
```

To run the selected expert fleet concurrently with Claude Fable 5 after deterministic evidence:

```powershell
.\fable5.cmd review-build --gate fast --with-experts
```

To deliberately run every repository specialist, use `--all-agents --with-experts`. This can use
substantially more subscription tokens, so changed-file routing is the default.

The equivalent portable command is `python -m tools.fable5 ...`.

Reports are written to `reports/fable5/<run-id>/`:

- `report.html`: owner-friendly result.
- `report.md`: complete check summary.
- `run.json`: stable machine-readable evidence.
- `expert-packet.md`: minimal context for the selected AI specialists.
- `logs/*.log`: unedited tool evidence.

## Gates

- `fast`: Python self-test, agent validation, release sentinel, secrets, local Semgrep, Ruff,
  TypeScript, and unit tests.
- `pr`: fast-quality evidence plus lint and the optional networked dependency audit.
- `release`: production build, browser E2E, and relevant Firebase emulator proof.
- `monthly`: release evidence, human-like QA bots, and routing to the entire specialist fleet.

Fable uses separate concurrency pools. Lightweight checks run together, only one build-heavy check
runs at a time, and browser work has its own lane. This prevents a superficially parallel run from
making timing-sensitive tests less reliable.

## Safety

The default is offline, free, local, and report-only. Every command executable must appear in the
allowlist in `fable5.toml`. Subprocesses do not use a shell, receive a secret-scrubbed environment,
and are killed on timeout.

Checks marked networked, live, paid, or mutating are blocked unless their explicit flag is supplied:

```powershell
fable5 review-build --gate pr --allow-network
```

The flags are deliberately separate. Network approval never implies live-system, paid, deployment,
or state-changing approval. No deploy or push commands are present in the default arsenal.

## Specialist and plugin behavior

`doctor` inventories available local tools, repository agents, Codex skills, and installed plugins.
Changed-file rules in `fable5.toml` choose the smallest relevant expert fleet. A monthly run selects
all repository specialists.

Fable does not blindly invoke every plugin. Connectors such as email, Slack, Notion, or Figma need a
real destination and access approval. The generated expert packet is the safe boundary between free
deterministic evidence and token-using judgment. `--with-experts` is the explicit subscription and
network gate. It removes ambient Anthropic API keys so a subscription review cannot silently become
metered API spend, launches only read-only specialist sessions, and defaults to the Fable 5 model.

## Cache

Successful checks are cached in `.fable5/cache.sqlite3`. The key includes the command, current Git
commit, Fable configuration, and content of dirty or untracked files. Use `--no-cache` for fresh
proof. Failed results are never cached.

## Configuration

Edit `fable5.toml` to add checks and specialist routes. Each check declares:

- gates and command argument array;
- light, heavy, or browser resource class;
- timeout, blocking behavior, and dependencies;
- changed-file patterns;
- network, live, paid, and mutating safety labels.

Use `--dry-run` to verify scheduling and safety before adding a new command.
