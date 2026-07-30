# Docs Consolidation + Repo-Health System — Plan

- **Author:** Opus (orchestrator)
- **Date:** 2026-07-29
- **Status:** DRAFT — awaiting adversarial review (Codex + multi-angle sub-agents) then owner approval
- **Branch (for execution, later):** `chore/docs-consolidation` off current `audit-fixes` HEAD
- **Execution note:** This session is PLAN-ONLY. No file moves, deletions, git operations, or code run here. Every action below is a *proposal* to be executed in a later, owner-approved session.

---

## 1. Goal

Consolidate the project's Markdown so there is **one obvious, current, non-contradictory place** for every kind of knowledge, make the **repo/GitHub sync state visible and self-reminding**, and establish a **content hierarchy** so durable project-wide facts never stay trapped inside a skill/agent/hook. Reduce clutter without losing history, and set up mechanisms that keep it healthy instead of decaying again.

## 2. Evidence base (verified this session, read-only)

- **1,260 `.md` total, but ~870 are vendor/plugin cache** (`.claude/plugins`, `.superpowers`, `open-source-agents`) — out of scope. Real footprint: **205 git-tracked docs** + ~277 already-gitignored generated reports.
- **`docs/superpowers/`**: 74 files; **60 are HISTORICAL/SUPERSEDED** (~1.54 MB). The four Phase 1–4 plans alone = 530 KB (34% of the corpus), all marked COMPLETE. **14 are ACTIVE** (`2026-07-29-audit-remediation.md` + `2026-07-29-audit-fixes/` 8 files + master-plan + 3 open tire-data efforts + 1 paired spec).
- **Living-doc overlaps/contradictions** (confirmed): `README.md` and `CLAUDE.md` maintain two hand-drifted doc maps (already disagree on `RISK_REGISTER.md`, `tools/fable5/README.md`); `FIREBASE_SETUP.md` preview policy **contradicts** `docs/DEPLOY_TRUTH.md`; `docs/CURRENT_CONTEXT.md` + `docs/BACKLOG.md` + `RISK_REGISTER.md` risk #1 describe a pre-merge world; `CHANGELOG.md` dead at v2.0.0; QA-bot trio (`QA_BOTS`/`AGENT_BOT_ROLES`/`REVISION_GATE`) triplicate the same tables; `DECODER_ARCHITECTURE.md` (labeled canonical) never mentions `pipeline.ts` while `ARCHITECTURE.md` §3 (verified 07-19/22) does — two competing decode-canon docs.
- **Discoverability**: zero dead links today, but CLAUDE.md's "phase source of truth" pointer is stale (points at complete `2026-07-19-master-plan.md`, skipping 9 newer plans); **no `docs/` index**; 13+ living docs orphaned from any map.
- **Hierarchy — 5 orphaned facts** live ONLY in a skill/agent (see Phase 4). Signature failure: `db-blank-filler/SKILL.md` cites "per CLAUDE.md" for the "barcodes are TEXT always" rule that **CLAUDE.md does not actually contain**.
- **Repo sync (live git)**: ~60 local branches, majority **never pushed** (no upstream); **`audit-fixes` (current active work) is not on origin**; branches 45–99 commits behind master; 4 uncommitted *code* files in the working tree (pre-existing, not part of this work).
- **Stray tracked reports**: ~30 `data/tire-knowledge/**/task-*-report.md` (+`mine-report.md`, `run-log.md`, `siblings-report.md`, `MANIFEST.md`) were committed into a curated-corpus dir; they belong in gitignored `reports/`.
- **Disk**: `reports/` (21 MB), `.tmp/` (520 MB), `backups/` (435 MB) all already gitignored → ~955 MB reclaimable. `backups/claude-tire-db-handoff-2026-07-28/` is a hash-verified repair audit trail (ARCHIVAL, not disposable).

## 3. Governing model — the doc hierarchy (L0–L4)

