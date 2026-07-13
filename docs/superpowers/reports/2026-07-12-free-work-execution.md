# Execution Report - free-work plan (2026-07-12)

## Task 0.2 - proof baseline

Branch: `feat/decode-ladder-goupc`. Purpose: baseline proof gate run BEFORE an
authorized push (push itself is Task 0.3, out of scope here). No live API env
vars were set; no `vercel` or `git push` commands were run.

### Step 1: `npx playwright install chromium`
- Command: `npx playwright install chromium`
- Result: completed with no output (chromium already installed; idempotent no-op).
- Exit code: 0

### Step 2a: `npm run proof:full` (tsc --noEmit && vitest run && next build)
- Command: `npm run proof:full`
- tsc --noEmit: no `error TS` lines in output - clean.
- vitest run: `Test Files  186 passed | 7 skipped (193)` / `Tests  1723 passed | 30 skipped (1753)`
  - Duration 18.20s (transform 37.74s, setup 15.16s, import 125.62s, tests 30.30s, environment 126.29s)
- next build (Turbopack, Next.js 16.2.9): `✓ Compiled successfully in 5.7s`, TypeScript check
  finished, static pages generated (11/11), route manifest printed for `/`, `/_not-found`,
  `/api/ai-lookup`, `/api/resolve-scan`, `/business`, `/login`, `/products`, `/review`,
  `/scan`, `/settings`. One benign Turbopack warning about NFT tracing on
  `src/server/decodeCacheStore.ts` (dynamic require pattern) - informational only, build
  did not fail.
- Exit code: 0
- Full log: `C:\tmp\proof-logs\proof-full.log`

### Step 2b: `npm run test:e2e` (Playwright E2E)
- Command: `npm run test:e2e`
- Result: `31 passed (1.5m)` - all 31 chromium E2E specs green (goupc ladder, gpt burst,
  identifier backfill, phase1 benchmark, polish filter, product purge, resolver,
  scan-category, scan, scanner-focus, suggested-decode, suggested-label, tire-fields,
  verified-decode-not-unknown, etc). `/api/ai-lookup` calls in the log are the mocked
  route (webServer runs with `IS_E2E=1`, per project convention) - no live provider calls.
- Exit code: 0
- Full log: `C:\tmp\proof-logs\e2e.log`

### Step 2c: `npm run qa:bots` (playwright --config=playwright.bots.config.ts)
- Command: `npm run qa:bots`
- Result: `12 passed (21.8s)` - all human-bot QA scenarios green: CustomerCleanNamesBot,
  CustomerReadableControlsBot, CustomerReviewPersistenceBot, CustomerSettingsPlainBot,
  DataIntegrityBot, ExportBot, ManagerBot, PartNumberBot, PerformanceBot,
  PlatformOwnerBot (Falken/Camel resolution), SecurityLeakBot, ConfusedHumanBot.
- Exit code: 0
- Full log: `C:\tmp\proof-logs\qa-bots.log`

### Known-flake check: `src/stores/cloudDrainRace.store.test.ts`
- Did NOT fail in the full parallel `proof:full` vitest run (0 failures overall in that run).
- Ran in isolation anyway as a sanity check: `npx vitest run src/stores/cloudDrainRace.store.test.ts`
  -> `Test Files  1 passed (1)` / `Tests  1 passed (1)`, exit code 0.
- Conclusion: flake did not manifest this run. No repair loop needed, no regression.

### Gate summary
| Gate | Result | Exit code |
|---|---|---|
| tsc --noEmit | clean, 0 errors | 0 (part of proof:full) |
| vitest run | 1723 passed / 30 skipped (193 files: 186 passed / 7 skipped) | 0 (part of proof:full) |
| next build | Compiled successfully, 11/11 static pages | 0 (part of proof:full) |
| `npm run proof:full` overall | pass | 0 |
| `npm run test:e2e` | 31/31 passed | 0 |
| `npm run qa:bots` | 12/12 passed | 0 |
| cloudDrainRace isolated | 1/1 passed | 0 |

All gates green. Proceeded to Step 3 (renormalize).

### Step 3: renormalize under restored .gitattributes
- `git add --renormalize .`
- `git status --porcelain` after renormalize: **zero files changed** by the renormalize
  itself (see full status output below for the pre-existing untracked/modified files,
  which are unrelated to line-ending renormalization and were present before this task
  started). This means `.gitattributes` (restored in Task 0.1, commit 9447069) was
  already applied cleanly - no working-tree content needed re-normalizing.
- Per the brief's explicit instruction: zero files changed is a valid, non-blocking
  outcome. **Commit was skipped** - nothing to commit for renormalization.
- LFS pointer sanity check (run anyway per instructions):
  - `git ls-files -s src/server/retail-knowledge/retailKnowledge.generated.json`
  - `git cat-file -s <blob-sha>`
  - See exact output below.
- Step 3f: reran `npm run test` (plain vitest) after confirming nothing to commit, to
  reconfirm baseline. Result and exit code recorded below.

### Step 3 exact outputs

`git add --renormalize .` produced no console output.

`git status --porcelain` immediately after renormalize showed exactly the same 3
pre-existing modified files that were ALREADY modified before this task began (visible
in the environment's initial git status snapshot: `.claude/settings.local.json`,
`.superpowers/sdd/task-3-report.md`, `.superpowers/sdd/task-6-report.md`), plus the same
pre-existing untracked files (`.serena/`, `mockups/`, various `scripts/tmp-*`, PNG
screenshots, plan docs). Renormalize added **zero new files** to the changed set.

Verified these 3 pre-existing `M` files are genuine content edits, not line-ending
artifacts, by inspecting `git diff --cached`:
- `.claude/settings.local.json`: `git diff --cached --stat` -> `3 +-` (added
  `"outputStyle": "Proactive"` key) - real content change, unrelated to line endings.
- `.superpowers/sdd/task-3-report.md`: `281 ++++++++++++--------------------------`
  (rewritten report body) - real content change.
- `.superpowers/sdd/task-6-report.md`: `236 ++++++++++++++------------------` (rewritten
  report body) - real content change.

**Conclusion: renormalize resulted in ZERO files changed by line-ending normalization
itself.** This confirms `.gitattributes` (`* text=auto eol=lf` + LFS rule, restored in
Task 0.1 commit 9447069) was already applied cleanly to the working tree - nothing left
to renormalize. Per the brief's explicit instruction for this outcome: **commit was
skipped** (nothing to commit for renormalization). Ran `git reset` to unstage the 3
pre-existing files (they are unrelated prior work, not part of this task's scope, and
were not asked to be committed here) - working tree returned to its exact pre-task state.

LFS pointer sanity check (run regardless, per instructions):
```
$ git ls-files -s src/server/retail-knowledge/retailKnowledge.generated.json
100644 f93aa669d595d6636870215c2a2094140d9591e3 0	src/server/retail-knowledge/retailKnowledge.generated.json

$ git cat-file -s f93aa669d595d6636870215c2a2094140d9591e3
134
```
Blob size = **134 bytes** - well under the 200-byte threshold for a genuine LFS pointer
file. The 247MB tire knowledge file is correctly represented as an LFS pointer, not real
content, in the current git state. Safety gate PASSED.

### Step 3f: `npm run test` recheck
- Command: `npm run test`
- Result: `Test Files  186 passed | 7 skipped (193)` / `Tests  1723 passed | 30 skipped (1753)`
  - Duration 14.43s - identical pass/skip counts to the Step 2a run, confirming the
    renormalize investigation (add + reset, no commit) broke nothing.
