# Inventory - Local Repair Plan (baseline-v1 + reviewed good work)

Owner decisions locked: **1B** (fresh clean branch from `baseline-v1`) + **2B** (safe/local only).
Mode: LOCAL ONLY. No push, deploy, merge, branch delete, worktree removal, Vercel/Firebase/GitHub change.
All gated actions below are PROPOSED and wait for explicit approval. Inspect the candidate first.

---

## A. Candidate status (built locally, ready to inspect)

- **Worktree:** `C:\tmp\inventory-release-repair`
- **Branch:** `repair/baseline-v1-plus-reviewed-good-work`
- **Base:** `baseline-v1` = `bc464e6` (Master Baseline v1)
- **Reintroduced (safe, no app behavior) - cherry-picked clean:**
  - `ed0ae49` weekly-report system (internal tooling)  [from 2791bc4]
  - `b6af292` Ops/strategy agent fleet + release-hygiene agent (internal)  [from f0424b9]
  - `1013fb9` prod Firebase banner = dev-only (UI fix)  [from 955954e]
  - `b884479` accuracy test-set expansion (fixtures)  [from b9dea2a]
- **Deferred (conflict, folded into gitignore work):** `4cea140` (secret-leak untrack) - conflicted only on `.gitignore`; its real intent (stop tracking `playwright-results.json` leak class) is covered by section D.
- **HELD for a later verify-with-proof pass (touch resolution / route / decode):**
  - `827e398` retail catalog into resolution (app=2)
  - `6937cf3` AI-route spend cap + rate limit + kill switch (route=1, app=2) - wallet protection, but route behavior
  - `03e0791` evidence-weighted prefix firewall (app=9)
  - `3e02c8f` self-learning flywheel + reverse-UPC (app=6, route=1)
  - uncommitted Phase-1 shop reverse-UPC guard (in main tree, backed up)
- Main repo untouched (still `feat/weekly-report-system`, dirty work preserved + backed up 3 ways).

---

## B. Source-of-truth plan (the target end-state)

| Layer | Today (messy) | Target (one source of truth) |
|---|---|---|
| Production branch | `master` (stale) != deployed `feat/weekly-report-system` | **`master`** = promoted from `repair/baseline-v1-plus-reviewed-good-work`, **branch-protected** |
| Baselines | local-only `tire-barcode-db`, not on GitHub | tag **`baseline-v1`** (+ future `release-*` tags), pushed |
| Vercel project | TWO (`inventory` + `smart-inventory-scanner`) auto-deploy same repo | **ONE** (`inventory`), Production Branch pinned = `master`; duplicate's auto-deploy disconnected |
| Vercel env | Production-only (no Preview/Dev); legacy `SUPABASE_*`, `FIRECRAWL_*` | Production-only is fine; prune legacy vars later |
| Firebase | local emulator (`demo-smart-inventory`) vs prod (`smart-inventory-scanner-app`) | unchanged (correct by design); document it |
| Deploy | CLI from dirty tree, `gitDirty=1`, any branch | only from protected `master`, clean tree, behind the deploy gate (section E) |

Promotion path (later, gated): finish reviewed reintroduction on the repair branch -> fast-forward/merge it into `master` -> push -> protect -> pin Vercel -> retire duplicate.

---

## C. Branch + worktree cleanup plan (BACKUP-FIRST, all gated)

**Keep:** `repair/baseline-v1-plus-reviewed-good-work` (-> becomes `master`), `feat/weekly-report-system` (until fully superseded - holds the HELD commits + Phase-1 work), tag `baseline-v1`, all `backup/*` refs.

**Archive then delete (tag `archive/<name>` first, never lose history):**
`decode/prefix-anchored-fast`, `decoder-hardening-v1-local`, `fix/exact-code-evidence-verification`, `fix/decode-fast-recall-8s`, `fix/vercel-build-and-always-on-ai`, `fix/live-scan-active-catalog`, `fix/live-cloud-scan-resolution`, `deploy/firebase-admin-env-vercel`, `demo-readiness-vercel-partnumber`, `coordinator/customer-safe-demo-review`, `p0-platform-customer-security-audit`, `strategy-bots-track2`, `qa-agent-army-track1`, `qa-human-bots`, `benchmark-tire-db-automation`, `firebase-cloud-phase2`, `firebase-foundation`, `hotfix-multicode-tire-resolution`, `worktree-agent-*`.

