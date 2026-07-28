# Deploy Truth (canonical)

This is the single source of truth for how a deploy actually happens on this project today. When
CLAUDE.md, COMMANDS.md, GO_LIVE_CHECKLIST.md, or any other doc describes deploy mechanics, it should
point here rather than restate it - this file is what gets updated when the mechanism changes.

## GitHub is the deploy trigger (cutover in progress, started 2026-07-27)

Vercel's Git integration is connected to this repo, and branch protection is live on `master`
(required checks: typecheck, unit-tests, build, lint). Opening a pull request against `master`
automatically produces a Vercel preview deployment. `git push` to a feature branch on its own never
deploys anything by itself; it only deploys through the PR it is attached to.

**Not yet flipped:** `vercel.json` still sets `git.deploymentEnabled.master: false`, so merging a PR
into `master` does not yet auto-deploy to production - that remains the pre-cutover manual/CLI path
below until the flag is removed. The flag is deliberately the LAST step of the cutover, removed only
after branch protection is confirmed live - see "Sequencing" below. Once it is flipped, merging an
approved PR into protected `master` will automatically deploy to production (or trigger an owner
promote, if promotion is left in manual mode - see the production section below). The cutover itself
is tracked in `docs/superpowers/plans/2026-07-27-github-truth-repo-health.md` once that plan is
committed; until then, treat this section's "not yet flipped" note as the operative fact, not the
target-state description below it.

## The pipeline, end to end

1. **Branch.** Cut a feature branch from `master`.
2. **PR.** Open a pull request against `master`.
3. **CI required checks.** GitHub Actions runs on the PR: typecheck (`tsc --noEmit`), unit/dom tests
   (`npm run test`), production build (`npm run build`), lint (`npm run lint`), plus the existing
   mock Playwright E2E suite (`.github/workflows/playwright.yml`). All of these are required status
   checks on `master` - a PR cannot merge while any of them are red.
4. **Preview URL.** The Vercel GitHub bot comments the PR with a preview deployment URL once the
   build succeeds. The preview always runs the mock backend with no login wall (see "Preview
   environment" below) - a preview link is safe to hand out or click without touching real Firebase
   data or spending live AI budget.
5. **Owner merges.** The owner reviews and merges the PR (self-approval is allowed on this solo-owner
   repo; branch protection still requires the PR + green checks, it does not require a second human).
6. **Master auto-deploys (once the flag is flipped).** Once `vercel.json`'s
   `deploymentEnabled.master` flag is removed, merging to `master` will trigger a production Vercel
   deployment automatically, unless promotion has been switched to manual in the Vercel project
   settings, in which case the owner promotes the build from the dashboard or CLI. Until the flag is
   removed, a merge to `master` does NOT deploy anything by itself - production still goes through the
   manual/CLI path (see "Local CLI deploy" below, which today is still the primary path for
   production).
7. **Rollback.** Two supported paths: (a) Vercel's own promote/rollback (dashboard "Instant Rollback"
   to a prior production deployment, or `vercel rollback` CLI), or (b) `git revert` the offending
   merge commit and let the revert PR go through the same pipeline. Prefer (a) for speed during an
   active incident, (b) when the revert also needs to be reflected in git history going forward.

## Still owner-gated (nothing here becomes automatic)

- **Production promote**, if the Vercel project is left in manual-promote mode instead of
  auto-deploy-on-merge - this is an explicit owner or owner-approved action, never implied by a
  merge alone.
- **Firestore security rules deploys** (`npm run deploy:rules:prod`) are a completely separate
  production surface outside Vercel. Merging a PR to `master` never touches Firestore rules; rules
  changes still require the explicit `deploy:rules:prod` command run with owner sign-off per
  `docs/GO_LIVE_CHECKLIST.md`.
- **Paid/live API keys and any live-provider calls** - CI and preview builds run against mock
  providers; nothing in the pipeline itself calls a paid AI provider.
- **The local CLI deploy path** - see below (today this is still how production actually ships,
  pending the flag flip; it is designed to become emergency-only once production auto-deploys).
- **Branch protection, required-check config, and the Vercel Git connection itself** - changing any
  of these is a deploy-mechanism change and needs the same explicit owner approval as a production
  promote.

