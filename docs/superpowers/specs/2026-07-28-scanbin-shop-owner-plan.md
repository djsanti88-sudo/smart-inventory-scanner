Rescued from .tmp/skill-build 2026-07-29; canonical skill lives at .agents/skills/scanbin-shop-owner

# Scanbin Shop Owner Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and install a target-aware Scanbin shop-owner Playwright certification skill with fail-closed production scheduling, specialist review, and controlled learning.

**Architecture:** A deterministic Node controller classifies the target, locates the repaired Teach Bot, enforces authority and zero-paid gates, and invokes only safe harness modes. The skill instructions route Claude/Codex through deterministic execution, specialist evidence review, and controlled knowledge promotion.

**Tech Stack:** Node.js ESM, Node test runner, PowerShell/CMD launchers, Playwright Teach Bot, Codex/Claude local skills.

## Global Constraints

- Do not edit the Scanbin product repository outside the existing untracked `.tmp/skill-build` staging area.
- Never push, deploy, merge, call paid providers, create production credentials, or access arbitrary production tenants.
- Never print credentials or secret values.
- Production requires an exact allowlisted target and stable dedicated account reuse.
- Force live decode off and paid lookup budget to zero in every profile.
- Production remains BLOCKED until the server proves a dedicated-QA-tenant free-only capability and the account/business/backend fingerprints match.
- Preview remains preflight-only until its backend proves the same zero-paid contract.
- A skipped, blocked, not-run, or omitted required phase never counts as PASS.
- Install locally for Codex and Claude with implicit invocation enabled.

---

### Task 1: Deterministic target and safety controller

**Files:**
- Create: `.tmp/skill-build/scanbin-shop-owner/scripts/shop-owner.mjs`
- Create: `.tmp/skill-build/scanbin-shop-owner/scripts/shop-owner.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv)`, `classifyTarget(url, productionUrl)`, `buildExecutionPlan(options, env)`, `findTeachHarness(repo)`, `validateCurrentRun(report)`, and CLI commands `plan`, `self-check`, `run`, `weekly`, `explain`.

- [ ] Write tests for safe defaults, target classification, spoofed hosts, required confirmations, production credential presence without value disclosure, exact allowlisting, server free-only capability, zero-paid child environment, skip-is-not-pass, missing-phase failure, single-writer locking, and discovery of the exact approved harness SHA `c9228d6f70880434d4909a844ec20d8995265379`.
- [ ] Run the tests and verify RED because the controller does not exist.
- [ ] Implement the controller with structured JSON output and fail-closed exit codes.
- [ ] For local runs, start `npm.cmd run dev -- --port <reserved-port>` with pinned mock variables, wait for readiness, and terminate only that child.
- [ ] Invoke the exact 13-lesson override and verify all 13 appear in the current-run report.
- [ ] Run the tests and verify GREEN.

### Task 2: Skill procedure and progressive references

**Files:**
- Modify: `.tmp/skill-build/scanbin-shop-owner/SKILL.md`
- Create: `.tmp/skill-build/scanbin-shop-owner/references/coverage-contract.md`
- Create: `.tmp/skill-build/scanbin-shop-owner/references/specialist-council.md`
- Create: `.tmp/skill-build/scanbin-shop-owner/references/learning-policy.md`
- Create: `.tmp/skill-build/scanbin-shop-owner/references/operations.md`
- Modify: `.tmp/skill-build/scanbin-shop-owner/agents/openai.yaml`

**Interfaces:**
- Consumes: controller commands from Task 1.
- Produces: implicit triggers, routing rules, execution protocol, evidence adjudication, and promotion policy.

- [ ] Write concise frontmatter whose description includes local, Preview, production, customer-journey, session, import, reconcile, barcode, release-candidate, and recurring-QA triggers.
- [ ] Document the mandatory preflight and target-specific authority gates.
- [ ] Document the full coverage contract and specialist council.
- [ ] Document controlled learning and contradiction handling.
- [ ] Set `policy.allow_implicit_invocation: true`.

### Task 3: Launcher, validation, and offline forward proof

**Files:**
- Create: `.tmp/skill-build/scanbin-shop-owner/scripts/scanbin-shop-owner.cmd`

**Interfaces:**
- Consumes: controller from Task 1.
- Produces: stable Windows command surface.

- [ ] Run the Node unit suite.
- [ ] Run `C:\Users\djsan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\Users\djsan\.codex\skills\.system\skill-creator\scripts\quick_validate.py C:\Users\djsan\inventory\.tmp\skill-build\scanbin-shop-owner`.
- [ ] Run `plan` for local, Preview, and production-negative cases.
- [ ] Run Teach Bot `--self-check` through the controller and prove no browser/network/account/spend.
- [ ] Run a full local canonical shift against the pinned mock backend and require an honest coverage-gap verdict.
- [ ] Forward-test automatic routing with fresh reviewers and repair any blocking findings.

### Task 4: Local installation and weekly automation

**Files:**
- Install: `C:\Users\djsan\.agents\skills\scanbin-shop-owner`
- Create junction: `C:\Users\djsan\.claude\skills\scanbin-shop-owner`
- Install launcher: `C:\Users\djsan\.local\bin\scanbin-shop-owner.cmd`

**Interfaces:**
- Produces: local Codex/Claude discovery and Sunday 05:00 America/Chicago wakeup.

- [ ] Copy the verified skill into the local skills directory without touching Git.
- [ ] Create the Claude junction and launcher.
- [ ] Verify installed paths and rerun the installed self-check.
- [ ] Use the Codex automation tool to create a uniquely named Sunday 05:00 America/Chicago automation with a fail-closed prompt that invokes `$scanbin-shop-owner weekly production`; never overwrite the existing intelligence task.
- [ ] Confirm no remote, production, or paid action occurred during installation.