**Open PRs to close/repoint after promotion:** #6 (decoder-hardening), #3 (benchmark) - both target the old `master`.

**Worktrees to remove (after confirming no unique uncommitted work; all backed up):**
`C:\tmp\inventory-coordinator` (master), `C:\tmp\inventory-demo` (demo-readiness), `C:\Users\djsan\inventory\.claude\worktrees\agent-*`, `/tmp/inv-clean` (detached, locked). Keep the main worktree + `inventory-release-repair`.

**`tire-barcode-db` (local-only baseline lineage):** preserve - it is already captured by tag `baseline-v1` + the backups; safe to delete after promotion.

---

## D. `.gitignore` draft (DRAFT - not applied; decide the tradeoff)

Currently TRACKED generated/churn files (the "126 dirty files" noise): **reports/ = 61**, **e2e/proof/ = 90**, **images = 103**. These regenerate on every test/bot run, so they show as endless diffs and bury real changes.

Proposed additions to `.gitignore` (on top of the baseline's good secret rules):
```gitignore
# --- generated reports / bot output (regenerated; do not track) ---
/reports/agent-bots/
/reports/human-bots/
/reports/product-intel/
/reports/account-audit/        # planning/audit docs are local-only by default
/reports/**/playwright-report/
**/playwright-results.json
**/cloud-playwright-results.json

# --- e2e proof screenshots (regenerated each run) ---
/e2e/proof/

# --- scratch / tool session artifacts ---
/.playwright-mcp/
*.log
/scratchpad/
```
Then UNTRACK without deleting on disk (one command, gated):
```
git rm -r --cached reports/agent-bots reports/human-bots reports/product-intel e2e/proof
```
**Tradeoff to decide:** tracking proof screenshots gives visual history but creates constant churn. Recommendation: **untrack** them (proof is reproducible by re-running the bots) - this alone kills most of the Source-Control noise. Also realizes `4cea140`'s security intent (the leaked `playwright-results.json` class stays ignored).

---

## E. Release-hygiene extension (prevent the wrong-deploy class)

The agent already exists in the candidate: `.claude/agents/release-hygiene.md` + `scripts/release-hygiene.mjs` (it checks uncommitted/unpushed/undeployed + prod-behind-local). **Add these deploy-safety checks** (spec; implement after approval):

- multiple Vercel projects pointing at the same repo  -> **blocker**
- production alias SHA != approved/`baseline`/protected-branch SHA  -> **blocker**
- `gitDirty=1` on the latest production deployment  -> **blocker**
- default-branch != protected production branch
- Firebase prod-project mismatch (local `.firebaserc` vs Vercel `NEXT_PUBLIC_FIREBASE_PROJECT_ID`)
- deployed Firestore rules drift vs repo `firestore.rules`
- worktree count + local-only branches that have been deployed (e.g. `tire-barcode-db`)
- staged generated/report/screenshot or secret-risk files
- deploy requested without an exact SHA confirmation

**Mandatory pre-deploy gate** (owner must type `DEPLOY THIS SHA`):
```
Production deploy candidate:
  Project / Alias / Branch / Commit SHA / Commit title /
  Diff from baseline / Files changed / App-behavior changes /
  Firebase project / Vercel project / Known risks / Rollback target
```
Add to both lean + deep weekly-report modes.

---

## F. Gated actions awaiting your approval (NONE done yet)

1. Apply section D (`.gitignore` + untrack) on the candidate.
2. Reintroduce HELD commits (`827e398`, `6937cf3`, `03e0791`, `3e02c8f`) with local proof (build + tests + targeted scan checks) before each.
3. Implement the release-hygiene extension (section E) in the candidate.
4. Promote candidate -> `master`; push; branch-protect (GitHub).
5. Pin `inventory` Vercel Production Branch = `master`; disconnect `smart-inventory-scanner` auto-deploy (Vercel).
6. Archive + delete stale branches; remove stale worktrees (after no-unique-work check).
7. Separately: clean the `078742051451` poison (alias `alias-41430cb3...` + product `prod-c2aef649...`) in prod Firestore.

Nothing in F happens without your explicit go, one step at a time.