## Local CLI deploy (still the production path today; becomes emergency-only after the flag flips)

`node scripts/deploy-preview.mjs` is a **preview-only** wrapper (never `--prod`). For actual
production shipping today, before the `vercel.json` flag is removed, production still goes out via
the owner-only manual/CLI path described below, not this script. Once GitHub-driven production
deploys are live, this script is designed to become an emergency-only fallback for previews - use it
only when GitHub-driven previews are themselves unavailable (e.g. the Vercel Git integration is down
or misconfigured), not as a routine alternative to opening a PR. It still requires the same explicit
owner authorization as any other deploy action before it runs. Mechanically it is unchanged: it
acquires an exclusive `.deploy-lock` (stale locks over 30 min are reclaimed), runs the fix-lineage and
env-parity preflight gates below, runs a plain `vercel deploy` (never `--prod`), then runs the
post-deploy smoke fingerprint against the resulting URL, releasing the lock in all cases.
`node scripts/deploy-preview.mjs --dry-run` exercises the lock + preflight logic without shelling out
to `vercel` or making any network call. A raw `vercel deploy` run by hand still works and is not
blocked, but skips the lock and both gates - avoid it even for the emergency path.

**Production promote/rollback**: **OWNER-ONLY** regardless of path (GitHub-driven or emergency CLI),
via the Vercel dashboard or an explicit `vercel --prod` / `vercel promote` / `vercel rollback` /
`vercel alias set` CLI call that the owner has approved in the moment. No agent session may run these
without that explicit approval, even if a prior session already got a yes for a similar action -
approval does not carry across sessions.

## Live enforcement: the hookify prod gate

`.claude/hookify.vercel-prod-gate.local.md` is a local, deterministic hook (not just a doc convention)
that hard-blocks any Bash invocation matching production-flipping Vercel patterns:
`vercel --prod`, `vercel deploy ... --prod`, `vercel promote`, `vercel rollback`, `vercel alias set`.
Plain preview/read-only commands (`vercel deploy` with no `--prod`, `vercel ls`, `vercel inspect`,
`vercel env ls`, `vercel logs`) are unaffected and remain allowed for local verification. This is the
actual enforcement mechanism, not just written policy - a session cannot "forget" the No-Deploy Rule
for these specific commands because the hook blocks them mechanically. It applies identically whether
the attempted command comes from the GitHub-driven flow's manual-promote step or the emergency CLI
fallback.

## Sequencing (why order matters for the cutover)

Branch protection on `master` was put in place **before** the `vercel.json` auto-deploy flag is
removed - protection is confirmed live today, the flag flip has not happened yet. Flipping the flag
first, with no protection in place, would have meant any direct push to `master` deployed straight to
production with no required checks - the exact failure mode the 2026-07-22 disconnect was originally
reacting to, just automated instead of manual. Any future change to either branch protection or the
Git integration setting must preserve that ordering: protection changes first, deploy-trigger changes
last - so removing the `deploymentEnabled.master: false` flag is the final, still-pending step of this
cutover, not something already done.

## Preview environment: dedicated authenticated Firebase project

Preview deployments use `smart-inventory-preview`, a Firebase project separate from
`smart-inventory-scanner-app` production. Preview carries its own browser Firebase configuration,
explicit `FIREBASE_PROJECT_ID`, and Preview-scoped Admin credential so authentication, Firestore,
sessions, and tenant-isolation can be tested without touching production users or inventory. This
supersedes the earlier mock/no-login-by-design Preview state; see `FIREBASE_SETUP.md` for the
corresponding policy note. Live paid-AI provider keys must still never be present in the Preview
environment - PR previews must never be able to burn paid AI budget just because a PR was opened.

Preview must never use emulator mode, a production-mode opt-in, raw service-account JSON, or platform
owner overrides. `scripts/env-manifest.json` enforces the environment-variable names; runtime browser
proof must also confirm the public Firebase project ID before any authenticated test.

### Current safety stop (2026-07-26)

