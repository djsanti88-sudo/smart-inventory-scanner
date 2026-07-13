# Backlog (current-state, 2026-07-12)

Supersedes the 2026-07-06 Cowork handoff plan. That plan was re-grounded against the repo on
2026-07-12: roughly half of it was already done and its decode description was a month stale.
This file is the corrected, verified backlog. Execution order and proof rules follow
ENGINEERING_DOCTRINE.md. Nothing here is approved to run yet; the owner picks items.

## Removed from the old plan (wrong or already done)

- ~~Move off OneDrive~~ - the repo already lives at `C:\Users\djsan\inventory`, local, non-synced.
- ~~Rewrite README~~ - done 2026-07-12 (commit cf23841).
- ~~Consolidate 24 root docs into docs/archive/~~ - done 2026-07-12 (cf23841 + b74215c).
- ~~Review the "trust the AI + fast" decode brain~~ - obsolete; ladder v2 with strict evidence
  gates replaced that architecture (see docs/DECODER_ARCHITECTURE.md).
- ~~Secrets hygiene check~~ - verified 2026-07-12: `.env.local` and `firestore-debug.log` are
  untracked; `.gitignore` covers `.env*`.

## TIER 0 - protect the work (do before anything else)

- [ ] **Back up / push `feat/decode-ladder-goupc`** (165 commits, one laptop only).
      LANDMINE FOUND 2026-07-12: `.gitattributes` is EMPTY (0 bytes) but
      `src/server/retail-knowledge/retailKnowledge.generated.json` (247MB) is Git-LFS tracked
      from an old rule. With the rule gone, any future `git add` of that file stages the raw
      247MB and GitHub will reject the push (100MB hard limit). Restore the LFS line BEFORE
      any commit touches that file. `tireKnowledge.generated.json` (67.8MB) is a RAW blob -
      pushable but bloats every clone; decide LFS vs externalize (it already lives on Turso).
- [ ] **Restore `.gitattributes`**: LFS rule for the retail JSON + `* text=auto eol=lf` +
      CRLF exceptions for `*.ps1/*.bat/*.cmd` + binary rules, then `git add --renormalize .`
      on a branch with a clean proof run.

## TIER 1 - foundation and hygiene (low risk, high leverage)

- [ ] **Firebase doc-vs-reality**: CLAUDE.md's stack line still says "no Firebase wired" while
      `firebaseAdmin.ts`, phase-2 e2e, `qa:bots:live`, and firestore.rules exist. Fix the line;
      state exactly what is wired vs mock (the rest of the 2026-07-06 plan's item A).
- [ ] **Untrack `reports/`**: `.gitignore` has `/reports/` but 37 files are already committed.
      `git rm --cached` them.
- [ ] **Root artifact sweep** (tracked): 15 proof PNGs (~1.9MB), `cleanup-review-report.html`,
      `cleanup-review-report-rendered.png` (771KB), `competitor-analysis.html`,
      `cleanup-review-summary.json`, `LIVE_SMOKE_OUTPUT.txt` - move proofs to `docs/archive/proof/`
      or delete (owner call), then gitignore root `*.png`.
- [ ] **scripts/ sweep**: 78 `tmp-*` files (~38MB with results JSONs). Archive the few with
      historical value (benchmark result JSONs) into `docs/archive/` or delete; keep the ~20
      living scripts. Add a one-line `scripts/README.md` listing the living ones.
- [ ] **Delete strays**: root `auth`, `auth-wal` (0-byte), the mangled scratchpad file
      `C:UsersdjsanAppData...gptladder_base.ts`, `firestore-debug.log` (untracked, 200KB).
- [ ] **Branch + worktree pruning**: 19 local branches, 4 worktrees (3 in C:\tmp). Tag tips
      `bkp/*`, delete merged/dead branches, `git worktree remove` stale ones.
      DO NOT touch `benchmark-tire-db-automation` (parked by owner order).
- [ ] **data/ snapshot audit**: ~100MB of tracked CSVs/HTML in `data/tire-knowledge/`
      (28MB backup CSV, 16MB dated snapshot, 15MB generated HTML view). Keep live corpus files,
      archive/delete old snapshots (owner call - data deletion gate).

## TIER 2 - code health (from the 2026-07-12 source audit)

- [ ] **Split `scanStore.ts`** (4,511 lines): core store / actions / auto-count gate rules.
- [ ] **Split `app/api/ai-lookup/route.ts`** (1,097 lines): thin route + decode pipeline service.
- [ ] **Remove dead code**: `autoAcceptVerifiedDecodes` (types.ts + defaults; gates nothing),
      deprecate `decodeOrchestrator.ts` (superseded by the ladder; only type imports remain),
      archive `geminiProvider.ts` decode path (permanently gated off by `GEMINI_DECODE_DISABLED`).
- [ ] **Add missing unit tests**: `fetchV2/scoring.ts`, `fetchV2/siblingGuard.ts`,
      `fetchV2/index.ts`, `tire/tirePrefixHints.ts` (all high-risk, only indirectly tested).
- [ ] **Full proof run** before the push decision: `npm run proof:full` + `npm run test:e2e`
      + `npm run qa:bots` (fix or explain failures; capture screenshots).
- [ ] **Dependency review**: `npm audit`, Next 16/React 19 known issues, confirm
      `patch-jwks-rsa.cjs` postinstall is still required.

## TIER 3 - product gates (owner decisions)

- [ ] **Role gating P0**: every authenticated user can currently see raw codes/aliases
      (docs/CURRENT_CONTEXT.md section 4). Biggest product-trust gap for multi-tenant SaaS.
- [ ] **Production promotion** (go-live checklist: sign-off + prod env keys + vercel promote).
- [ ] **T9 paid backfill** of the 16 missing tire codes (owner-gated script 83d3d62).
- [ ] **Weekly DT-harvest schedule** + harvest-branch merge decision.
- [ ] **Firebase Phase 2 completion**: decide staged vs fully-live multi-tenant; prove rules
      with emulator tests only.

## TIER 4 - lock it in

- [ ] **CI on GitHub** once pushed: lint + typecheck + vitest + build on every push
      (Playwright optional in CI). Turns the one-time proof run into a permanent gate.
- [ ] **Knowledge-data relocation**: generated corpora (343MB db + 127MB gz + JSONs) out of
      `src/server/` into `data/` or fully external (Turso is already the runtime source on
      preview) - verify Vercel runtime dependency FIRST before moving anything.

## Definition of done (every item)

Branch + proof (build/test/E2E output + screenshots where UI) + PROGRESS.md updated + no
destructive action without explicit owner approval (deletion items above are flagged).
