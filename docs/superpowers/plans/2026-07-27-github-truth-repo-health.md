# GitHub Truth: Repo Health Audit, Branch Cleanup, Master Certification, GitHub-Driven Deploys

**Date:** 2026-07-27 | **Author:** Opus orchestrator | **Status:** DRAFT (pending Codex + Argus review)
**Owner decisions (2026-07-27 interview):** Audit+Clean+CI/CD full scope; archive-tag-then-delete cleanup; triage-then-PR for unmerged work; full engine mix (Sonnet + Codex GPT-5.5 + agy); full gate battery + deep review before certifying master; Vercel Git integration target; phase-gate approval batches. Push/merge-to-master/branch-deletion/Vercel-connection ALWAYS owner-gated at phase gates.

## Goal

Make `origin/master` the certified single source of truth, rescue all valuable unmerged work into PRs, archive+delete everything else, stand up CI + branch protection, and cut deploys over from local `vercel` CLI to GitHub-driven (PR previews + gated production) so no session ever deploys from a laptop again.

## Scout evidence (2026-07-27, scratchpad/scouts/*.md)

- **Branches (64 total: 42 local, 22 remote):** 42 MERGED, 12 ABSORBED, 10 STALE, 8 VALUABLE-UNMERGED, 0 UNKNOWN.
- **VALUABLE-UNMERGED:** feat/teach-bot (current, 25 unabsorbed commits, tracks origin 1 ahead), fix/release-stabilization (5 commits, 2026-07-26, branched FROM master tip, + dirty worktree: 27 modified + 9 new files), hotfix/decode-auth (1 commit, also duplicated inside feat/teach-bot), fix/phase3-followups (1 commit: M2 session-scope finalCounts + M1 Turso reset), fix/argus-cp1252 (3 commits, fable5 tool fixes), feat/reverse-upc-heads-up (1 commit, 855 behind, + dirty worktree with core AI-file edits).
- **git cherry lies on refactors:** fix/qa-report-2026-07-15 shows 10 "unabsorbed" but the fixes were re-implemented in master under different diffs -> STALE. Any absorption claim on a VALUABLE branch must be re-verified by content, not cherry counts.
- **Local feat/decode-ladder-goupc is a fossil** (its 3 unique commits are inside feat/teach-bot); the real mega-branch origin/feat/decode-ladder-goupc is 98.6% absorbed (5 doc/report commits left).
- **Master delta (282 commits):** coherent single-product evolution, zero dep changes, zero test deletions, no firestore.rules changes. RED FLAG: `2ddc081` (07-22) wholesale-replaced master's tree from fix/redo-round; must diff `f5ec6b1` (master before, Codex-verified ancestor of 2ddc081) vs `39aaff1` (TRUE redo-round tip; Codex correction - c0be3b8 is one commit earlier) to see what was dropped. Master tip `e5f0157` is an unproven deploy-wrapper patch.
- **Codex plan-review corrections (2026-07-27):** branch counts drifted (45 local / 25 remote at review time) - regenerate lists immediately before Gates 2/3; local and remote tips DIVERGE on several pairs (feat/decode-ladder-goupc local vs origin: 715/607 split) - archive each tip separately; `scripts/stress/sync-production-keys.mjs` does NOT exist on master (only sync-preview-keys.mjs).
- **Worktrees (16):** 5 clean+absorbed (wt-camera, wt-csv, wt-round2, wt-rungs, wt-variance) disposable now; inventory-stabilization and inventory-release-repair carry uncommitted valuable work; wt-teach (feat/teach-bot-build, 14 commits) believed superseded by feat/teach-bot - verify; wt-qafix has an unresolved owner doc (dev/CORPUS_SANITIZE_DIFF_FOR_OWNER.md).
- **Deploy/CI:** ONE workflow (mock Playwright E2E on push/PR to master); no tsc/lint/build CI; NO branch protection on master (API 404); `vercel.json` has `git.deploymentEnabled.master:false` (the hidden auto-deploy blocker); Vercel Preview env holds LIVE AI keys (OPENAI/GEMINI/GO_UPC + ENABLE_LIVE_AI_LOOKUP); prod = inventory-lovat-six.vercel.app (team sharpenly / project inventory); both CLIs authed; stale open PRs #11 and #3.

