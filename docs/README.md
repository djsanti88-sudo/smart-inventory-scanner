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
| `RISK_REGISTER.md` | Known risks, severity, mitigation, approval needs, status |
| `LESSONS_LEARNED.md` | Permanent hard-won lessons (numbered, e.g. L11 Gemini billing) |
| `RECONCILIATION.md` | Instruction-reconciliation markers across sessions |
| `docs/PLAN_EXECUTION.md` (appendix) | Plan template (root `PLAN_TEMPLATE.md` is a redirect stub) |
| `FIREBASE_SETUP.md` | Backend foundation setup for Firebase Auth/Firestore |
| `FIREBASE_SECURITY.md` | Tenancy/security model for Firestore rules |
| `MANUAL_LIVE_TEST.md` | Owner-gated manual live-decode checklist |
| `README.md` | Repo onboarding; points here for the full docs map |

### `docs/`
| File | Purpose |
|---|---|
| `ARCHITECTURE.md` | Full verified architecture map + the known traps |
| `ARCHITECTURE_LAYERS.md` | Business logic vs. provider/infrastructure logic: the seams, the leak points, and what a provider migration would touch |
| `COMMANDS.md` | Every script, port, env var name, PAID/LIVE warnings |
| `DEPLOY_TRUTH.md` | Canonical deploy mechanics: Git integration, PR previews, prod gate |
| `DECODER_ARCHITECTURE.md` | Canonical decode-pipeline doc (`runDecodePipeline`) |
| `PLAN_EXECUTION.md` | How plans are created, attacked, executed, and proven done |
| `QA_BOTS.md` | Human-bot proof gate: personas, how to run, pre-handoff checklist |
| `AGENT_BOT_ROLES.md` | QA bot persona/role reference |
| `REVISION_GATE.md` | The full handoff/revision gate definition |
| `OBSERVABILITY.md` | Error tracking, telemetry, breaker/cap alerting |
| `RECOVERY.md` | Backup/restore and disaster-recovery notes |
| `RELEASE_TARGETS.md` | What "ready to ship" means per release |
| `GO_LIVE_CHECKLIST.md` | Pre-launch checklist (see REPO_HEALTH.md tech-debt: currently stale) |
| `BACKLOG.md` | Open backlog items |
| `HOTFIX_FOLLOWUPS.md` | Tracked follow-ups from hotfixes |
| `SCHEDULED_QA_BOTS.md` | Scheduled/automated QA bot runs |
| `WEEKLY_INTEL_SETUP.md` | Weekly intel job setup |

## Reference (stable lookup material, not status)

| File | Purpose |
|---|---|
| `docs/GS1_COUNTRY_REFERENCE.md` | GS1 barcode country-prefix reference data |
| `docs/WEEKLY_REPORT_STYLE_GUIDE.md` | Style guide for the weekly report |
| `docs/FULL_SYSTEM_AUDIT_PROMPT.md` | Standing prompt used for full-system audits |
| `docs/FIRECRAWL_USAGE.md` | Firecrawl tool usage reference |

## Historical (superseded, complete, or point-in-time)

Everything that is no longer the current source of truth but is kept for lineage
lives under `docs/archive/`. Start at `docs/archive/superpowers/INDEX.md` for the
indexed list of archived plans, specs, and reports (file, what it was, era).
Do not treat anything under `docs/archive/` as current; it is not maintained.

## Doc hierarchy (L0-L4)

| Level | Location | Holds | Rule |
|---|---|---|---|
| L0 Global doctrine | `~/.claude/*.md` | Cross-project doctrine | True verbatim on another project => lives here; never repeated per-project. |
| L1 Root canonical | `CLAUDE.md`, `AGENTS.md`, `LESSONS_LEARNED.md`, `DECISIONS.md`, `RISK_REGISTER.md`, `PROGRESS.md`, `TESTING.md`, `REPO_HEALTH.md` | Standing owner orders, TOP-LEVEL LAW, permanent invariants, running logs | A fact belongs here if it changes what a session may safely do anywhere, or is a dated order that must survive session amnesia. |
| L2 Topic docs | `docs/*.md` | Deep single-topic canonical detail L1 only summarizes | One owning doc per topic; each declares "this file wins." |
| L3 Work artifacts | `docs/superpowers/{plans,specs,reports}`, `.claude/plans`, `reports/**` | Dated plans/specs/reports | Allowed to go stale by design; never a source of a standing rule. If a durable invariant surfaces, lift it to L1/L2 in the same change. |
| L4 Skill/agent/hook local | `.claude/agents`, `.claude/hookify.*`, `.claude/skills`, `.claude/commands` | Execution instructions, judgment rubrics, mechanical enforcement | May restate/enforce an L1/L2 fact but must NEVER be its only home. An L4-only durable fact = hierarchy violation => promote up. |

**Promotion law:** If an agent/skill/hook states a rule "per CLAUDE.md" that CLAUDE.md
doesn't actually contain, that is a hierarchy defect; fix by adding it to L1, not by
trusting the citation.

## Lifecycle rule

A plan or spec moves to `docs/archive/` when its work is COMPLETE or SUPERSEDED and
merged. When archiving surfaces a standing rule that was never written down anywhere
durable, promote that rule to its L1 or L2 home in the same change, don't just file
the plan away and lose the rule with it.