| Level | Location | Holds | Rule |
|---|---|---|---|
| L0 Global doctrine | `~/.claude/*.md` | Cross-project doctrine | True verbatim on another project ⇒ lives here; never repeated per-project. |
| L1 Root canonical | `CLAUDE.md`, `AGENTS.md`, `LESSONS_LEARNED.md`, `DECISIONS.md`, `RISK_REGISTER.md`, `PROGRESS.md`, `TESTING.md`, `REPO_HEALTH.md` | Standing owner orders, TOP-LEVEL LAW, permanent invariants, running logs | A fact belongs here if it changes what a session may safely do anywhere, or is a dated order that must survive session amnesia. |
| L2 Topic docs | `docs/*.md` | Deep single-topic canonical detail L1 only summarizes | One owning doc per topic; each declares "this file wins." |
| L3 Work artifacts | `docs/superpowers/{plans,specs,reports}`, `.claude/plans`, `reports/**` | Dated plans/specs/reports | Allowed to go stale by design; never a source of a standing rule. If a durable invariant surfaces, lift it to L1/L2 in the same change. |
| L4 Skill/agent/hook local | `.claude/agents`, `.claude/hookify.*`, `.claude/skills`, `.claude/commands` | Execution instructions, judgment rubrics, mechanical enforcement | May restate/enforce an L1/L2 fact but must NEVER be its only home. An L4-only durable fact = hierarchy violation ⇒ promote up. |

**Promotion law (new, to be documented):** *If an agent/skill/hook states a rule "per CLAUDE.md" that CLAUDE.md doesn't contain, that is a hierarchy defect; fix by adding it to L1, not by trusting the citation.*

## 4. Phased plan (sequenced: safety → reversible → durable → destructive-last)

### Phase 0 — Baseline & safety (no mutations)
- Create `chore/docs-consolidation` branch off current HEAD; keep the 4 pre-existing uncommitted code files untouched; make **doc-only commits**.
- Snapshot `git for-each-ref` + ahead/behind state → seed data for `REPO_HEALTH.md`.
- Verify `.tmp/skill-build/scanbin-shop-owner/**` is duplicated in a real skills dir before any Phase 6 deletion.

### Phase 1 — Repo health & sync truth (first, to protect unpushed work)
- **New `REPO_HEALTH.md` (root, L1):** single "is local synced with GitHub" doc — pushed vs local-only, `audit-fixes` is local-only and needs push/PR, categorized branch inventory, what's good-to-merge. Written to be regenerable by the reminder tool (Phase 5).
- **Propose-only branch report:** every branch tagged `merged` / `dead-stale` / `valuable-unpushed` / `active` + recommended action. **No deletion or push without per-branch owner approval.**

### Phase 2 — Archive historical backlog (reversible)
- `git mv` the **60 HISTORICAL/SUPERSEDED** plans/specs/reports → `docs/archive/superpowers/{plans,specs,reports}/` + `docs/archive/superpowers/INDEX.md` (File | What it was | Era), mirroring `docs/archive/README.md`. Keep the `2026-07-29-audit-*` bundle, master-plan, and the 3 open tire-data efforts LIVE.
- Update CLAUDE.md "phase source of truth" → `2026-07-29-audit-remediation.md`, reworded to reference "newest dated plan" generically so it can't silently go stale.
- `git rm --cached` the ~30 stray `data/tire-knowledge` report files + add a gitignore rule (`data/tire-knowledge/**/task-*-report.md`, `mine-report.md`, `run-log.md`, `siblings-report.md`, `exports/**/MANIFEST.md`). Files stay on disk. **Preserve** the real corpus docs (`HARVESTER_PLAN_v4.md`, specs, handoffs, `model_page_sample.md` fixture).

### Phase 3 — Consolidate & repair living docs
- **Merges:** `CHANGELOG.md` → `docs/archive/CHANGELOG_v1-v2.md` (frozen banner); `docs/CURRENT_CONTEXT.md` → retire, fold live bits into PROGRESS.md top; QA-bot trio → one `docs/QA_BOTS.md` (persona table from AGENT_BOT_ROLES as core + how-to-run + pre-handoff checklist as sections); `PLAN_TEMPLATE.md` → appendix of `docs/PLAN_EXECUTION.md`; `README.md` → trim to onboarding + a single pointer to the docs index.
- **Contradiction fixes:** `FIREBASE_SETUP.md` preview paragraph → replace with pointer to `DEPLOY_TRUTH.md`; add `[STALE — see PROGRESS.md/DEPLOY_TRUTH.md]` banners to `GO_LIVE_CHECKLIST.md`, `BACKLOG.md`, `HOTFIX_FOLLOWUPS.md` (or refresh); close `RISK_REGISTER.md` risk #1; update `DECODER_ARCHITECTURE.md` to reference `src/server/decode/pipeline.ts` as the real orchestrator (resolve dual-canon); append Phase 2–6/teach-bot coverage to `TESTING.md` (or banner it honestly).