## Global Constraints (rule every landmine)

1. **Owner gates (hard):** no `git push` of master, no branch deletion (local or remote), no PR merge, no Vercel dashboard/env mutation, no production promote - except as explicitly approved at a phase gate. Pushing FEATURE branches + opening PRs is approved scope for Phase 2 keepers, executed only at the Phase 2 gate after the owner sees the PR list.
2. **Nothing unrecoverable, ever:** every branch slated for deletion first gets an archive tag created AND pushed - and where a local tip and its origin tip DIFFER, BOTH get tags (`archive/<branch>` for the remote tip, `archive/local/<branch>` for the local tip). Tag pushes verified via `git ls-remote --tags` BEFORE any deletion. Dirty worktrees get `git diff > patch` exports to scratchpad before removal. Worktree removal happens BEFORE deleting its checked-out branch (git refuses to delete a branch checked out in a worktree).
3. **Sequence law for deploy cutover:** branch protection FIRST, `vercel.json` flag flip LAST. Never flip `deploymentEnabled.master` while master accepts direct pushes.
4. **Preview safety before PR previews:** live AI keys in the Vercel Preview environment must be neutralized (owner decision at Phase 4 gate) before enabling Git-integration previews. Billing history L11/L12 makes this non-negotiable.
5. **git cherry is not proof of absorption.** Any "already in master" verdict on a VALUABLE branch requires content-level diff evidence (file-level diff or targeted grep of master), not cherry counts.
6. **Subagents never commit, never push.** Opus verifies diffs and commits. Codex tasks always get `--write` only when they must edit; audit tasks run read-only.
7. **No test weakening.** If a gate fails on master, fix root cause forward on a branch + PR; never edit tests to green.
8. **Windows/OneDrive trap:** worktrees live in C:/tmp; never create new worktrees under OneDrive paths. All npm/emulator commands for Codex go through cmd/Bash, not PowerShell npm.ps1.
9. **Cost lanes:** Codex = ChatGPT subscription OAuth only (verified logged in), scoped to DIFFS not whole-project (weekly quota lesson); agy for independent second opinions; Sonnet for bulk; NEVER OPENAI_API_KEY for dev tooling.
10. **Scan law untouched:** this effort changes no product behavior. Any rescue rebase that touches scanStore/inventory/decode paths must run `npm run test:ledger` in its worktree.

## Phase 0 - tooling gate (DONE 2026-07-27 in-session)

