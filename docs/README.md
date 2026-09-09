# Docs Index

The single index for this repo's Markdown. If you're looking for "where does this
belong," start here before adding a new file.

## Living docs (canonical — current, kept up to date)

### Root
| File | Purpose |
|---|---|
| `CLAUDE.md` | Master project rules, TOP-LEVEL LAW, tech stack, commands, conventions |
| `AGENTS.md` | Agent-facing quickstart: toolchain, verified commands, layout, pitfalls |
| `GUARDRAILS.md` | Tiny auto-load list of standing invariants (counting, safety, decode, planning) |
| `REPO_HEALTH.md` | Git/GitHub sync truth: branch inventory, unpushed work, tech-debt ledger |
| `PROGRESS.md` | Current phase, completed work, next tasks, blockers |
| `DECISIONS.md` | Important technical decisions and why they were made |
| `TESTING.md` | Test commands, acceptance checklist, known test limitations |
| `LESSONS_LEARNED.md` | Permanent hard-won lessons (numbered, e.g. L11 provider billing) |
| `docs/PLAN_EXECUTION.md` (appendix) | Plan template |
| `docs/FIREBASE.md` | Firebase environments, tenancy, credentials, and local proof |
| `MANUAL_LIVE_TEST.md` | Owner-gated manual live-decode checklist |
| `README.md` | Repo onboarding; points here for the full docs map |

### `docs/`
| File | Purpose |
|---|---|
| `ARCHITECTURE.md` | Full verified architecture map + the known traps |
| `COMMANDS.md` | Every script, port, env var name, PAID/LIVE warnings |
| `DEPLOY_TRUTH.md` | Deploy targets, PR/production flow, release checks, and observability |
| `DECODER_ARCHITECTURE.md` | Canonical decode-pipeline doc (`runDecodePipeline`) |
| `FIREBASE.md` | Firebase setup, tenancy/security model, credentials, and proof |
| `PLAN_EXECUTION.md` | How plans are created, attacked, executed, and proven done |
| `QA_BOTS.md` | Playwright and human-bot proof, handoff contract, scheduled QA |
| `RECOVERY.md` | Backup/restore and disaster-recovery notes |
| `BACKLOG.md` | Open work not already owned by the active phase |
| `WEEKLY_REPORT.md` | Weekly report commands, scheduling, evidence, and presentation quality |
| `HISTORY.md` | Short timeline of retired plans, reports, and major documentation changes |

## Reference (stable lookup material, not status)

| File | Purpose |
|---|---|
| `docs/GS1_COUNTRY_REFERENCE.md` | GS1 barcode country-prefix reference data |
| `docs/FULL_SYSTEM_AUDIT_PROMPT.md` | Standing prompt used for full-system audits |

## Specialized material

| Location | Purpose |
|---|---|
| `docs/legal/` | Separate draft legal instruments; not production legal advice |
| `docs/analysis/` | Reproducibility receipts and bounded analysis artifacts |
| `docs/plans/ACTIVE.md` | Explicit active-plan pointer or explicit no-active-plan state |

## Historical (superseded, complete, or point-in-time)

`docs/HISTORY.md` summarizes the retired plans, specs, reports, and evidence. Full historical text
remains available in Git and must not be treated as current instructions or authorization.

## Doc hierarchy (L0-L4)

| Level | Location | Holds | Rule |
|---|---|---|---|
| L0 Global doctrine | `~/.claude/*.md` | Cross-project doctrine | True verbatim on another project => lives here; never repeated per-project. |
| L1 Root canonical | `CLAUDE.md`, `AGENTS.md`, `GUARDRAILS.md`, `LESSONS_LEARNED.md`, `DECISIONS.md`, `PROGRESS.md`, `TESTING.md`, `REPO_HEALTH.md` | Standing owner orders, TOP-LEVEL LAW, permanent invariants, running logs | A fact belongs here if it changes what a session may safely do anywhere, or is a dated order that must survive session amnesia. |
| L2 Topic docs | `docs/*.md` | Deep single-topic canonical detail L1 only summarizes | One owning doc per topic; each declares "this file wins." |
| L3 Work artifacts | `docs/plans/ACTIVE.md`, `.claude/plans`, `reports/**` | Approved-plan pointer, temporary plans, and generated reports | Only the explicitly approved path in `ACTIVE.md` is authoritative. Generated reports and temporary plans are never standing law. |
| L4 Skill/agent/hook local | `.claude/agents`, `.claude/hookify.*`, `.claude/skills`, `.claude/commands` | Execution instructions, judgment rubrics, mechanical enforcement | May restate/enforce an L1/L2 fact but must NEVER be its only home. An L4-only durable fact = hierarchy violation => promote up. |

**Promotion law:** If an agent/skill/hook states a rule "per CLAUDE.md" that CLAUDE.md
doesn't actually contain, that is a hierarchy defect; fix by adding it to L1, not by
trusting the citation.

## Lifecycle rule

When a plan or spec is complete or superseded, promote durable decisions and lessons into their L1
or L2 owners, add a concise history entry when useful, and remove the work artifact. Git preserves
the full text. Never keep stale executable instructions in the living documentation tree.
