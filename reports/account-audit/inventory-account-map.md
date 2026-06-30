# Inventory App - Account / Repo / Deployment / Backend Conflict Audit

Date: 2026-06-28 (local)  |  Mode: READ-ONLY (no deploy, push, merge, rollback, commit, delete, or Firebase/Vercel mutation)
Author: Claude Code  |  Trusted baseline: `bc464e6` "Master Baseline v1"

Risk scores below are 0-100 where **higher = more risk**.

---

## 0. Phase 0 safety snapshot (PROVEN before audit)

| Item | Value |
|---|---|
| Working directory | `c:\Users\djsan\inventory` |
| Current branch | `feat/weekly-report-system` |
| Current HEAD | `b9dea2a` (1 commit ahead of the deployed `955954e`) |
| Tree state | DIRTY: 56 tracked changes + 70 untracked = 126 entries |
| `baseline-v1` tag | -> `bc464e6` (verified correct) |
| Backup branch | `backup/pre-repair-20260628-2054` -> `b9dea2a` |
| WIP safety ref (incl untracked) | `refs/backup/wip-pre-repair-20260628-2054` -> `4876812` (869 files vs 731 in HEAD) |
| Tracked patch | `C:\tmp\inventory-backups\pre-repair-20260628-2054\tracked-changes.patch` (6.9 MB) |
| Status snapshot | `...\status-snapshot.txt` (126 lines) + `untracked-files.txt` (70) |
| Full zip | `...\working-tree-backup.tar.gz` (85 MB; includes `.git` + all source; excludes node_modules/.next/data raw dumps) |

Nothing is lost; the dirty tree is captured three independent ways (WIP ref, patch, zip).

---

## 1. GitHub map (Phase 1)  -  risk 55/100

- **Repo:** `github.com/djsanti88-sudo/smart-inventory-scanner` (PRIVATE). Single remote `origin`.
- **Default branch:** `master` (`09e5b9f`, Jun 15) - **stale**; not where current work lives.
- **Branch protection on master:** **NONE** ("Branch not protected"). Anything can push to the default branch.
- **Where the work actually is:** `feat/weekly-report-system` = **86 commits ahead of master, 0 behind**. Deployed code + today's work live here, **never merged to master**.
- **Baseline branch `tire-barcode-db`:** **NOT on origin** (local-only). But the baseline commit `bc464e6` **is** reachable on origin (contained in `feat/weekly-report-system`).
- **Open PRs:** #6 `decoder-hardening-v1-local -> master` (tire hardening), #3 `benchmark-tire-db-automation -> master` ($30-cap pipeline). Both stale, target master.
- **GitHub Actions:** none. **Repo Actions secrets:** none. (Deploys are Vercel-Git, not Actions.)
- **Tracked generated-file bloat:** 63 `reports/` files, 90 `e2e/proof` binaries, 103 image/zip files tracked - this is the noise flooding Source Control.
- **Secrets in git:** no tracked `.env`/secret/credential files (a past QA-JSON key leak was already removed in `4cea140`). Clean now; keep watching.

## 2. Vercel map (Phase 2)  -  risk 70/100

**TWO Vercel projects, BOTH auto-deploying the SAME GitHub repo** (blocker-class):

| Project | Owner-facing? | Production alias | Current prod SHA | Notes |
|---|---|---|---|---|
| **`inventory`** (`prj_6Gq...`) | YES ("our website") | `inventory-lovat-six.vercel.app` (+ `inventory-sharpenly`, `inventory-djsanti88-sudo-sharpenly`) | **`955954e`** (my banner-fix deploy) | the thing to fix |
| **`smart-inventory-scanner`** (`prj_c7T...`) | legacy (created first) | `smart-inventory-scanner.vercel.app` (+ `-sharpenly`, `-git-master`) | **`09e5b9f`** (master, Jun 15) | STALE prod still live |

- Both projects built the same push (`b9dea2a`) at the same second -> every push fans out to two projects.
- **All deployments show `gitDirty=1`** (deployed from dirty working trees), including the baseline and mine.
- **Env vars: NOT inspected** - no MCP tool lists Vercel env, and Vercel CLI is not installed. **(GAP 1)**