`codex login status` = ChatGPT subscription; `gh auth status` authed as djsanti88-sudo (repo+workflow scopes, proven by the deploy scout's successful `gh api` calls); `vercel` v57 authed (env listing worked). Codex's own sandbox cannot run gh/vercel - all gh/vercel mutations run from the orchestrator shell, never inside Codex.

## Phases and Tasks

### Phase 1 - Certify master as truth (read-only + local gates; no gate decisions needed to start)

- **T1.1 (shell, wt):** Create throwaway worktree `C:/tmp/wt-master-cert` at `origin/master`. Run gate battery: `npx tsc --noEmit`, `npm run test` (unit+dom), `npm run test:ledger`, `npm run build`, `npm run test:e2e`. Record results verbatim. Executor: Sonnet agent (shell-driver). Output: scratchpad/cert/gates.md.
- **T1.2 (Codex, read-only):** Deep review of the tree-swap: `git diff f5ec6b1 39aaff1 --stat` (true redo-round tip) + full inspection of what `2ddc081` dropped/replaced vs the master lineage it overwrote. Question: did the swap lose ANY commit content that existed on master-before and is absent from master-now (e5f0157)? Output: verdict + dropped-content list. (Correction already relayed to the running agent.)
- **T1.3 (Codex, read-only):** Adversarial review of the deploy-safety tooling on master (scripts/deploy-preview.mjs + release-sentinel.mjs + the 07-22 deploy-thrash commits) - is the wrapper sound, are the reverts complete, any half-reverted state?
- **T1.4 (agy, read-only):** Independent security review of the new catalog-review/catalog-dispute API subsystem that landed on master (auth checks, tenancy scoping, injection surface).
- **T1.5 (Sonnet):** Hotfix-series narrative: read the "Hotfix P1-P5" customer-data-protection commits as one incident; confirm nothing was left half-applied.
- **Gate 1 (owner batch):** master certification verdict + any defects found -> owner decides: certify as truth / fix-first list.

### Phase 2 - Rescue valuable unmerged work (triage -> rebase -> PR)

Per-branch worker pattern (one agent per branch, parallel, each in its own worktree): verify unabsorbed-by-content (Constraint 5), rebase onto origin/master (or cherry-pick if cleaner), run focused gates (tsc + affected tests; ledger suite if counting paths touched), report conflicts honestly. NO pushes until Gate 2.

- **T2.1:** fix/release-stabilization - FIRST commit its dirty worktree state (agent reviews the 27+9 files, proposes commit split, Opus commits in that worktree), then rebase whole branch. Highest value, most recent.
- **T2.2:** hotfix/decode-auth - verify vs feat/teach-bot duplicate; if identical content, fold into the teach-bot PR instead of its own.
- **T2.3:** fix/phase3-followups - rebase + ledger gate (touches finalCounts consumers).
- **T2.4:** fix/argus-cp1252 - rebase; gates = `python -m tools.fable5 selftest`.
- **T2.5:** feat/reverse-upc-heads-up - 855 behind: attempt rebase; if conflict-heavy, extract as fresh patch onto master. Include its worktree's uncommitted core-AI edits (review first).
- **T2.6:** feat/teach-bot - already tracks origin; verify vs wt-teach (feat/teach-bot-build 14 commits) and feat/teach-bot-clean: confirm superset claim by content, fold anything missing, then this branch becomes a PR as-is (it's 27 ahead of master's... behind-count means rebase needed too).
- **T2.7:** wt-qafix salvage: extract dev/CORPUS_SANITIZE_DIFF_FOR_OWNER.md + dev notes to scratchpad for owner review; confirm STALE verdict on the 10 commits by content.
- **T2.8 (current-checkout handoff):** After the teach-bot PR exists, move the MAIN checkout (C:\Users\djsan\inventory) off feat/teach-bot onto certified master, so no cleanup step ever collides with the active branch.
- **Gate 2 (owner batch):** PR list with per-branch evidence -> owner approves which to push+open. Then Opus pushes feature branches + `gh pr create` each. Branch lists REGENERATED fresh at this gate (counts drift; another machine may have pushed).

### Phase 3 - Cleanup (archive-tag then delete)

- **T3.1 (Sonnet):** Regenerate branch classification FRESH (counts drift), then generate the kill list (MERGED + ABSORBED + STALE minus Phase-2 reclassifications) as a reviewable script with STRICT ordering per branch: (1) tag remote tip `archive/<branch>` and, if divergent, local tip `archive/local/<branch>`; (2) push tags; (3) verify via `git ls-remote --tags`; (4) remove any worktree holding the branch (after patch-export of dirty files); (5) delete local branch; (6) delete remote branch. Include explicit PR disposition rules: PR #11 (feat/option-b-dryrun) and #3 (benchmark-tire-db-automation) get close-with-comment linking their archive tags (note: memory says benchmark-tire-db-automation must never be merged - closing the PR and archiving satisfies that).
- **T3.2:** Worktree removal list: the 5 disposable now + each rescued/archived one after its Phase 2 fate, with dirty-file salvage steps (inventory-demo reports, wt-teach-clean generated noise -> confirm-then-drop). Preflight: `git config core.longpaths true` check.
- **Gate 3 (owner batch):** owner edits/approves kill list -> Opus executes: tag, push tags, verify, remove worktrees, delete branches, close stale PRs, `git remote prune origin`.

### Phase 4 - CI + branch protection (the actual review gate)

- **T4.1 (Sonnet/Codex):** New workflow `.github/workflows/ci.yml`: job matrix = tsc --noEmit, eslint (focused paths), `npm run test` (unit+dom), `npm run build`; keep playwright.yml as-is. Must pass on master cert worktree before proposing. Delivered as a PR.
- **T4.2:** Branch protection for master via `gh api -X PUT /repos/djsanti88-sudo/smart-inventory-scanner/branches/master/protection` with the REQUIRED top-level fields (GitHub REST demands all four): `required_status_checks: {strict: true, contexts: ["<CI job name>", "<Playwright job name>"]}` (exact context names taken from the CI PR's check runs), `enforce_admins: true`, `required_pull_request_reviews: {required_approving_review_count: 0}` (solo-owner repo: PRs required but self-mergeable), `restrictions: null`. Payload validated against a dry-run read after apply; EXECUTED only at gate.
- **T4.3:** Preview-env AI lockdown: flags alone are NOT enough (Codex finding) - REMOVE the paid provider keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GO_UPC_API_KEY`) from the Vercel PREVIEW environment (they stay in Production), plus set `ENABLE_LIVE_AI_LOOKUP=false` for Preview. Then prove it: a preview deploy's /api/ai-lookup must report keys-absent/mock. Var names+targets recorded for restore; values never touched by agents. EXECUTED only at gate.
- **Gate 4 (owner batch, STRICT ORDER):** (1) Preview lockdown applied + verified -> (2) CI PR merged, check contexts observed on master -> (3) protection payload applied + read back (404 becomes config) -> only then Phase 5 may start. One owner approval covers the batch; execution is fail-closed in this order.

### Phase 5 - Vercel Git integration cutover

- **T5.1 (owner-guided, dashboard):** Connect GitHub repo in Vercel dashboard (owner clicks; Opus provides exact steps). CLI-link does NOT imply Git connection (Codex): verify the connected repo, Production Branch = master, preview behavior, and Ignored Build Step in the dashboard before proceeding. Also audit deployment retention policy + prune obsolete CLI-preview deployments.
- **T5.2 (PR):** Flip `vercel.json`: remove `git.deploymentEnabled.master:false`. Merged ONLY after: Gate 1 "certified as truth" verdict EXISTS by name, T4.2 protection is live, and T5.1 verification done.
- **T5.3 (PR):** Retire local deploy machinery: deprecate scripts/deploy-preview.mjs (keep as emergency fallback with a LOUD comment or delete - owner choice), update hookify deploy-lock notes, decide fate of scripts/stress/sync-*-keys.mjs.
- **T5.4 (PR):** Rewrite CLAUDE.md No-Deploy Rule + docs/COMMANDS.md for the PR-driven world: previews come from PRs automatically; production = merge to protected master (+ optional manual promote); local `vercel deploy` forbidden.
- **T5.5 (proof):** End-to-end: open a trivial PR -> Vercel bot posts preview URL -> checks green -> owner merges -> master auto-deploys -> verify prod URL serves the new commit. Screenshot/URL proof.
- **Gate 5 (owner batch):** cutover confirmation + first PR-driven deploy witnessed.

### Phase 6 - Close

- **T6.1:** Update PROGRESS.md checkpoint, BRAIN.md decisions, memory files (github-truth shipped), LESSONS_LEARNED if new lessons.
- **T6.2:** Final report: what was archived/deleted/PRed/merged, cert verdict, new deploy flow, spend summary.

## Acceptance criteria (done means)

1. Master certified: full gate battery green on origin/master AND T1.2 tree-swap review concludes no lost work (or losses recovered), verdicts recorded.
2. Every VALUABLE-UNMERGED branch has a merged-or-open PR, or an owner-approved park/archive decision. Zero unreviewed valuable work left outside GitHub.
3. Every non-valuable branch deleted locally AND on origin, each with a pushed `archive/<branch>` tag; worktrees reduced to the main repo + actively-needed ones; `git remote prune` clean.
4. CI workflow (tsc + lint + unit + build) green on master and required; branch protection active on master (protection API returns config, not 404).
5. A real PR produced an automatic Vercel preview URL, and merging it auto-deployed master to production (or promoted per owner choice) - witnessed end-to-end with the prod URL serving the merged commit.
6. Preview environment cannot make live paid AI calls (config proof, values untouched).
7. CLAUDE.md / COMMANDS.md / PROGRESS.md / BRAIN.md reflect the new deploy truth; final report delivered with spend summary.

## Proof / verification

- Master cert: verbatim gate outputs (tsc exit 0, vitest pass counts, ledger suite green, build success, e2e results) in scratchpad/cert/gates.md + reviewer verdicts (T1.2-T1.5) quoted in the Gate 1 batch.
- Rescues: per-branch focused-test output in each worktree + rebase conflict log; PR URLs as artifacts at Gate 2.
- Cleanup: post-deletion `git tag -l "archive/*"` listing proving every deleted branch has a pushed archive tag; `git branch -a` after-state.
- CI/protection: green check run on the CI PR; `gh api .../branches/master/protection` returning the applied config (was 404).
- Cutover: the T5.5 end-to-end proof - PR preview URL + prod serving the merged commit (deployment id vs commit sha), screenshots.

## Risks

- Master gate battery fails (master not actually healthy) -> Gate 1 becomes a fix-first list; certification blocked until green.
- Tree-swap 2ddc081 dropped real work -> T1.2 diff recovers it from git history (nothing is lost while refs/tags exist).
- Rebase conflicts on 855-behind branches -> fall back to fresh-patch extraction; worst case park with archive tag.
- Flipping vercel.json before protection -> ruled out by Constraint 3 sequencing.
- PR previews burning paid AI -> T4.3 lockdown gated before any preview traffic; Preview env keys neutralized first.
- Archive-tag deletion gap: remote branch deleted before its archive tag is confirmed pushed -> kill-script orders tag-push + verify (`git ls-remote --tags`) before any delete.
- Another machine/session pushes to master mid-effort -> protection lands in Phase 4; before that, re-run `git fetch` + delta check at each gate.

## Rollback

- Branch deletions: every deleted branch is recoverable via its pushed `archive/<branch>` tag (`git branch <name> archive/<name>`).
- Worktree removals: only after branch archived/PRed and dirty files salvaged; recreate with `git worktree add`.
- CI workflow + vercel.json changes: land as PRs; revert = `git revert` PR merge.
- Branch protection: removable via one `gh api -X DELETE`; recorded payload allows exact re-apply.
- Vercel Git connection: disconnectable in dashboard; local CLI deploy path (deploy-preview.mjs) is not deleted until the new flow is proven end-to-end (T5.5 precedes T5.3 finalization).
- Preview env var changes: previous var names/targets recorded before mutation; restore = re-set (values never printed/stored by agents; owner re-enters if needed).

## Out of scope

- No product-code behavior changes (scan law, decode ladder, counting untouched).
- No production DB/Firestore data changes; no firestore.rules edits or `deploy:rules:prod`. NOTE (Codex): rules deploys are a SEPARATE production surface outside Vercel - flagged for a follow-up owner decision (CI path-guard on firestore.rules + emulator-proof requirement), not executed in this effort.
- No paid/live AI calls anywhere in this effort.
- No history rewrite of master (the gitleaks key-scrub from 2026-07-20 memory remains a separate owner decision - flagged, not executed here).
- No new product features; teach-bot content merges only as-is via PR triage.

## Files to touch

- New: `.github/workflows/ci.yml`; this plan file; scratchpad artifacts (scouts/, cert/, killlist).
- Edit (via PR): `vercel.json`, `CLAUDE.md` (No-Deploy Rule), `docs/COMMANDS.md`, `PROGRESS.md`, `BRAIN.md`. NOTE: `scripts/deploy-preview.mjs` and `scripts/stress/sync-preview-keys.mjs`/`sync-production-keys.mjs` exist on origin/master, not on the current feat/teach-bot checkout - they are edited on a branch cut from master.
- Git metadata only (no file content): archive tags, branch deletions, worktree removals, branch protection, PR creation.

## Cost / budget

- Claude: subscription (Sonnet scouts/workers + Opus orchestration); no API dollars.
- Codex: ChatGPT subscription weekly quota, freshly reset; usage scoped to diffs/targeted reviews (T1.2, T1.3, plan review, ultra reviews) - est. well under half the weekly quota.
- agy/Gemini: subscription OAuth (T1.4 + second opinions).
- Cash spend: $0 planned. No paid API calls. Vercel stays on existing plan; preview deploys only after mock lockdown.

## Execution notes

- Fleet sizing: Phase 1 = 4-5 agents parallel; Phase 2 = up to 7 branch-workers parallel (disjoint worktrees); Phases 3-5 mostly Opus + 1-2 agents (mechanical + gated).
- Ultra review: after Phase 2 rebases and after Phase 4/5 config PRs (slim adversarial pass).
- Durable ledger: this plan file + PROGRESS.md checkpoints; scouts in scratchpad/scouts/.
