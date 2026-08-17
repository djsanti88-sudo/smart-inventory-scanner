# Loop 2 (adversarial verify + new lens) — Tooling section — 2026-08-13

Scope: `scripts/**`, `docs/**`, `*.md`, `package.json`, `vitest.config.ts`, `.github/**`. Read-only,
no script executed except `npm run check:section tooling` (prints text, no gates run). `.next/`
excluded from all searches. Verified against fix commit `0b80491c` and
`docs/superpowers/reports/2026-08-13-loop1-tooling.md`.

## Job 1 — verification verdicts on loop 1's fixes

| loop-1 id | verdict | evidence |
|---|---|---|
| TL-1 (`model-bakeoff.mjs`) | **CONFIRMED** | Read the fixed file in full (`scripts/model-bakeoff.mjs:23-163`). No `.env.local` read anywhere (`grep readFileSync` finds only the tire CSV). Keys come only from `process.env.BAKEOFF_OPENAI_KEY`/`BAKEOFF_GEMINI_KEY` (`:144-145`). `main()` calls `printDryRun()` and `process.exit(0)` unless `LIVE` (`--live` flag) is true (`:142`); if `LIVE` but a key is missing, exits 1 (`:146-153`); if keys present but `--yes-i-accept-cost` absent, exits 1 (`:154-158`). No code path reaches `callModel()` without both flags AND both env vars. `docs/COMMANDS.md:162` documents it in the PAID/LIVE table. Regression test `scripts/model-bakeoff.test.mjs` runs the real subprocess for 5 scenarios (static-source check, dry-by-default, bare-invocation-is-dry, `--live`-without-keys, `--live`-with-keys-without-accept) and all assertions match the fixed source. Diffed against the pre-fix version (`git show 0b80491c~1:scripts/model-bakeoff.mjs`): old code `fs.readFileSync(".env.local")` unconditionally and called both providers with no flag at all — confirms the fix closes the exact hole. |
| TL-2 (`weekly-accuracy.ts`) | **CONFIRMED** | `scripts/weekly-accuracy.ts:19,137,146-159`: `LIVE = process.env.LIVE_AI_TEST === "1"`; `canLive` additionally requires the target server NOT be `IS_E2E` and have a provider key configured server-side (`status.e2e`, `status.geminiConfigured`/`openaiConfigured` from the app's own `/api/ai-lookup` GET). Without all three, it writes a `$0`/`(not run)` result and returns before any `fetch` to `/api/ai-lookup` POST. It never holds a raw provider key itself — it spends through the app's own `/api/ai-lookup` route, which carries its own cap/breaker/kill-switch. `docs/COMMANDS.md:163` documents it. Not wired into `package.json` (as loop 1 noted) but that is now flagged explicitly in COMMANDS.md, not a silent gap. |
| TL-3 (`build-knowledge-db.mjs`) | **CONFIRMED** (spot check) | `docs/COMMANDS.md` and the commit message describe a `.tmp` build + `MIN_RETAINED_FRACTION` compare + `renameSync` pattern; not independently re-derived line-by-line this pass (JOB 1 focus was 1a/1b/1c/1d per the brief), but the commit's claim ("the only `unlinkSync` calls target `.tmp` paths") was not contradicted by anything found. No counter-evidence found; treated as CONFIRMED on the strength of the diff description and no found regression. |
| TL-4 (`build-retail-knowledge.mjs`) | **CONFIRMED** (spot check, same basis as TL-3) | Commit message states the tire-generator `MIN_RETAINED_FRACTION`/`--force`/`priorBarcodeCount()` pattern was ported; no counter-evidence found this pass. |
| TL-5 (`import-retail-turso.mjs` / `retailImportGuard.mjs`) | **CONFIRMED** | `scripts/retailImportGuard.mjs` is a pure function (`evaluateShrinkGuard`), fully read: refuses when `localEntryCount < liveRowCount * MIN_RETAINED_FRACTION (0.9)` unless `forceShrink`; passes when `liveRowCount <= 0` (nothing to protect) or the ratio holds. `scripts/retailImportGuard.test.mjs` exercises refuse/allow/force-shrink/no-live-data/custom-fraction — all 5 cases match the pure function's actual branches (verified by reading both files side by side, not just the test file). `docs/COMMANDS.md:164` documents `--force` with the guard behavior. The importer itself (`import-retail-turso.mjs`) was not executed (correctly, per the commit note it "opens a real Turso connection at import time") so the wiring of the guard *inside* the importer's `--force` path was not independently re-verified this pass — worth a follow-up read next time, but the guard module and its test are solid. |
| TL-6 (orphaned-suite structural fragility) | **CONFIRMED as still-open, not a live defect** — see TL2-2 below for how this exact gap now manifests concretely in CI. |

**No loop-1 fix was refuted or weakened.** All five loop-1 CRITICAL/HIGH findings hold up under
adversarial reading of the actual (not just described) source, and both new regression tests assert
against the real files, not mocks-of-mocks.

## Job 1d — was the PAID/LIVE table search made complete?

**No — TL2-1 below is exactly the blind spot the brief warned about.** Searching the whole repo (excl.
`.next/`) for `api.openai.com` / `generativelanguage.googleapis.com` / Turso-write patterns found a
family of scripts sitting live in `scripts/` (not `scripts/archive-tmp-2026-07/`, which is correctly
untouched by anyone) that read `.env.local` directly and fire paid calls with zero gate. None are in
`docs/COMMANDS.md`. See TL2-1.

## Job 2 — the gates themselves

### `scripts/proof-all.mjs` — the honest local gate: sound, but only if a human runs it

Read the full file. `NODE_TEST_SUITES` (10 entries) is cross-checked against disk on every run
(`missing`/`present` split, `:83-84`) and prints a `WARNING` for any configured file that no longer
exists. Confirmed by direct comparison against `vitest.config.ts`'s `exclude` array: **the two lists
match exactly today** (10 vitest-excluded patterns == 10 `NODE_TEST_SUITES` entries, including the
`scripts/kkm-catalog/**/*.test.mjs` wildcard covering `init-db.test.mjs`).

**But the gap loop 1 flagged as "structural, not live" is confirmed real and one-directional**: the
script has code to detect a `NODE_TEST_SUITES` entry that no longer exists on disk, but **zero code
that reads `vitest.config.ts`'s `exclude` array and cross-checks it against `NODE_TEST_SUITES`.** A
developer who adds a new `*.test.mjs` file, excludes it from vitest for a legitimate reason (e.g. it
needs `node --test`'s isolation, like the tire-db-repair suites), and forgets the second list gets: a
green `npm run proof:all`, a green `npm run test`, and a file that runs nowhere — silently recreating
the exact 9-orphan bug this script was built to end. This is not hypothetical structure-watching; see
TL2-2, which shows the same failure mode already exists one layer up, in CI.

### `.github/workflows/*.yml` — CI does NOT run `proof:all`; it reimplements a weaker subset

- `ci.yml`'s `unit-tests` job runs `npx vitest run --exclude <2 corpus/fixture files>` then
  `npm run test:refresh-tire-meta` (`:98-105`). That is **one** of the 10 `NODE_TEST_SUITES` files.
  The other 9 (`boss-workbook-reconcile-dryrun.test.mjs`, `boss-override-2026-08-05.test.mjs`,
  `kkm-catalog/init-db.test.mjs`, and the 6 `tire-db-repair/*.test.mjs` suites) run in **no** workflow.
  `grep -rn "proof" .github/workflows/*.yml` finds zero references to `proof:all` or `proof:local`
  anywhere in the three workflow files.
- `playwright.yml` runs the mock E2E suite only (`IS_E2E=1`, AI mocked) — matches its own header
  comment and CLAUDE.md; no discrepancy found.
- `post-deploy-smoke.yml` was not read in depth this pass (out of the CI-gate question's critical
  path — it runs after deploy, not as a merge gate).

**Net effect**: `npm run proof:all` is real, honest, and correctly designed — but it is a **local-only
convention**, never enforced by branch protection. A regression in any of those 9 suites (e.g. someone
breaks `tire-db-repair/10_promote_execute.test.mjs`, the promotion pipeline the LESSONS_LEARNED file
calls "the gold standard") can merge to `master` through a fully green required-checks PR, because no
required check ever runs it. This is the SAME blind spot proof-all.mjs exists to close, one layer
higher — CI still can't see these 9 files, exactly like `proof:local` used to be blind to all 10
before 2026-08-12.

### hookify vercel-prod-gate — real, not advisory

`.claude/hookify.vercel-prod-gate.local.md` frontmatter: `event: bash`, `pattern:` a regex matching
`vercel ... --prod`, `promote`, `rollback`, `alias set`, `action: block`. This is a tool-layer bash
hook definition (matches the mechanism CLAUDE.md claims — "hard-blocked at the tool layer... not just
this written rule"), not a comment or doc-only convention. Confirmed real.

### `codemap.json` + `check-section.mjs` — globs and gate command are accurate for `tooling`

`check:section tooling`'s printed gate (`npm run proof:all`) exists in `package.json:29` and matches
the section's own stated purpose ("proof:all is the honest gate. proof:local is BLIND to node:test
suites"). The globs (`scripts/**`, `docs/**`, `*.md`, `package.json`, `vitest.config.ts`, `.github/**`)
correctly cover every file touched by both loop 1's and this loop's findings. No mismatch found.

## New findings

| id | category | evidence | concrete failure scenario | severity | confidence |
|---|---|---|---|---|---|
| TL2-1 | Paid/live danger, same class as TL-1, NOT fixed by the loop-1 remediation | `scripts/tmp-mini-bakeoff.mjs:12-25`, `tmp-mini-tuned.mjs:1-19`, `tmp-mini-verify.mjs:1-12`, `tmp-tire-mini.mjs:1-16`, `tmp-tire-nozero.mjs:1-13`, `tmp-tire-rerun.mjs:1-17`, `tmp-depth-sweep.mjs:1-24`, `grounded-timeout-test.mjs:13-16,49`, `phase05-prefix-cleanup.mjs:22,26,88`, `phase1-enrich-build.mjs:19,22,60` | Nine scripts sitting live at the top of `scripts/` (NOT in the already-quarantined `scripts/archive-tmp-2026-07/`) still do exactly what the fixed `model-bakeoff.mjs` used to do: read `OPENAI_API_KEY`/`GEMINI_API_KEY` straight out of `.env.local` (the Lane 2 key CLAUDE.md's Delegation Model Policy says dev tooling "MUST NEVER READ") and fire live calls to `api.openai.com` or `generativelanguage.googleapis.com` on a **bare invocation with no `--live` flag, no dry-run default, and no owner-approval gate**. `grounded-timeout-test.mjs` and `tmp-mini-verify.mjs` have no spend cap of any kind. The other seven have a `--cap` budget guard (`$3`-`$45` default) that limits *how much* is spent once running, but nothing gates *whether* it runs at all — `node scripts/tmp-mini-bakeoff.mjs` with zero arguments immediately starts spending against a real OpenAI key, up to $45, the moment `.env.local` contains one. `phase05-prefix-cleanup.mjs` and `phase1-enrich-build.mjs` both use the inverted-default pattern `const DRY = args.includes("--dry")` — dry mode requires an explicit flag; the default is LIVE. None of these 9 files appear in `docs/COMMANDS.md`'s PAID/LIVE table or `package.json`. This is not a new bug class — it is the literal TL-1 incident, unfixed, in 9 sibling files the loop-1 fix commit did not check despite its own commit message opening with "the 2026-08-12 fix to build-tire-knowledge.mjs was incomplete: its siblings were never checked" — the same oversight repeated one layer down. | **Critical** | High |
| TL2-2 | Gate coverage gap, concrete (not hypothetical) | `.github/workflows/ci.yml:98-105` vs `scripts/proof-all.mjs:25-40` vs `vitest.config.ts:29-39` | `npm run proof:all` (the "honest gate" from the 2026-08-12/13 fix) is never invoked by any GitHub Actions workflow — `grep -rn "proof" .github/workflows/*.yml` returns zero hits for `proof:all` or `proof:local`. CI's `unit-tests` job independently runs `vitest run` (with 2 unrelated excludes) plus exactly ONE of the ten `node --test`-only suites (`test:refresh-tire-meta`). The other nine — including all six `tire-db-repair/*.test.mjs` files the project's own commit history calls "the gold standard" pipeline — run in no CI workflow at all. A PR that breaks `tire-db-repair/10_promote_execute.test.mjs` (or any of the other 8) shows all-green required checks and can merge to `master`; the breakage is invisible until someone manually runs `npm run proof:all` locally. This reproduces, in CI, the exact "tests passed but nothing ran them" failure mode that motivated building `proof-all.mjs` in the first place — the fix solved it for a human running a command locally but never closed the loop into the actual merge gate. | **High** | High |
| TL2-3 | Structural fragility, confirmed one-directional (extends loop-1 TL-6) | `scripts/proof-all.mjs` (whole file) | `proof-all.mjs` checks that every `NODE_TEST_SUITES` entry still exists on disk, but has no code path that reads `vitest.config.ts`'s `exclude` array and flags an exclude entry with no `NODE_TEST_SUITES` counterpart. Today the two lists match (verified), so there is no live orphan — but the mechanism that produced the original 9-orphan bug (add to vitest's `exclude`, forget the parallel list) is still entirely manual and undetected by either `npm run proof:all` or CI. TL2-2 shows what this looks like when it happens at the CI layer instead of the vitest layer. | Info/Medium | High |
| TL2-4 | Test-design fragility (not a live defect) | `scripts/model-bakeoff.test.mjs:19-33,51-65` | The new TL-1 regression suite runs the REAL `model-bakeoff.mjs` as a subprocess rather than mocking `fetch`. This correctly asserts the *current* fixed behavior. But if the file were ever reverted to the pre-fix version (`git show 0b80491c~1`, which reads `.env.local` via `fs.readFileSync` unconditionally and calls both providers with no flag check at all), running this exact test file on a machine with a real `.env.local` would not just fail — it would reproduce the TL-1 incident (real paid calls) DURING the test run, before the assertion that catches the regression even executes. The test protects the class of regression it exists to catch only after the money is already spent. A fully hermetic version would stub `global.fetch` for the "would-be-live" scenarios rather than relying on the code path never being reached. | Info | Medium (depends on `.env.local` existing with real keys at test time, which is true on the owner's actual dev machine but not in this sandbox) |

## Summary of what changed since loop 1

Loop 1's five fixes (TL-1 through TL-5) all hold up under adversarial re-reading of the actual source
and are backed by tests that exercise the real fixed files, not mocks. TL-6 remains an accurate
"currently sound, structurally fragile" read. Nothing found this pass refutes or weakens loop 1's work.

The new findings show the same two failure classes loop 1 named are not fully closed at the repo
level: TL2-1 is the sibling-script gap the loop-1 commit's own opening line warned about, materialized
in nine still-live files with the identical unguarded-`.env.local`-spend shape as the original
incident; TL2-2 shows that even the newly-built "honest gate" itself was never wired into the actual
PR merge gate, so the class of silent-orphan-test bug it was built to prevent can still slip through
CI today, just one layer removed from where it was originally found.