- Exit code: 0
- Full log: `C:\tmp\proof-logs\test-recheck.log`

## Final gate summary (Task 0.2)

| Gate | Command | Result | Exit code |
|---|---|---|---|
| chromium install | `npx playwright install chromium` | idempotent no-op | 0 |
| tsc + vitest + build | `npm run proof:full` | tsc clean; vitest 1723/1753 passed (30 skipped); build compiled successfully, 11/11 static pages | 0 |
| E2E | `npm run test:e2e` | 31/31 passed (1.5m) | 0 |
| QA bots | `npm run qa:bots` | 12/12 passed (21.8s) | 0 |
| cloudDrainRace isolated | `npx vitest run src/stores/cloudDrainRace.store.test.ts` | 1/1 passed (did not flake in full run either) | 0 |
| renormalize | `git add --renormalize .` | 0 files changed by renormalization; commit skipped per brief | n/a |
| LFS pointer check | `git cat-file -s <blob-sha>` | 134 bytes (pointer, not real content) | 0 |
| test recheck | `npm run test` | 1723/1753 passed (30 skipped), identical to baseline | 0 |

**All gates green. No repair loop was needed - no real regressions encountered.**
No push, no vercel command, no live API env vars were used at any point in this task.

## Task 0.3 - tags + authorized push

Owner-authorized 2026-07-12: push `feat/decode-ladder-goupc` to origin, PUSH ONLY. No merge,
no PR, no push to master, no `vercel` commands were run.

### Step 1: commit stragglers
- Command: `git add docs/BACKLOG.md docs/superpowers/plans/2026-07-09-decode-ux-fixes.md docs/superpowers/plans/2026-07-10-size-merge-brand-family-fix.md docs/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md`
  then `git add docs/superpowers/reports/` (this execution report + task reports directory,
  untracked) then `git commit`.
- `.superpowers/` was checked with `git check-ignore -v .superpowers/sdd/task-3-report.md` ->
  exit 1 (NOT gitignored, it is tracked). `task-3-report.md` and `task-6-report.md` were already
  tracked with local modifications (not untracked stragglers), and `git ls-files --others
  --exclude-standard .superpowers/` returned empty, so there were no untracked files under
  `.superpowers/` to add. Left those two pre-existing modified files out of scope for this task
  (not part of the four named files or the reports directory).
- Result: commit `4f0762739d46a0e295765d2e55030ef6accf7914` "docs: backlog + retained plan docs
  (2026-07-12 audit)" - 5 files changed, 1493 insertions(+): `docs/BACKLOG.md`,
  `docs/superpowers/plans/2026-07-09-decode-ux-fixes.md`,
  `docs/superpowers/plans/2026-07-10-size-merge-brand-family-fix.md`,
  `docs/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md`,
  `docs/superpowers/reports/2026-07-12-free-work-execution.md`.
- Exit code: 0

### Step 2: safety tags on every local branch tip
- Command (Git Bash equivalent, used instead of the PowerShell one-liner):
  `for b in $(git for-each-ref --format="%(refname:short)" refs/heads); do git tag "bkp/2026-07-12/${b//\//-}" "$b"; done`
- 20 local branches tagged (`git branch --format="%(refname:short)" | wc -l` = 20, one more than
  the ~19 estimate in the brief): `backup/pre-repair-20260628-2054`,
  `benchmark-tire-db-automation`, `decoder-hardening-v1-local`, `demo-readiness-vercel-partnumber`,
  `feat/decode-ladder-goupc`, `feat/option-b-dryrun`, `feat/reverse-upc-heads-up`,
  `feat/weekly-report-system`, `fix/corpus-lookup-vercel`, `fix/count-decouple-breaker`,
  `fix/exact-code-evidence-verification`, `fix/grounding-ladder`, `fix/verified-suggested-model`,
  `integration/decode-restoration`, `master`, `repair/baseline-v1-plus-reviewed-good-work`,
  `review/comprehensive-ux-sprint`, `strategy-bots-track2`, `test`, `test-fixes`.
- Verify: `git tag -l "bkp/2026-07-12/*" | wc -l` -> 20. All present, all point at their branch's
  current tip commit.
- Exit code: 0

### Step 3: push branch + tags
- Command: `git push origin feat/decode-ladder-goupc --tags` (10-minute timeout given, per the
  67.8 MB tire-knowledge blob + 247 MB-class LFS object noted in the task).
- Result: `[new branch] feat/decode-ladder-goupc -> feat/decode-ladder-goupc`, plus 21 new tags
  (`baseline-v1` - pre-existing tag pushed for the first time - and all 20
  `bkp/2026-07-12/*` tags). GitHub printed an informational warning: `src/server/tire-knowledge/tireKnowledge.generated.json is 67.75 MB; this is larger than
  GitHub's recommended maximum file size of 50.00 MB` (non-blocking, push still succeeded; this
  file is a plain tracked blob, not LFS).
- No LFS upload lines appeared in this push's output (the git-lfs pre-push hook did not report
  transfer activity here), so LFS transfer was verified explicitly as a follow-up:
  `git lfs push origin feat/decode-ladder-goupc --all` -> `Uploading LFS objects: 100% (2/2),
  391 MB | 0 B/s, done.` A subsequent `git lfs push --all --dry-run` confirmed no LFS objects
  remained pending (all 3 tracked LFS pointers, including `.gitkeep`, already server-side).
  LFS-tracked file per `.gitattributes`: `src/server/retail-knowledge/retailKnowledge.generated.json`
  (`git lfs ls-files -l` shows the object oid `1f1744c3f3...`). Total LFS bytes uploaded this run:
  391 MB (well under GitHub's free 1 GB/month LFS bandwidth quota for a single push, but worth
  tracking against the monthly quota going forward).
- Exit code: 0

### Step 4: verify remote
- Command: `git ls-remote origin feat/decode-ladder-goupc`
- Result: `4f0762739d46a0e295765d2e55030ef6accf7914	refs/heads/feat/decode-ladder-goupc`
- Local HEAD (`git rev-parse HEAD` before push): `4f0762739d46a0e295765d2e55030ef6accf7914`.
- **Match: YES.** Remote branch tip equals local HEAD exactly.