## 3. Firebase map (Phase 3)  -  risk 45/100

- **Authenticated:** `djsanti88@gmail.com`.
- **Real cloud projects:** `magic-words-quiz`, `realtor-quiz`, **`smart-inventory-scanner-app`** (projNum 368038862704 = the inventory app's prod backend).
- **Local active project = `demo-smart-inventory`** = a `demo-` **emulator-only** project (confirmed "not found or deleted" as real cloud). Local dev never touches production data - by design, but it means the MCP currently cannot see prod.
- **Production Firebase project = `smart-inventory-scanner-app`** (inferred: only real inventory project; prod uses it via `NEXT_PUBLIC_FIREBASE_PROJECT_ID` - unconfirmed pending Vercel env).
- **Rules (local `firestore.rules`, source of truth):** strong multi-tenant model. Business data under `/businesses/{bid}/...` role-gated (owner/admin/counter); membership-derived from path; default-deny. **`catalogEntries` and `retailCatalogEntries` are PUBLIC-read, server-only-write.**
- **Poison alias (`078742051451` water->dress):** lives in `smart-inventory-scanner-app`, in either a shop's `/businesses/{bid}/aliases` (saw "approved alias" + "Synced") or the global `catalogEntries`. **Location not confirmed - needs prod project access. (GAP 2)**
- **Deployed rules vs local rules:** NOT verified (needs prod project access).

---

## 4. Cross-system map (Phase 4)

```
GitHub repo:                 djsanti88-sudo/smart-inventory-scanner (private)
Default branch:              master (stale, unprotected)
De-facto production branch:  feat/weekly-report-system (86 ahead of master, NOT merged)
Approved baseline tag:       baseline-v1 -> bc464e6 (local; commit also on origin)
Current local branch:        feat/weekly-report-system
Current local SHA:           b9dea2a
Production Vercel project:    inventory
Production alias:             inventory-lovat-six.vercel.app
Production SHA (live now):    955954e   (NOT the approved baseline)
Production Firebase project:  smart-inventory-scanner-app (inferred)
Firestore database:          (default)
Local Firebase project:      demo-smart-inventory (emulator-only)
Source-of-truth app URL:     inventory-lovat-six.vercel.app
Preview URL strategy:        none formalized (both projects spray previews)
Rollback target:             dpl_DpERNxvnR (bc464e6 = Master Baseline v1)
Duplicate/conflicting:       2 Vercel projects on 1 repo; local demo vs prod Firebase;
                             default branch != deployed branch; tire-barcode-db local-only
```

### 11 alignment answers
1. **GitHub/Vercel/Firebase aligned?** NO - default branch is `master` but prod deploys `feat/weekly-report-system`; local Firebase is the demo emulator while prod is `smart-inventory-scanner-app`.
2. **More than one Vercel project for the same repo?** YES - `inventory` + `smart-inventory-scanner`. **Blocker-class.**
3. **More than one Firebase project usable by mistake?** YES - `demo-smart-inventory` (local) vs `smart-inventory-scanner-app` (prod), plus 2 unrelated quiz projects.
4. **Production alias points to expected project?** The owner's URL is on `inventory` (correct), but `smart-inventory-scanner.vercel.app` still serves a stale prod (`09e5b9f`) - confusing.
5. **Production running the approved SHA?** NO - prod = `955954e`; approved baseline = `bc464e6`.
6. **Dirty deployments?** YES - every deploy is `gitDirty=1`.
7. **Generated files polluting Git?** YES - 63 reports + 90 proof binaries + 103 images tracked.
8. **Secrets at risk in tracked reports/logs?** Not currently (clean; one past leak removed). Low, keep gated.
9. **Safe to commit?** NO, not as-is - 126 mixed files need the bucketed hygiene pass first.
10. **Safe to deploy?** NO - production frozen; alias != approved SHA; two projects; no source of truth.
11. **What must be fixed before deploy?** One source-of-truth branch + one Vercel project; confirm prod Firebase via Vercel env; restore/confirm approved SHA; gate deploys behind release-hygiene + explicit SHA confirmation.

---

## 5. Hard blockers (no production deploy until each is cleared)
1. Two Vercel projects on one repo (ambiguous deploy target).
2. Production alias != approved baseline SHA (`955954e` vs `bc464e6`).
3. No source-of-truth production branch (default `master` != deployed `feat/weekly-report-system`).
4. Dirty-tree deploys (`gitDirty=1`).
5. Vercel env not verified (the two projects may carry different Firebase/AI env).
6. Production Firebase rules + poison-alias not verified.

## 6. Safe cleanup plan (PROPOSED - no action taken)
1. Bucket the 126 changed files (app vs tooling vs generated vs artifacts vs secret-risk); add `.gitignore` rules for `reports/`, logs, screenshots, scratch.
2. Choose ONE source-of-truth branch built from `baseline-v1` + reviewed good work; protect it on GitHub.
3. Keep ONE Vercel project (`inventory`); disconnect the duplicate `smart-inventory-scanner` project's Git auto-deploy (after confirming the live one). Retire its stale alias.
4. Confirm prod Firebase project via Vercel env; keep local on the emulator.
5. Locate then targeted-clean the `078742051451` poison alias (separate, approved step).
6. Extend the release-hygiene agent (Phase 5) and require the deploy-confirmation block.

## 7. What NOT to touch yet
Production deployments; Firestore data; the duplicate Vercel project; branch/worktree deletions; API key rotation; the dirty working tree.

## 8. Recommended source-of-truth setup
- **One branch** = `production` (or `master`) = `baseline-v1` + reviewed work; branch-protected.
- **One Vercel project** = `inventory` (owner's live URL); retire `smart-inventory-scanner` auto-deploy.
- **One prod Firebase project** = `smart-inventory-scanner-app`; local stays on the `demo-` emulator.
- Tag every blessed release; deploy ONLY from the protected branch with explicit SHA confirmation.

## 9. release-hygiene agent (Phase 5) - EXTEND the existing one (do not duplicate)
Exists: `.claude/agents/release-hygiene.md` + `scripts/release-hygiene.mjs`. Currently checks uncommitted/unpushed/undeployed + prod-behind-local SHA. **Add these deploy-safety checks:**
- multiple Vercel projects pointing at the same repo (blocker)
- production alias vs approved/baseline SHA mismatch (blocker)
- `gitDirty=1` deployment detection (blocker)
- default-branch vs deployed-branch mismatch
- Firebase prod-project mismatch (local `.firebaserc` vs Vercel `NEXT_PUBLIC_FIREBASE_PROJECT_ID`)
- Firestore rules drift (local `firestore.rules` vs deployed)
- branch-sprawl / worktree count + local-only branches that have been deployed (e.g. `tire-barcode-db`)
- generated/report/screenshot files staged; secret-risk files staged
- deploy requested without exact SHA confirmation
Mandatory pre-deploy block (owner must type `DEPLOY THIS SHA`): Project / Alias / Branch / Commit SHA / Commit title / Diff-from-baseline / Files changed / App-behavior changes / Firebase project / Vercel project / Known risks / Rollback target. Add to lean + deep modes.

## 10. Exact owner decisions needed
- **GAP 1 - Vercel env:** authorize installing the Vercel CLI (`npm i -g vercel`) so you can `vercel login`, letting me read env var **names** (masked) to confirm the prod Firebase project + detect drift between the two Vercel projects? (Or skip; I mark it uninspected.)
- **GAP 2 - Production Firebase:** authorize pointing the Firebase CLI at `smart-inventory-scanner-app` (read-only; I switch back) to list prod collections, read deployed rules, and locate the `078742051451` poison alias?
- **Source-of-truth:** confirm `inventory` (Vercel) + a single protected production branch as the canonical setup so the repair targets the right place.

(No changes will be made until you approve the exact next step. Production remains frozen.)