### Phase 4 — Hierarchy & knowledge promotion
- Document the L0–L4 model + promotion law **inside `docs/README.md`** (the index; per §8b.1 `docs/DOC_HIERARCHY.md` is CANCELLED — the hierarchy is explained where you navigate). Link to that section from CLAUDE.md.
- Create the new `GUARDRAILS.md` (root, tiny, auto-load target) containing the $150/mo north star + owner-approved invariants enumerated in the master plan M0 (`2026-07-29-product-readiness-master-plan.md` §M0). Auto-load mechanism: register it via the existing SessionStart hook (`scripts/hooks/fable5-sessionstart.ps1`, see §8b.6) OR a CLAUDE.md `@GUARDRAILS.md` import — pick one and record which in the commit; a hook edit is a code change committed separately from the doc-only branch.
- **Promote the 5 orphaned facts, leaving pointers in the source skill:**
  1. UPC-A/EAN-13 twin-derivation (+China 69x "never fabricate UPC-A") → `docs/GS1_COUNTRY_REFERENCE.md`.
  2. "Barcodes & part numbers are TEXT always" → `CLAUDE.md` Resolver Trust Rules (fixes the false citation).
  3. "New data class = new app-level test" (owner law) → `docs/PLAN_EXECUTION.md` proof-gate, generalized beyond db-blank-filler.
  4. Standing order "MPN web research CANCELLED (2026-07-28)" → `DECISIONS.md` (+ pointer in skill).
  5. ODbL / Open Food Facts license obligation → `RISK_REGISTER.md` new line item + pointer from `ARCHITECTURE.md` retail-knowledge entry.

### Phase 5 — Self-reminding health system (durability)
- **`docs/README.md` index (L2 spine):** Living / Reference / Historical columns; CLAUDE.md + README both point here instead of two drifting maps.
- **Tech-debt ledger:** a "fix-don't-pile-on" section **inside `REPO_HEALTH.md`** (per §8b.1 the standalone `docs/KNOWN_ISSUES.md` is CANCELLED — one health doc: what's synced, what's broken).
- **Session reminder automation:** extend the existing `release-hygiene` agent + a SessionStart/Stop hook that flags valuable-but-unpushed branches, stale branches, uncommitted work, and stale doc pointers; can regenerate `REPO_HEALTH.md`.

### Phase 6 — Disk cleanup (destructive, last, gated)
- **OWNER-GATED:** Delete `.tmp/` (~520 MB) ONLY after Phase-0 skill-source verification AND the §8b.5 shop-owner rescue (`.tmp/skill-build/docs/2026-07-28-scanbin-shop-owner-{design,plan}.md` + `scanbin-shop-owner-global.cmd` are sole copies — copy them out first). `.tmp/` is untracked; this wipe is not git-recoverable.
- Archive `backups/` off-disk (external/cloud), confirm Turso sync complete, THEN delete (~435 MB). **Owner-gated confirm before removing this repair audit trail.**
- `reports/` already gitignored; optional disk clear.

## 5. Risks & mitigations

| Risk | Sev | Mitigation |
|---|---|---|
| Editing load-bearing L1 files (CLAUDE.md/AGENTS.md) breaks agent behavior | High | Keep edits minimal/additive; run link + grep proofs; no rule deletions, only relocation with pointers. |
| Archived plan referenced by a live doc/hook → dead link | Med | Pre-move grep for inbound references; update pointers in same commit; link-check gate. |
| Entangling our doc commits with pre-existing uncommitted code | Med | Dedicated branch; doc-only commits; never `git add` the 4 code files. |
| Deleting `backups/` loses repair audit trail | High | Off-disk archive + owner confirm before delete (Phase 6 gate). |
| Branch deletion loses wanted work | High | Propose-only; per-branch owner approval; reflog recovery window. |
| A "historical" plan is actually still load-bearing | Med | INDEX every archived file; 5-min confirm on the two `plan-b/plan-c` superseded inferences before moving. |
| Promoting a fact subtly changes its meaning | Med | Quote source verbatim; cross-reference the runtime-contract test that enforces it. |

## 6. Proof plan (docs work — no code execution to claim)

- Dead-link check across all living docs (every referenced path resolves).
- Grep proofs: no doc claims to be a second "current status"; exactly one doc map (index) is authoritative; each promoted fact now present in its L1/L2 home; each source skill retains a pointer.
- `git status` shows doc-only diffs on `chore/docs-consolidation`; the 4 code files remain unstaged/untouched.
- Reminder hook demonstrably fires on a test session (start/stop) surfacing the unpushed-branch warning.
- Every archived file has an INDEX row or a `[SUPERSEDED]` banner.

## 7. Out of scope

- Executing anything this session (plan-only).
- Rewriting doc *content* beyond the merges/repairs listed (no tone/style overhaul).
- Touching the pre-existing audit-fixes code changes.
- Pushing branches or deploying (owner-gated, separate).