The previously deployed Preview bundle contained the production Firebase project. That deployment is
not an acceptable authenticated test target. A dedicated Preview project now exists, but the Vercel
Preview variables and runtime proof must be updated before a new authenticated Preview is deployed.

## Production environment

Production carries the real Firebase config (`NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_AUTH_MODE=live`,
`FIREBASE_SERVICE_ACCOUNT_JSON`/`_BASE64`) per `docs/GO_LIVE_CHECKLIST.md`. As of 2026-07-22,
production also includes `GO_UPC_API_KEY` so the paid Go-UPC rung of the decode ladder is live in
production; this key is not present in Preview. Whenever a new env var is added to one environment,
check the other environments for parity before assuming it is everywhere the code expects it.

## Preflight gates (facts in, verdict out)

- `npm run release:check` / `npm run deploy:card` - `scripts/release-sentinel.mjs`. Pure, read-only,
  no network calls of its own: evaluates local git facts (dirty tree, staged secrets/generated files)
  plus cross-system facts passed in via `SENTINEL_*` env vars (Vercel project/alias, Firebase prod
  project, branch protection) into a blocker/warning list and a deploy card with the mandatory owner
  approval phrase (`DEPLOY THIS SHA`). Never mutates anything and never deploys by itself. Useful as
  a preflight sanity check before merging a PR today, and will remain useful once the merge itself
  triggers the deploy after the `vercel.json` flag is removed.
- `node scripts/check-fix-lineage.mjs [ref]` - git-ancestry based, not a hand-maintained file
  manifest: fails unless local `master` is an ancestor of the candidate ref (`ref` defaults to `HEAD`)
  AND every commit in `scripts/fix-lineage-pins.json` (if present) is also an ancestor. Exit 0 =
  lineage OK, exit 1 = missing mainline/pinned commits (named in the message), exit 2 =
  usage/environment error. Originally built for the local CLI path; still wired into the emergency
  fallback wrapper.
- `node scripts/check-env-parity.mjs [--env=production|preview]` - shells out to
  `vercel env ls <environment>` and diffs variable NAMES ONLY (never values - Vercel only ever shows
  Encrypted/Plain, and this script deliberately never runs `vercel env pull`) against
  `scripts/env-manifest.json`'s required/forbidden/optional sets per environment. Catches a required
  var silently missing (e.g. `GO_UPC_API_KEY` absent from Preview) and a forbidden var silently
  present (e.g. `NEXT_PUBLIC_FIREBASE_*` or a live AI key leaking into Preview, which would break the
  mock/no-login and no-paid-spend guarantees above). Exit 0 = no gaps, exit 1 = gaps printed per
  environment.
- `node scripts/smoke-fingerprint.mjs <deployed-url> [--expect-lineage-mismatch]` - post-deploy,
  read-only GET checks against a URL that has already been deployed: the `/api/ai-lookup` capability
  JSON matches `scripts/smoke-expected.json` (empty `missingKeys`, Go-UPC configured, daily limit,
  ladder order, Gemini never used for decode), a route fingerprint (`/scan`, `/history`,
  `/catalog-review`, `/reconcile` 200/307 as expected; `/sessions` 404 is correct, not a bug - there
  is no index route under `sessions/`, only `sessions/[id]`), and a check for Vercel's "Deployment has
  failed" masquerade page (a failed build can still answer 200 while serving Vercel's own error HTML).
  Exit 0 = all checks passed, exit 1 = a mismatch, exit 2 = usage/network error.
  `--expect-lineage-mismatch` is for the script's own self-test only. Useful for spot-checking a
  production deploy after a merge, or the preview URL from a PR.
- All three scripts above are wired into `scripts/deploy-preview.mjs` (see "Local CLI deploy" above)
  and also runnable standalone for manual verification at any time.

## What this replaces

Treat this file as authoritative over any older, vaguer description of "how deploy works" elsewhere in
the docs. If another doc's deploy description conflicts with this one, this file wins; fix the other
doc rather than trusting it. Today's actual state is the transition point: branch protection and CI
required checks are live, but production deploy is still manual/CLI until the `vercel.json` flag is
removed as the final cutover step - do not describe production as "auto-deploys on merge" as a
present-tense fact until that flag is confirmed removed.