### Summary
Branch and 21 tags (20 new `bkp/2026-07-12/*` + first-time push of pre-existing `baseline-v1`)
are now on `origin`. This is the first push of `feat/decode-ladder-goupc` (~167 commits ahead of
`master` after this task's commit). A Vercel preview deploy may auto-trigger from this push per
the task brief - expected, not production, not initiated by this task. No merge, no PR, no push
to master, no `vercel` command was run.

## Task 1.1 - untrack reports/ (gitignored QA artifacts, files kept on disk)

Branch: `feat/decode-ladder-goupc`. Purpose: untrack 37 files under `reports/` directory that
were committed before the `.gitignore /reports/` rule existed. Files retained on disk per
archive-only policy. No files deleted. No push performed.

### Step 1: `git rm -r --cached reports/`
- Command: `git rm -r --cached reports/`
- Result: removed 37 files from git index (not from disk).
- Output snippet: `rm 'reports/account-audit/gold-preservation-analysis.md'` ... (37 lines total)
- Exit code: 0

### Step 2: verification
- `git status --porcelain reports/ | head -10`: All 37 entries are `D` (deleted in index), not
  `M` (modified). Sample shown below confirms format.
- `ls reports/ | head -3`: Output shows `account-audit`, `agent-bots`, `ai-decode-review-pack-2026-07-04`
  - files still present on disk (not deleted).
- `git check-ignore reports/agent-bots -q; echo $?`: Exit code 0 confirms `.gitignore` rule
  covers `reports/` directory.

### Step 3: append Task 1.1 section to shared execution report
- File: `docs/superpowers/reports/2026-07-12-free-work-execution.md` (already tracked, modified in this task).
- Added this section to document the task execution and exact commands run.
- No separate commit for the report edit; it will be included in the main commit.

### Step 4: commit
- Command: `git commit -m "chore(repo): untrack reports/ (gitignored QA artifacts, files kept on disk)" --end-with-co-author`
- Files staged: `.superpowers/sdd/task-1.1-report.md` (new report file) + `docs/superpowers/reports/2026-07-12-free-work-execution.md` (modified execution report).
- Commit message includes: standard chore prefix, description of the action, reason, and exact co-author trailer.
- Exit code: 0

### Verification summary
| Check | Result | Evidence |
|---|---|---|
| Files untracked (index only) | PASS | `git status --porcelain reports/` shows 37 `D` entries |
| Files on disk | PASS | `ls reports/` lists 3 directories present |
| gitignore rule active | PASS | `git check-ignore reports/agent-bots -q` returns exit code 0 |
| No files deleted | PASS | ls / archive-only policy honored |
| Commit created | PASS | SHA recorded below |
| Push performed | NO | Per task brief: "Do NOT push" |

**All gates green. Task complete.**

## Task 1.2 - root artifact sweep

Branch: `feat/decode-ladder-goupc`. Purpose: clear proof-screenshot and report clutter out of
the repo root (archive-only, nothing deleted from disk), untrack runtime AI-cap counter JSONs,
extend `.gitignore` for root-level PNGs and the firestore emulator log, and relocate untracked
stray files. No files deleted. No push performed.

### Step 1: `git mv` tracked root artifacts into `docs/archive/proof-images/`
- Created `docs/archive/proof-images/` and `docs/archive/strays/`.
- `git mv` on all 11 tracked root `*.png` files (confirmed via `git ls-files '*.png' | grep -v '/'`
  so tracked PNGs living in `deploy-proof/` and `proof-archive/` subfolders were correctly left
  alone): `candidate-local-scan-healthy.png`, `cleanup-review-report-rendered.png`,
  `multi-scan-decode-count-proof.png`, `phase1-x004-suggestion-on-scan-row.png`,
  `phase2-full-matrix-water-nutella-x004.png`, `phase2-x004-provisional-count-qty2.png`,
  `post-fix-water-nutella-autocount.png`, `runtime-matrix-5-codes.png`,
  `water-code-shows-velvet-torch-poison.png`, `water-decoded-and-counted.png`,
  `x004-decoded-suggestion-in-review.png`.
- `git mv` on the 4 other tracked root artifacts: `cleanup-review-report.html`,
  `cleanup-review-summary.json`, `competitor-analysis.html`, `LIVE_SMOKE_OUTPUT.txt`.
- Plain `mv` (untracked, verified individually with `git ls-files <name>` returning empty first)
  on 6 untracked root PNGs into the same archive folder: `owner-100-ui-feed-final.png`,
  `owner-100-ui-review-page.png`, `owner-preview-stale-state-429.png`,
  `preview-scan-proof-final.png`, `preview-scan-proof.png`, `review-page-no-barcode.png`.
- Created `docs/archive/proof-images/README.md` (what these are, June-July 2026 proof
  screenshots + generated reports, moved 2026-07-12, safe to delete on owner order).

### Step 2: untrack runtime AI-cap counters
- Command: `git rm --cached .ai-lookup-usage.json .gpt-ladder-usage.json`
- Result: `fatal: pathspec '.ai-lookup-usage.json' did not match any files` - both files exist on
  disk but were never tracked in git (the `.gitignore` rule added them before they were ever
  committed). Confirmed with `git ls-files -c .ai-lookup-usage.json .gpt-ladder-usage.json`
  (empty output) and `git log --all --oneline -- .ai-lookup-usage.json .gpt-ladder-usage.json`
  (no history). No action needed; the "untrack" acceptance criterion is already satisfied.

### Step 3: extend `.gitignore`
- Appended to `.gitignore`: `/*.png` (root-scoped only) and `/firestore-debug.log`, under a new
  comment block dated for this task.
- Verified `/*.png` is root-scoped, not recursive: `touch test-root-ignore-check.png` then
  `git check-ignore -v test-root-ignore-check.png` -> matched `.gitignore:125:/*.png`. Then
  confirmed tracked subfolder PNGs are unaffected: `git check-ignore -v deploy-proof/01-scan.png`
  -> exit code 1 (not ignored, correctly still tracked). Removed the throwaway test file.
- `firestore-debug.log` was already covered indirectly by the pre-existing `*-debug.log` glob
  (line 49); the new `/firestore-debug.log` line is an explicit, root-scoped restatement per the
  brief. The file itself stays on disk at root (untracked, was already untracked, now ignored).

### Step 4: move untracked strays
- Plain `mv` (no `git mv` needed, untracked) of `auth` and `auth-wal` (both 0-byte Turso/SQLite
  WAL artifacts, already covered by a pre-existing `.gitignore` rule but still physically present
  at root) into `docs/archive/strays/`.
- Located the mangled scratchpad file with `ls -1 | grep -i gptladder` (its leading `C:` prefix
  contains a private-use-area glyph from a Windows path that doesn't round-trip through the
  shell) and moved it by capturing the exact byte-for-byte name via command substitution:
  `mv "$(ls -1 | grep -i gptladder)" docs/archive/strays/`. Verified removal from root
  (`ls -1 | grep -i gptladder` -> no match) and confirmed it was never tracked (`git ls-files |
  grep -i gptladder` only matches legitimate `src/` GPT-ladder source files, not this stray).

### Files explicitly left untouched (per brief)
`tire_prefixes_*.csv` (living data), `build-report-pdf.mjs` (living script), all `.md` files,
`firestore.rules`, `firebase.json`.

### Verification
| Check | Command | Result |
|---|---|---|
| No PNGs left at root | `ls *.png 2>/dev/null \| wc -l` | `0` |
| Renames recorded | `git status --porcelain \| grep -c "^R"` | `15` (11 PNGs + 4 other tracked files) |
| Runtime counters not tracked | `git ls-files .ai-lookup-usage.json .gpt-ladder-usage.json \| wc -l` | `0` |
| `.gitignore` lines present | `grep -n "^/\*\.png$\|^/firestore-debug.log$" .gitignore` | both present |
| Root-scoped ignore works | `git check-ignore -v test-root-ignore-check.png` | matched, then subfolder PNG confirmed NOT ignored |
| Strays moved | `ls docs/archive/strays/` | `auth`, `auth-wal`, mangled `...gptladder_base.ts` |

**All verification gates passed. Task complete.**

## Task 1.3 - scripts/ tmp sweep + README

Branch: `feat/decode-ladder-goupc`. Purpose: archive 78 one-off `scripts/tmp-*` probe/benchmark
artifacts into `scripts/archive-tmp-2026-07/` (archive-only, nothing deleted from disk), document
the living scripts in `scripts/README.md`, and gitignore the archive directory for its untracked
majority. No files deleted. No push performed.

### Step 1: identify tracked vs untracked tmp-* files
- `ls scripts/tmp-* 2>/dev/null | wc -l` -> 78 total.
- `git ls-files scripts/tmp-*` -> 7 tracked: `tmp-dryrun-sample-retail.mjs`,
  `tmp-dryrun-sample-tires.mjs`, `tmp-ladder-dryrun-results.json`, `tmp-ladder-dryrun.mts`,
  `tmp-ladder-dt-report-pdf.py`, `tmp-ladder-grade.mjs`, `tmp-ladder-log-reconstruct.mjs`.
- Remaining 71 files were untracked.

### Step 2: archive
- `mkdir scripts/archive-tmp-2026-07`.
- `git mv` each of the 7 tracked files into the archive dir (staged as `R`, renames preserved).
- Plain `mv` on the remaining 71 untracked files into the same archive dir.
- Verify: `ls scripts/tmp-* 2>/dev/null | wc -l` -> `0`. `ls scripts/archive-tmp-2026-07/ | wc -l`
  -> `78` (7 tracked + 71 untracked).

### Step 3: `scripts/README.md`
- Verified each of the 18 brief-listed living scripts/dirs exists before writing its line
  (`dev.mjs`, `build-knowledge-db.mjs`, `build-tire-knowledge.mjs`, `build-retail-knowledge.mjs`,
  `build-prefix-index.mjs`, `cloud-smoke.mjs`, `corpus-purge.mjs`, `eval-decode.ts`,
  `benchmark-decodes.ts`, `weekly-report.mjs`, `weekly-intel.mjs`, `release-sentinel.mjs`,
  `patch-jwks-rsa.cjs`, `email-report.mjs`, `create-god-account.mjs`,
  `backfill-missing-tires.mjs`, `barcode-harvester/`, `dt-harvest/`) - all 18 present, none
  omitted.
- Wrote one line per script summarizing its purpose (read from each file's header comment) plus
  a closing note that `archive-tmp-2026-07/` is frozen history, safe to delete on owner order.

### Step 4: `.gitignore`
- Added `scripts/archive-tmp-2026-07/` to `.gitignore`, appended AFTER the git mv's were already
  staged (git-mv'd files stay tracked regardless of a later-added ignore rule). Verified the 7
  renames remained staged as `R` and the 71 untracked archived files no longer show as `??` in
  `git status --porcelain`.

### Verification
| Check | Command | Result |
|---|---|---|
| No tmp-* left directly in scripts/ | `ls scripts/tmp-* 2>/dev/null \| wc -l` | `0` |
| All 78 archived | `ls scripts/archive-tmp-2026-07/ \| wc -l` | `78` |
| Tracked renames staged | `git status --porcelain scripts/archive-tmp-2026-07/ \| grep -c "^R "` | `7` |
| Living scripts verified present | manual `[ -f ]` / `[ -d ]` checks on all 18 brief items | all `OK` |
| README lines | one per living script + archive note | 18 script/dir lines + 1 archive section |
| Untracked archive files hidden by gitignore | `git status --porcelain` after ignore rule | no `??` entries under `archive-tmp-2026-07/` |

**All verification gates passed. Task complete.**

## Task 1.4 - doc truth fixes

Branch: `feat/decode-ladder-goupc`. Purpose: fix a stale claim in `CLAUDE.md` (Tech Stack said
Firebase was not wired; in reality `firebaseAdmin.ts`, emulator tests, and `qa:bots:live` cloud
checks already exist) and add a dated free-work-plan marker to `PROGRESS.md`. No code changed.

### Step 1: locate exact current wording
- Command: `Grep "Local mock data mode" CLAUDE.md` (content mode, `-C 2`).
- Found at line 28: `- Local mock data mode (no Firebase wired). Firebase Auth/Firestore is a
  documented future path.`

### Step 2: replace the line
- Replaced ONLY that line, no other restructuring of `CLAUDE.md`.
- Before:
  `- Local mock data mode (no Firebase wired). Firebase Auth/Firestore is a documented future path.`
- After:
  `- Local mock data mode is the default; Firebase Phase 2 IS wired (firebaseAdmin.ts, emulator
  tests via npm run test:firebase, qa:bots:live cloud checks) behind dev:emulator/dev:prod;
  production stays mock until the go-live gate.`
- No em dash or en dash used in the new text, per project convention.

### Step 3: `PROGRESS.md` dated marker
- Inserted a new `## 2026-07-12 free-work plan (in progress)` section directly under the file's
  header block (before `## Current phase`), per the "near the top" instruction.
- Content: Phase 0 done (LFS fix + first push of the branch, `git ls-remote` verified), Phase 1
  cleanup underway (reports/ untracked, root artifacts + 78 tmp scripts archived), Phases 2 and 3
  next (code health, then camera scan / free rungs / variance report / CSV import on separate
  branches).

### Step 4: this report section + commit
- Appended this section to the shared execution report before committing.
- Commit message: `docs: CLAUDE.md Firebase reality line + PROGRESS marker`.

### Verification
| Check | Result |
|---|---|
| Exact old line matched before editing | PASS (grepped, confirmed verbatim) |
| Only the one line replaced in CLAUDE.md | PASS (single Edit, no other changes) |
| No em dash or en dash in new text | PASS (manual check) |
| PROGRESS.md marker near top, correct heading | PASS |
| Report section added | PASS (this section) |

**Task complete.**

## Task 1.5 - branch + worktree hygiene

Branch: `feat/decode-ladder-goupc`. Purpose: remove stale worktrees under `C:/tmp` and delete
local branches already fully merged into `feat/decode-ladder-goupc`. Safety net: every local
branch tip already carries a `bkp/2026-07-12/<branch>` tag from Task 0.3. No remote branches
touched, no push, no prune.

### Step 0: safety-tag precheck
- Command: `git tag -l "bkp/2026-07-12/*" | wc -l`
- Result: `20` - matches the required count. Proceeded.

### Step 1: worktree removal (`git worktree remove <path>`, no `--force`)
| Worktree | Branch | Result |
|---|---|---|
| `C:/tmp/inv-decoder-hardening` | `decoder-hardening-v1-local` | Removed cleanly, exit 0 |
| `C:/tmp/inventory-demo` | `demo-readiness-vercel-partnumber` | Refused: `fatal: 'C:/tmp/inventory-demo' contains modified or untracked files, use --force to delete it` - left in place, not forced |
| `C:/tmp/inventory-release-repair` | `feat/reverse-upc-heads-up` | Refused: `fatal: 'C:/tmp/inventory-release-repair' contains modified or untracked files, use --force to delete it` - left in place, not forced |

Post-step `git worktree list`:
```
C:/Users/djsan/inventory        b8fbf00 [feat/decode-ladder-goupc]
C:/tmp/inventory-demo           58855df [demo-readiness-vercel-partnumber]
C:/tmp/inventory-release-repair 8dcb6b9 [feat/reverse-upc-heads-up]
```
1 of 3 worktrees removed. The other 2 are dirty (modified/untracked files) and were left exactly
as instructed - a dirty worktree is a report item, not something to force-delete.

### Step 2: branch deletion (`git branch -d`, merged-only)
- Command: `git branch --merged feat/decode-ladder-goupc | grep -v "feat/decode-ladder-goupc\|master\|benchmark-tire-db-automation"`
- 12 candidates identified, all deleted with `git branch -d` (lowercase only, never `-D`):

| Branch | Result |
|---|---|
| `backup/pre-repair-20260628-2054` | Deleted (was `b9dea2a`) |
| `decoder-hardening-v1-local` | Deleted (was `e5c2e16`) |
| `feat/option-b-dryrun` | Deleted (was `9dcb2e0`) |
| `feat/weekly-report-system` | Deleted (was `72a53f2`) |
| `fix/corpus-lookup-vercel` | Deleted (was `9b76aa5`) |
| `fix/count-decouple-breaker` | Deleted (was `12302a3`) |
| `fix/grounding-ladder` | Deleted (was `8e1700c`) |
| `fix/verified-suggested-model` | Deleted (was `599099c`) |
| `integration/decode-restoration` | Deleted (was `54d7e96`) |
| `repair/baseline-v1-plus-reviewed-good-work` | Deleted (was `24d1797`) |
| `review/comprehensive-ux-sprint` | Deleted (was `192bfa4`) |
| `test-fixes` | Deleted (was `e81d716`) |

All 12 deletions succeeded on the first `-d` attempt (each was genuinely merged into
`feat/decode-ladder-goupc`, so `-d`'s safety check never triggered a refusal). No remote
branches, no `git push`, no `origin` prune.

### Surviving branch list (`git branch` after)
```
  benchmark-tire-db-automation
+ demo-readiness-vercel-partnumber
* feat/decode-ladder-goupc
+ feat/reverse-upc-heads-up
  fix/exact-code-evidence-verification
  master
  strategy-bots-track2
  test
```
7 branches survive: `benchmark-tire-db-automation` (owner-parked, explicitly excluded),
`demo-readiness-vercel-partnumber` and `feat/reverse-upc-heads-up` (each still checked out by a
dirty worktree, marked `+`), `feat/decode-ladder-goupc` (current, `*`),
`fix/exact-code-evidence-verification`, `master`, `strategy-bots-track2`, `test` (none of these
last 4 are merged into `feat/decode-ladder-goupc`, so `--merged` correctly excluded them).

### Verification
| Check | Result |
|---|---|
| Safety-tag precheck (20 tags) | PASS |
| Worktrees removed without `--force` | 1/3 (2 legitimately refused, dirty, left in place) |
| Branch deletions used `-d` only, never `-D` | PASS (verified no `-D` invocation) |
| `benchmark-tire-db-automation` untouched | PASS (excluded from candidate list, still present) |
| `master` / current branch untouched | PASS |
| No remote branch deleted, no push, no prune | PASS (no such commands run) |

**Task complete. No commit needed for branch/worktree ops themselves; this report update is the only commit.**

## Task 2.1 - remove dead `autoAcceptVerifiedDecodes` setting

Branch: `feat/decode-ladder-goupc`. Purpose: delete the never-read `autoAcceptVerifiedDecodes`
settings field (declared in `src/types.ts`, defaulted in `src/stores/scanStore.ts`, but read by
no production code path) and its documentation caveats. The real auto-count gate,
`autoAddDecodedProducts`, was NOT touched.

### Step 1: safety grep before any edit
- Command: `grep -rn autoAcceptVerifiedDecodes` (full repo, then scoped to `src/`).
- Full-repo hits (8 files): `CLAUDE.md:106`, `DECISIONS.md:71`, `docs/DECODER_ARCHITECTURE.md:46`,
  `TESTING.md:154`, `src/types.ts:353`, `docs/BACKLOG.md:58`, `src/stores/scanStore.ts:367`,
  `docs/archive/PROGRESS_HISTORY_2026-06.md:317,351`, `docs/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md` (this task's own spec), `e2e/fixtures.ts:33`.
- Scoped `src/` grep: only 2 hits - `src/types.ts:353` (type declaration) and
  `src/stores/scanStore.ts:367` (default literal). No other production code reads or branches on
  the field. This matches the audit finding exactly; safe to proceed (no STOP condition hit).
- `e2e/fixtures.ts:33` was an additional hit beyond the brief's prediction (a duplicated settings
  object for generic-category E2E specs, deliberately not imported from `scanStore.ts` per its own
  header comment) - it mirrors `DEFAULT_SETTINGS` and needed the same key removed for consistency,
  not because any test asserts on it.

### Step 2: migrate-tolerance check (persisted localStorage safety)
- Read `scanStoreMigrate` in `src/stores/scanStore.ts` (persist `version: 6`, lines ~4442-4464).
- Both the `version < 5` branch and the current branch merge settings as
  `{ ...DEFAULT_SETTINGS, ...(p.settings ?? {}) }` - a plain object spread with no allowlist/schema
  validation.
- Finding: an old browser's persisted state that still contains
  `settings.autoAcceptVerifiedDecodes: true/false` will spread that key into the merged settings
  object as a harmless extra property. Nothing reads it (confirmed by the `src/` grep above), and
  once `Settings` (types.ts) no longer declares the field, no TypeScript code can accidentally
  consume it either. **Removing the field is safe for existing persisted browser state - no
  migration bump or extra handling required.**

### Step 3: code changes
- `src/types.ts`: removed the `autoAcceptVerifiedDecodes: boolean;` field + its comment block from
  the `Settings` interface (was line 353).
- `src/stores/scanStore.ts`: removed `autoAcceptVerifiedDecodes: false,` from `DEFAULT_SETTINGS`
  (was line 367). `autoAddDecodedProducts: true` (the real gate) left untouched, still present.
- `e2e/fixtures.ts`: removed the matching `autoAcceptVerifiedDecodes: false,` line from
  `GENERIC_SETTINGS` for consistency with the trimmed `DEFAULT_SETTINGS` shape.

### Step 4: test file check
- Grepped `src/services` and all of `src` for `autoAcceptVerifiedDecodes` (content mode) - zero
  hits beyond the type/default already removed. No unit test asserts on this field's default value
  or toggles it to observe behavior, so no test file needed re-pointing.

### Step 5: doc caveat updates
- `CLAUDE.md:106-107`: dropped the trailing `NOTE: autoAcceptVerifiedDecodes is declared ...
  currently UNUSED/dead` sentence from the Evidence Verification section.
- `docs/DECODER_ARCHITECTURE.md:46`: dropped the parenthetical `(autoAcceptVerifiedDecodes is
  declared but DEAD - it gates nothing; do not rely on it.)`.
- `DECISIONS.md:71-72`: removed the now-false "Auto-accept of verified decodes is a setting
  (autoAcceptVerifiedDecodes, default OFF)" bullet entirely (beyond the brief's named two files,
  but left in place it would describe a field that no longer exists - out of scope to leave a
  broken doc claim).
- `TESTING.md:154`: rewrote "verified auto-saves only when autoAcceptVerifiedDecodes on" to
  correctly describe the real gate: "verified decode auto-saves per `autoAddDecodedProducts`
  (default true)".
- `docs/BACKLOG.md:58`: checked off the "Remove dead code: autoAcceptVerifiedDecodes" TIER 2 item
  (`[ ]` -> `[x] ... - done 2026-07-12`), split from the still-open `decodeOrchestrator.ts` /
  `geminiProvider.ts` cleanup items in the same original bullet.
- `docs/archive/PROGRESS_HISTORY_2026-06.md` deliberately left untouched - it is a dated historical
  log of what was true in June 2026; rewriting it would falsify the archive record.
- The plan doc `docs/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md` (this
  task's own spec) also left untouched - it is the task definition, not living documentation.

### Gate results
| Gate | Command | Result | Exit code |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean, no output | 0 |
| Unit tests | `npm run test` | `Test Files 186 passed \| 7 skipped (193)` / `Tests 1723 passed \| 30 skipped (1753)` | 0 |

- `cloudDrainRace.store.test.ts` (known flake) did not trip in this run; included in the 1723
  passing tests, ran as part of the normal parallel suite (no isolated rerun needed since it did
  not fail).

### Final safety re-grep (post-edit)
- `grep -rn autoAcceptVerifiedDecodes` (full repo) after all edits: 3 remaining hits, all
  intentional - `docs/BACKLOG.md` (the completed `[x]` history line), the unmodified task-spec plan
  doc, and the unmodified `docs/archive/PROGRESS_HISTORY_2026-06.md` historical log. Zero hits in
  `src/`, `e2e/`, or any active/living doc.

**Task complete. All gates green. No STOP condition encountered.**

## Task 2.2

Deprecate legacy `src/services/ai/decodeOrchestrator.ts` (215 lines) - documentation-only, no
behavior change. Superseded by the decode ladder (`src/server/upc/ladder.ts`) + the route's
`computeDecode`.

### Import verification (grep, before editing)

`grep -rn decodeOrchestrator src` found 9 files (more than the brief's 4 known importers). Full
verdict per file:

| Importer | Import line | Verdict |
|---|---|---|
| `src/app/api/ai-lookup/route.ts` | `import { type ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only (inline `type` modifier) |
| `src/services/ai/decodeFallback.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only |
| `src/services/benchmark/benchmarkAnalysis.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only |
| `src/services/decode/index.ts` | `export { runDecode } from "@/services/ai/decodeOrchestrator";` + `export type { DecodeProvider, DecodeRunParams, DecodeRunResult, DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";` | **runtime symbol** - re-exports the `runDecode` function itself, not just its type, alongside a separate type-only export line |
| `src/services/decode/contract.ts` | `import type { DecodeEnrich, ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only (found beyond the brief's named 4) |
| `src/services/ai/decodeFallback.test.ts` | `import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";` | type-only (test file) |
| `src/services/ai/decodeOrchestrator.test.ts` | `import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";` | runtime symbol - expected, this is the module's own unit test |
| `src/services/ai/groundedSpecFinder.ts` | comment only (`// Mirrored from decodeOrchestrator.ts line 132...`) | not an import |
| `src/services/decode/README.md` | prose reference | not code |

Follow-up check: `grep -rn runDecode src` shows the `decode/index.ts` barrel's re-exported
`runDecode` has zero live (non-test) callers anywhere in `src` - only `decodeOrchestrator.test.ts`
calls `runDecode` directly. So the one runtime re-export exists but is currently unused dead
surface, not a hidden production dependency.

**Verdict: 3 of the 4 brief-named importers (route.ts, decodeFallback.ts, benchmarkAnalysis.ts)
are confirmed type-only, as the prior audit stated. The 4th brief-named importer,
`decode/index.ts`, is NOT type-only - it re-exports the `runDecode` runtime symbol (plus a
type-only export line). Per the brief's instruction, no behavior was changed; this is reported
instead.** One additional type-only importer beyond the brief's list was found
(`decode/contract.ts`).

### Change made

Added an `@deprecated` JSDoc block above the top-of-file comment in `decodeOrchestrator.ts`,
naming the ladder as the successor, listing which importers are type-only, and flagging that
`decode/index.ts`'s `runDecode` re-export has no live callers so no new callers should be added.
No renames, no moves, no deletion, no logic touched.

### Gate result

| Gate | Command | Result | Exit code |
|---|---|---|---|
| Unit tests | `npm run test` | `Test Files 186 passed \| 7 skipped (193)` / `Tests 1723 passed \| 30 skipped (1753)` | 0 |

**Task complete. All gates green. No STOP condition encountered.**

## Task 2.3

Characterization tests added for three previously untested high-risk `fetchV2`/`tire` modules.
Each file was read in full before writing tests; every assertion pins CURRENT behavior as found,
not desired behavior.

### Files created

| File | Tests | Focus |
|---|---|---|
| `src/services/fetchV2/scoring.test.ts` | 30 | `hostOf` normalization, `scoreSource` quality/score table for every tier x association-level combination, `decideOutcome` empty-findings/all-junk-rejected/blank-name/check-digit-invalid/non-public paths, the vetted-DB-host free-agreement-fence verify tier (`TRUSTED_DB_HOSTS`), the 3-host search-snippet consensus tier + its conflict-scan-runs-first ordering, snippet-only identity gating (label vs 2+ hosts), and `rulesFired` trace strings per mode |
| `src/services/fetchV2/siblingGuard.test.ts` | 22 | `identityRelation` on empty/whitespace/undefined-brand inputs, mixed tire-size notation equivalence (`/` vs `x` vs dash vs spaced vs glued ST/LT/P prefix vs Z-speed-rating vs decimal commercial rim), pack-size unit isolation (oz vs g never clash), brand-compatibility gate, and `detectSiblingAmbiguity`'s pairwise-poisons-the-set contract including the empty-list and blank-name-filter cases |
| `src/services/tire/tirePrefixHints.test.ts` | 14 | Table shape contract (every entry non-empty array of `{brand, weight, source?}`, digit-only keys), known-prefix -> brand/weight/source lookups, unknown-prefix -> `undefined` (direct property lookup, not the fuzzy `lookupTirePrefix` matcher already covered by `tirePrefixLookup.test.ts`), and ambiguous multi-brand prefixes never collapsing to a single winner |

Total: **66 new tests** across 3 new files. These are additive to (not a replacement for) the
existing indirect coverage in `engine.test.ts` (scoring/siblingGuard) and
`tirePrefixLookup.test.ts` (tirePrefixHints via the lookup layer) - overlap was deliberately
avoided by focusing each new file on paths the existing suites do not exercise.

### RED-check evidence (guard verified, not just written)

One assertion per file was temporarily inverted, run, observed to fail, then restored to the
original (proof-correct) value before commit:

1. `scoring.test.ts` - "authoritative tier + strong association scores 95" changed to expect
   `score: 99` -> failed with `expected 99, received 95` -> restored.
2. `siblingGuard.test.ts` - "different tire sizes on the same model => sibling" changed to expect
   `"agree"` -> failed with `expected 'agree', received 'sibling'` -> restored.
3. `tirePrefixHints.test.ts` - "unknown prefix is absent" changed to expect a fabricated hint
   array -> failed with `expected [...], received undefined` -> restored.

All three failed as expected, then all three passed again after restore (see gate table below).

### Behavior finding (odd but NOT changed - pinned as-is)

`scoreSource`'s host-trust fallback is more permissive than intuition suggests:
`classifySource()` (`src/services/catalog/sourceTrust.ts`) treats a completely **unrecognized**
host as Tier 3 "supporting" by explicit policy comment ("Unknown host: treat as Tier 3
(supporting), never authoritative"), NOT as the "weak" tier. Consequently
`scoreSource(url, strongAssociation, false)` for a random unknown domain
(`https://random-blog.example.net/post`) with a **strong** code-to-product association returns
`{ quality: "medium", score: 55 }` - the SAME quality/score as a known barcode-DB host like
go-upc.com. Only a junk-path or `?q=`-style query URL forces the "weak" tier for an unrecognized
host. This is pinned in `scoring.test.ts` as two paired tests: "an unrecognized host defaults to
supporting tier (never weak)" and "a junk-path URL on an unrecognized host IS weak tier". Flagging
for owner awareness - not fixed per characterization-test scope (no behavior changes authorized).

### Gate result

| Gate | Command | Result | Exit code |
|---|---|---|---|
| Target scope | `npx vitest run src/services/fetchV2 src/services/tire` | `Test Files 10 passed (10)` / `Tests 280 passed (280)` | 0 |
| Full unit suite | `npm run test` | `Test Files 189 passed \| 7 skipped (196)` / `Tests 1789 passed \| 30 skipped (1819)` | 0 |
| Typecheck | `npx tsc --noEmit` | No output (clean) | 0 |

**Task complete. All gates green. No STOP condition encountered.**


---

## Task 2.4 (OPUS): Extract decode pipeline from `app/api/ai-lookup/route.ts`

**Pure extraction, zero behavior change.** The decode pipeline (computeDecode, the ladder rung
runners, the daily-cap/breaker gating, and the L1/L2 cache write-through) was lifted out of the
route handler into a dedicated server module. The route is now a thin HTTP handler.

### Line counts
| File | Before | After |
|---|---|---|
| `src/app/api/ai-lookup/route.ts` | 1097 | 297 |
| `src/server/decode/pipeline.ts` (new) | - | 868 |
| `src/server/decode/pipeline.test.ts` (new) | - | 121 |

### What moved
- Moved to `pipeline.ts` and exported: `runDecodePipeline(req)` (the whole former inline `isDecodeMode`
  block - L1/L2 persisted-cache peek, free corpus/retail/Plan-D stages, the lazy daily-cap gate, the
  spec-v6 ladder Go-UPC -> Fetch V2 -> GPT-5.5, and the L2 write-through), `DailyCapExceededError`,
  `e2eMode`, plus `DecodePipelineRequest` / `DecodePayload` / `DecodePipelineResult` types.
- Moved to `pipeline.ts` (module-private): `evalCombinedFirewall`, `classifySourceTier` +
  `PAID_AI_PROVIDER_MARKERS`, `normalizeMockGptLadder`, `GEMINI_DECODE_DISABLED`, the Go-UPC gate +
  prefix-lookup singletons, the Fetch V2 cache/const/`fetchV2Page`/`fetchV2Discovery` wiring, and the
  `FETCHV2_*` env constants.
- `route.ts` keeps: request parsing + server-side sanitize, the abuse/kill-switch/rate-limit guards,
  the legacy-lookup daily-cap gate, `selectProvider`/`lookupChain`, the `lookup`-mode path, the whole
  GET status endpoint, and now delegates decode to `runDecodePipeline`, shaping its `{persisted |
  cap_blocked | computed}` result into the identical HTTP responses (persisted body / 429 daily_cap /
  200 with `cached` echoed into debug).
- `pipeline.ts` opens with `import "server-only"` (matches `src/server/upc/*`).

### Domain rules preserved verbatim
- Daily cap charged ONLY inside the paid rungs, once, AFTER the free corpus/cache peek (lazy cap gate).
- Ladder order + first-settled short-circuit; Go-UPC GTIN-gated in `buildLadderRungs`.
- `IS_E2E=1` forces mock-only; `GEMINI_DECODE_DISABLED` unchanged; honest reason chains for every
  non-decode (cap / miss chains).

### Import adjustments in existing tests
NONE. `route.test.ts` imports only `POST`/`GET` from the route (never the moved internals), so all 47
route tests pass UNCHANGED - zero assertion changes. This is the behavior lock, and it held.

### New tests (`pipeline.test.ts`, 2 thin unit tests)
- all-miss ladder -> `computed` payload, decision not verified, `debug.ladderReasons` names every rung
  (fetchv2 + gpt), no live AI contacted.
- cap-exhausted -> `cap_blocked` with an honest `/cap/i` message, counter not charged, no paid call.

### Gate results
| Gate | Command | Result | Exit |
|---|---|---|---|
| Baseline (behavior lock) | `npx vitest run src/app/api/ai-lookup` | `Test Files 2 passed (2)` / `Tests 47 passed (47)` (unchanged) | 0 |
| New pipeline tests | `npx vitest run src/server/decode/pipeline` | `Test Files 1 passed (1)` / `Tests 2 passed (2)` | 0 |
| Full unit suite | `npm run test` | `Test Files 190 passed \| 7 skipped (197)` / `Tests 1791 passed \| 30 skipped (1821)` | 0 |
| Typecheck | `npx tsc --noEmit` | No output (clean) | 0 |
| Build | `npm run build` | `Compiled successfully` / `/api/ai-lookup` (ƒ Dynamic) | 0 |

Note: `npm run lint` reports 24 pre-existing errors + 37 warnings across OTHER files (weekly-tire-scan,
decode.ts, etc.); ZERO are in `route.ts` or `pipeline.ts`. Lint is not a Task 2.4 gate; the specified
gates (baseline, full test, tsc, build) are all green.

**Task 2.4 complete. Pure extraction, all specified gates green.**

---

## Task 2.5 - Carve the pure auto-count gate out of scanStore.ts

Extracted the decode auto-count gate + high-trust suggestion auto-apply rule into pure functions in a new
`src/stores/scanGates.ts` (142 lines, no store/React imports). scanStore.ts imports and calls them; the
diff inside scanStore is call-site replacement only (4510 -> 4475 lines).

**Pure functions:**
- `canAutoCount(input): { allowed, reason }` - the old `evidenceGatePassed` Phase-7 conjunction, including
  the GPT-ladder trust tier and the T20/code-1225 public-barcode-shape firewall. Store computes `tireOk`
  and `contextConflict` (they need services) and passes the booleans in, keeping the function pure.
- `shouldAutoApplySuggestion(input)` - the old `autoSuggestApplyOk` rule (conf>=0.8 non-verified OR
  app-verified-exact "verified"; requires autoAddOn + usable name + no conflict).
- `decodeCorroborated` / `isPublicBarcodeShape` - moved out; scanStore re-exports `decodeCorroborated` so
  the existing `./scanStore` importer (scanStore.autocount.test.ts) is untouched.

**Call sites replaced:** `scanStore.ts` liveDecode (~:2168) and backgroundVerifyDeep (~:2768) both now call
`canAutoCount({...}).allowed`; `autoSuggestApplyOk` is now a thin wrapper delegating to
`shouldAutoApplySuggestion`. Both `autoSuggestApplyOk(...)` call sites are unchanged.

**New test:** `src/stores/scanGates.test.ts` (25 tests) ports the gate coverage to hit the pure functions
directly - all 4 decodeCorroborated cases, the 1225 firewall (gpt_self_report on vendor/SKU shapes
REFUSED), every refusal clause, and the suggestion trust firewall. Store integration tests unchanged.

**Gates:** `npx vitest run src/stores` 44 files/259 tests PASS (was 43/234); `npm run test` 191 files/1816
passed PASS; `npx tsc --noEmit` clean; `npm run qa:bots:data` 1 passed. Zero behavior change.

Full report: `.superpowers/sdd/task-2.5-report.md`.

## Merge train + full gates

Merged four reviewed, disjoint feature branches (all branched from `7213c20`) into
`feat/decode-ladder-goupc`, one at a time with `--no-ff`, then ran the full gate suite. No push.

### Merge sequence

| # | Branch | Merge SHA | Conflicts |
|---|---|---|---|
| 1 | `feat/free-rungs` | `70d8692` | None (clean merge) |
| 2 | `feat/camera-scan` | `5d48d0b` | None (clean merge); `npm install` for `barcode-detector@3.2.1` - lockfile already correct, no diff |
| 3 | `feat/variance-report` | `8a36a19` | `src/app/(app)/scan/page.tsx` auto-merged cleanly - both `CameraScanButton` and `VarianceReport` wiring present, additive as expected |
| 4 | `feat/csv-import` | `a341f2f` | `package.json` auto-merged cleanly (`barcode-detector` dependency + `csv-parse` dev->prod move both landed correctly); lockfile needed regeneration, committed separately as `a7ca019` |

Zero STOP-worthy conflicts: nothing in `src/services`, `src/server`, or `src/stores` conflicted:
`scanStore.ts` changes (variance-report) and the pipeline/ladder changes (free-rungs) sit in disjoint
regions and merged cleanly.

Per-merge verification (`npx tsc --noEmit` + targeted vitest of the merged feature's test files),
all clean:
- free-rungs: tsc clean, 74/74 targeted tests pass.
- camera-scan: tsc clean, 11/11 targeted tests pass.
- variance-report: tsc clean, 31/31 targeted tests pass (+80/80 broader `scanStore` suite as extra
  safety since `scanStore.ts` was touched).
- csv-import: tsc clean, 39/39 targeted tests pass.

### Full gates (after all four merges + lockfile regen)

**Gate 1 - `npm run proof:full`:** PASS both runs (before and after the fix commit below).
Final run: `tsc --noEmit` clean, vitest **1946/1946 passed, 30 skipped** (pre-existing skips,
unrelated to this merge), `next build` succeeded (Turbopack emits one pre-existing informational NFT
warning on `next.config.ts` -> `aiSpendGuard.ts`, unrelated to any of the four merges).

**Gate 2 - `npm run test:e2e`:** PASS, **34/34** (31 pre-existing specs + 3 new: `camera-scan.spec.ts`,
`variance-report.spec.ts`, `csv-import.spec.ts`). `camera-scan.spec.ts` passed without needing the
fake-media-stream Chromium flags mentioned as a fallback in the task brief - the spec already handles
the no-camera-permission path gracefully. Screenshot proof in `e2e/proof/`: `csv-import-01-preview.png`,
`csv-import-02-summary.png`, `variance-report.png` (plus the pre-existing 26 screenshots, all present).

Two of the three new specs had never been run before and needed spec-side fixes (no assertions
weakened, no app code touched for either):
1. `e2e/csv-import.spec.ts` used `fileURLToPath(import.meta.url)` to derive `__dirname`. Playwright
   compiles `.ts` specs as CommonJS in this project (no `"type": "module"` in `package.json`), so
   `import.meta` is undefined at load time and the loader threw `ReferenceError: require is not
   defined in ES module scope` on the very first import line. Fixed by using the native `__dirname`
   Playwright already provides in CJS-compiled specs (no other spec in the repo needed the ESM
   workaround).
2. `e2e/variance-report.spec.ts` assumed "Playwright auto-accepts `window.confirm` by default" (per
   its own comment) - this is false; Playwright **dismisses** dialogs by default unless
   `page.on("dialog", d => d.accept())` is registered, exactly as other specs in this repo already do
   (e.g. `e2e/delete-product.spec.ts`). Without the listener, the "remove Coca-Cola from the count"
   step silently no-opped, so the second snapshot's delta was wrong. Also switched the remove-button
   locator from `.getByTestId(/^remove-count-/).first()` (order-dependent - grabbed the Falken row,
   not Coca-Cola) to a row scoped by visible text. Fixed both; the spec now passes and its stale
   "not run in this task" header comment was corrected to reflect that it now runs in this gate.

**Gate 3 - `npm run qa:bots:all`:** First run: **11/12 passed, 1 failed** -
`e2e/human-bots/scenarios/customer-clean-names.spec.ts` (P5 - "Counts shows clean Brand Model Size,
no UPC/Fits"). Investigated as a REAL regression (see below), fixed, reran: **12/12 passed**.

### Regression found and fixed (app code)

The P5 bot failure was verified as a genuine regression introduced by this merge train, not a flake:
- Confirmed the bot **passes** at the pre-merge base commit `7213c20` (tested in a disposable
  worktree).
- Bisected by testing the bot against each of the four merge commits in isolated worktrees: passes
  after `70d8692` (free-rungs) and `5d48d0b` (camera-scan), **fails** starting at `8a36a19`
  (variance-report). Root cause isolated to `feat/variance-report`.

**Root cause:** `feat/variance-report`'s Task 3.5 work bumped the `scanStore` persist `version` from
`6` to `7` (to add the new `countSnapshots` field). The bot seeds `localStorage` at `version: 6`. Before
this bump, a v6 install was already "current" and skipped `scanStoreMigrate` entirely. After the bump,
`6 < 7` now triggers the migration's `version >= 5` branch, which runs `backfillProducts()` -
including the pre-existing deterministic structurer - **for the first time** on this previously-untouched
install. The structurer parses the product's **raw** stored name ("UPC 086699205636 - Defender LTX
M/S 275/70R18 Fits: 2004 Chevrolet") into `structuredModel`, and its brand/junk heuristics do not fully
strip the leading UPC prefix and trailing "Fits" clause in this case. The Name column already cleans
its display value via `customerDisplayName()` for non-platform roles, but the Model column
(`resolvedModel()` in `FinalCountTable.tsx`) never did - so the raw UPC/fitment text leaked through the
Model column, which the bot's `innerText()` assertion correctly caught.

**Fix (`src/components/FinalCountTable.tsx`):** `resolvedModel()` now takes an `isPlatform` flag and
applies the same `customerDisplayName()` cleaning the Name column already uses, for non-platform roles
only - the platformOwner still sees the raw `structuredModel` (render-only cleaning, consistent with
the existing pattern documented in `src/services/displayName.ts`). The Model column's filter/search
index (a separate call site) intentionally keeps reading the raw platform value so filter behavior is
unchanged for both roles.

**Regression tests added** (`src/components/FinalCountTable.test.tsx`, 2 new cases): verified failing
before the fix (temporarily reverted the fix, reran - the new "strips a raw UPC prefix and Fits clause"
test failed with the exact reported string; the "keeps raw value for platformOwner" test still passed),
then passing after restoring the fix. Full `FinalCountTable.test.tsx` suite: 15/15 passed.

Committed as `5f98363` (`fix(counts): clean customer-facing Model column + fix new e2e specs found by
merge-train gate`), combined with the two e2e spec fixes above (same root investigation, one commit).

### Final full-gate rerun (after the fix commit)

- `npm run proof:full`: PASS - tsc clean, vitest **1946/1946 passed, 30 skipped**, `next build` OK.
- `npm run test:e2e`: PASS - **34/34**.
- `npm run qa:bots:all`: PASS - **12/12** (including the previously-failing P5 bot).

### Concerns / notes

- The regression was a real app-code bug (Model column customer-cleaning gap), only exposed because
  the variance-report branch's persist-version bump caused a backfill migration to run for the first
  time on installs it had never touched before. The fix is narrowly scoped and covered by new
  regression tests; no other columns were found to have the same gap (Name column already cleaned;
  Brand/Size/Category/Specs columns do not carry free-text raw names).
- `npm install` after the camera-scan merge produced no lockfile diff (already correct); after the
  csv-import merge it did (csv-parse's dev->prod move needed the lock's dependency-type flag
  updated) - regenerated and committed separately (`a7ca019`), never hand-edited.
- Bisection used disposable `git worktree` checkouts under this session's scratchpad temp directory,
  all removed via `git worktree remove --force` before returning to the main tree; the `C:\tmp\wt-*`
  and other pre-existing worktrees were never touched.
- Nothing was pushed. Working tree still carries the pre-existing unrelated dirty files noted at
  session start (`.claude/settings.local.json`, two `.superpowers/sdd/task-*-report.md` files,
  `mockups/`, `.serena/`, `scripts/polish-eval-results.json`) - untouched by this task.

Full detail: `.superpowers/sdd/merge-train-report.md`.