## 8. Open questions for the owner

1. `REPO_HEALTH.md` at root vs `docs/`? (Plan assumes root for visibility.)
2. ~~`KNOWN_ISSUES.md` in `docs/` vs root?~~ RESOLVED by §8b.1 — cancelled as a standalone file; the ledger is a section of `REPO_HEALTH.md`.
3. Reminder automation: extend `release-hygiene` agent (assumed) vs a standalone hook, vs both?
4. Archive mechanism: deep dated folders vs a single `docs/archive/superpowers/` mirror with one INDEX (plan assumes the mirror + INDEX).

## 8b. v2 revisions (owner-approved review round, 2026-07-29)

1. **Fewer new files (5 → 3):** `docs/DOC_HIERARCHY.md` is CANCELLED — the L0-L4 model + promotion law go into `docs/README.md` (the index explains the hierarchy where you navigate). `docs/KNOWN_ISSUES.md` is CANCELLED — the tech-debt/"fix-don't-pile-on" ledger becomes a section of `REPO_HEALTH.md` (one health doc: what's synced, what's broken). New files remaining: `GUARDRAILS.md` (auto-load target, stays tiny), `REPO_HEALTH.md`, `docs/README.md`.
2. **Delete-for-real list — OWNER-GATED (recoverability differs by path, verify before each):** DELETE, not archive:
   - `specs/` stub (1 tracked file), `docs/decode/` (3 tracked), `proof-archive/24d1797-option3/` (6 tracked) — TRACKED, recoverable from git history via `git checkout <sha>^ -- <path>`.
   - `docs/archive/onedrive-migration-2026-07-27/` and `docs/archive/strays/` — **UNTRACKED (0 tracked files): NOT git-recoverable.** Deletion is irreversible. HARD PRECONDITION: byte-diff-verify each file is truly a duplicate of a committed archive copy (onedrive-migration) or confirmed sqlite junk/mangled temp (strays) BEFORE removal; do not delete on the assumption alone.
   - `docs/decode/`: superseded per CLAUDE.md's own map — but FIRST investigate who wrote to `eval-baseline.md` on 2026-07-29 (working-tree mtime is 2026-07-29 though last commit is 2026-07-20; an uncommitted write means content not yet in git). Do not delete until that write is explained.
   - `proof-archive/24d1797-option3/`: duplicate PNGs (5 of 6 already exist in `docs/archive/proof-images/`) — verify the 6th before removal.
3. **CLAUDE.md deep slim-down (owner order: most powerful, safest way):** cut duplicated decode/deploy/QA prose to sharp pointers at the canonical docs. SAFETY PROTOCOL: (a) work on a copy first; (b) byte-diff proof that TOP-LEVEL LAW, Resolver Trust Rules, and every owner order survive verbatim (only relocations allowed, no deletions of law); (c) the slimmed version is attack-panel reviewed (incl. Codex) against the original for any lost rule BEFORE it replaces the file; (d) old version preserved in git; (e) rollback = single revert.
4. **`docs/PLAN_EXECUTION.md` becomes plugin-independent:** enrich the existing doc with the essential how-to now trapped in superpowers skills — TDD failing-test-first steps, the plan attack-panel procedure, the wave/agent-pool execution model — so the process works with zero plugins installed.
5. **Rescue the shop-owner skill from `.tmp`:** copy `.tmp/skill-build/docs/2026-07-28-scanbin-shop-owner-{design,plan}.md` + `scanbin-shop-owner-global.cmd` (sole copies, needed for the virtual-shops track) into the real skill location / project docs BEFORE any `.tmp` cleanup.
6. **Doc-freshness line at session start:** extend the EXISTING SessionStart hook (`scripts/hooks/fable5-sessionstart.ps1`) to print one orientation line: newest plan, REPO_HEALTH date, stale-doc warnings. (Hook edit = code change; separate commit outside the doc-only branch, per the doctrine reviewer.)

## 9. Acceptance criteria (definition of done)

- No living doc contradicts another; each topic has exactly one canonical owner that declares "this file wins."
- Every *archived* file has an INDEX row or a `[SUPERSEDED → see X]` banner (all `git mv`, history preserved). The explicit §8b.2 delete-for-real list (byte-identical duplicates + junk) IS deleted with `git rm` — git history is that content's archive; every deleted path must be a verified duplicate/junk before removal.
- `docs/README.md` is the single docs index; CLAUDE.md + README both point to it (no two hand-maintained maps).
- The 5 orphaned facts are present in their L1/L2 home, with a pointer left in the source skill; `GUARDRAILS.md` auto-loads every session.
- `REPO_HEALTH.md` exists and the propose-only branch report is delivered; no branch is deleted or pushed without per-branch owner approval.
- **Proof:** dead-link check across all living docs passes (extended to `.ts/.tsx/.mjs/.spec.ts/.py` comments, not just docs — per the data-loss reviewer); grep confirms single-source-of-truth; `git status` shows doc-only diffs on `chore/docs-consolidation` with the pre-existing code files untouched.

## 10. Rollback / recovery

- All work is doc-only commits on `chore/docs-consolidation`; `git revert` or dropping the branch restores the prior state instantly.
- Archives use `git mv` (full history preserved) — reversible with a second `git mv`. Of the §8b.2 delete-for-real items, the TRACKED ones (`specs/`, `docs/decode/`, `proof-archive/24d1797-option3/`) use `git rm` and are recoverable via `git checkout <sha>^ -- <path>`. The UNTRACKED ones (`docs/archive/onedrive-migration-2026-07-27/`, `docs/archive/strays/`) have NO git history and are NOT recoverable — they are deleted only after per-file byte-identical-duplicate / junk verification (OWNER-GATED, per §8b.2).
- Disk deletions (Phase 6) are gated and reversible only via the off-disk archive — so `backups/` is hash-verified and copied off-disk BEFORE deletion, and `.tmp/` is enumerated file-by-file for sole-copy files (per the data-loss reviewer) before any wipe.
- The pre-existing uncommitted `audit-fixes` code changes are never staged, so nothing this plan does can lose them.

## 11. Files to touch / affected files / implementation files

- **Root:** `CLAUDE.md` (phase-pointer + QA-bot citations + Resolver-Trust addition), `AGENTS.md`, `README.md` (trim), **new** `GUARDRAILS.md`, **new** `REPO_HEALTH.md`, `CHANGELOG.md`→archive, `PLAN_TEMPLATE.md`→fold, `RISK_REGISTER.md` (close risk #1 in place, add ODbL), `DECISIONS.md` (MPN order), `TESTING.md` (refresh).
- **docs/:** **new** `docs/README.md` (index + L0-L4 hierarchy section — absorbs the cancelled DOC_HIERARCHY.md), `docs/QA_BOTS.md` (merge target), `docs/AGENT_BOT_ROLES.md`+`docs/REVISION_GATE.md` (retire into QA_BOTS), `docs/CURRENT_CONTEXT.md` (retire — carry the `benchmark-tire-db-automation` poison-guard warning to RISK_REGISTER first), `docs/BACKLOG.md`/`docs/HOTFIX_FOLLOWUPS.md`/`docs/GO_LIVE_CHECKLIST.md` (banner/refresh), `docs/DECODER_ARCHITECTURE.md` (pipeline.ts), `docs/GS1_COUNTRY_REFERENCE.md`+`docs/PLAN_EXECUTION.md` (promotions), `docs/decode/`, `docs/pilot/`, `docs/reviews/`, `docs/playwright/`, `testing/app-knowledge/` (missed clusters — classify).
- **Archive targets:** **new** `docs/archive/superpowers/{plans,specs,reports}/` + **new** `docs/archive/superpowers/INDEX.md`.
- **Data-loss guardrail:** before any `git mv`, grep the whole tracked tree (`src/`, `e2e/`, `scripts/`) for citations of the 60 archived plans and update them in the same commit (live `.ts`/`.spec` files reference them).

## 12. Cost / budget

- Doc-only work on the Claude Code subscription — no per-call dollars, no paid-API calls, no fabricated spend. Effort, not money.
- No external cost. The only "spend" is the review this plan already received (6-agent attack panel + Fable 5), all on subscription/local.

## 13. Fable 5 / Argus note

Argus `review-plan` flagged glob/directory references (`.claude/hookify.*`, `docs/*.md`, `docs/archive/superpowers/{plans,specs,reports}/`, `docs/superpowers/{plans,specs,reports}`) as "missing files" — these are patterns, not literal paths: false positives. `docs/README.md`, `GUARDRAILS.md`, `REPO_HEALTH.md`, `docs/archive/CHANGELOG_v1-v2.md`, `docs/archive/superpowers/INDEX.md` are intentional NEW-FILE deliverables of this plan, not missing references. (Note: `docs/DOC_HIERARCHY.md` and `docs/KNOWN_ISSUES.md` are CANCELLED per §8b.1 — folded into `docs/README.md` and `REPO_HEALTH.md` respectively.)
