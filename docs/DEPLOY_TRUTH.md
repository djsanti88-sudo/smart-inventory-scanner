# Deploy Truth (canonical)

This is the single source of truth for how a deploy actually happens on this project today. When
CLAUDE.md, COMMANDS.md, GO_LIVE_CHECKLIST.md, or any other doc describes deploy mechanics, it should
point here rather than restate it - this file is what gets updated when the mechanism changes.

## GitHub is the deploy trigger (cutover complete 2026-08-06)

**Merging to `master` IS a production deploy.** Vercel's Git integration is fully connected: a pull
request against `master` gets an automatic preview deployment, and a merge to `master` automatically
builds and deploys production (Production Branch = `master`; confirmed on PR #28/#29 on 2026-08-06 and
on every merge since, most recently PR #38 on 2026-08-19, each followed by a green
`Post-deploy smoke` run). Branch protection is live on `master` (five required checks: typecheck,
unit-tests, build, lint, `Mock E2E (chromium)`; strict; `enforce_admins: true`). `git push` to a
feature branch deploys nothing by itself; it only produces a preview through the PR it is attached to.

**Therefore merging or pushing to `master` is an owner-gated production action.** An agent may open
and update PRs, but the merge itself (or any direct push to `master`) requires the owner's explicit
approval in the current conversation, the same as `vercel --prod`. Approval for one merge never
carries to the next. This is the single rule; `AGENTS.md` "Owner-gated actions" and `GUARDRAILS.md`
point here rather than restating it.

`vercel.json` keeps only `ignoreCommand: scripts/vercel-ignore-build.mjs` (the deploy gate that skips
builds for irrelevant changes); the old `git.deploymentEnabled.master: false` block was removed by
PR #21 as the deliberate last cutover step after protection was confirmed live (see "Sequencing").

## The pipeline, end to end

1. **Branch.** Cut a feature branch from `master`.
2. **PR.** Open a pull request against `master`.
3. **CI required checks.** GitHub Actions runs `.github/workflows/ci.yml`'s four jobs plus the
   separate mock Playwright workflow as five required checks on the PR. The four `ci.yml` jobs run
   narrower/more specific commands than the plain `npm run test`/`npm run lint` scripts, not identical
   to them:
   - **typecheck**: `npx tsc --noEmit`.
   - **unit-tests**: `npx vitest run`, with two explicit exclusions -
     `--exclude "src/server/tire-knowledge/dtHarvestIntegration.test.ts"` (needs a locally-built
     knowledge DB not built in CI) and
     `--exclude "src/components/UniversalImportPanel.fixtures.test.tsx"` (needs gitignored local-only
     CSV fixtures with no CI-reachable generator). See the comments at the top of `ci.yml` for the full
     rationale on both exclusions.
   - **build**: `npm run build` (`next build`).
   - **lint**: `npx eslint src --ignore-pattern "**/*.test.ts" --ignore-pattern "**/*.test.tsx"
     --ignore-pattern "**/*.test.mjs"` - scoped to production `src` only, narrower than the plain
     `npm run lint` script; `scripts/` and `e2e/` are not linted by this required check (46 pre-existing
     errors live there, confined to non-production files - see the comment in `ci.yml`).

   Together with `Mock E2E (chromium)` below, all five are required status checks on `master`
   (confirmed live via `branches/master/protection`: `required_status_checks.contexts = [typecheck,
   unit-tests, build, lint, Mock E2E (chromium)]`, `strict: true`, `enforce_admins: true`) - a PR
   cannot merge while any of them are red, including for the repo owner.

3a. **Playwright Mock E2E is the fifth required check.** `.github/workflows/playwright.yml` runs the
   mock-backend Playwright suite (`npm run test:e2e`, the same suite `test:e2e` runs locally) on every
   push and PR to `master`. Its required check is `Mock E2E (chromium)`, so a PR cannot merge while it
   is red. `IS_E2E=1` in its `webServer` forces `/api/ai-lookup` mock-only, so this workflow never calls
   a live AI provider.
4. **Preview URL.** The Vercel GitHub bot comments the PR with a preview deployment URL once the
   build succeeds. Preview runs against a dedicated, authenticated Firebase project
   (`smart-inventory-preview`, separate from production) and carries live paid AI provider keys
   (`GO_UPC_API_KEY`, `OPENAI_API_KEY`) so decode can be exercised end to end - see "Preview
   environment" below for the full policy and the daily-cap guard that bounds that spend. A preview
   link is safe to hand out or click for auth/scan testing against preview data, but it is NOT a
   mock, no-login, no-spend sandbox.
5. **Owner approves the merge.** The owner reviews and merges the PR, or explicitly approves an agent
   doing so in the current conversation (self-approval is allowed on this solo-owner repo; branch
   protection still requires the PR + green checks, it does not require a second human). Because of
   step 6, this approval is the production-deploy approval.
6. **Merge to `master` deploys production.** Vercel builds the merge commit and promotes it to
   production automatically; `.github/workflows/post-deploy-smoke.yml` then runs the fingerprint smoke
   against the deployed URL on the `deployment_status` event. A red smoke run means production is
   already serving the bad commit: go straight to step 7.
7. **Rollback.** Two paths that do different jobs - use both, in order, not either/or:
   - **(a) Fast stopgap (dashboard/CLI, changes what production serves right now).** Vercel's own
     promote/rollback: the dashboard may label this "Instant Rollback" or "Promote to Production" for a
     prior deployment, or the equivalent `vercel rollback` CLI command. This is the correct FIRST move
     during an active incident - it changes what production serves immediately. It does **not** fix
     `master`: the bad commit is still there, so the very next merge can re-ship the same bug unless
     someone also does (b).
   - **(b) Mandatory follow-up (`git revert`, fixes the source of truth).** `git revert` the offending
     merge commit and let the revert PR go through the normal pipeline (branch protection + required
     checks). This is what actually prevents the bug from coming back on the next merge. **Do this
     every time**, even after (a) already stopped the bleeding.
   - Merging the revert PR deploys the revert to production through the same trigger as any other
     merge, so (b) also restores production once its build finishes; (a) is only faster.
   - **EXCEPTION - never `git revert` the cutover flip PR (#21) itself.** Reverting #21 would
     re-introduce the `deploymentEnabled.master: false` block, and a revert that re-blocks deploys
     cannot deploy itself - it would strand whatever bad code is already live in production with no way
     for a further merge to fix it. If #21 itself needs to be undone, use path (a) (dashboard/CLI
     rollback) instead, and handle the git-history fix as a separate, deliberate change reviewed on its
     own terms.

## Still owner-gated (nothing here becomes automatic)

- **Merge or push to `master`** - it deploys production (see above), so it needs the owner's explicit
  OK in the current conversation.
- **Manual production promote / rollback / alias changes** via dashboard or CLI - same gate.
- **Firestore security rules deploys** (`npm run deploy:rules:prod`) are a completely separate
  production surface outside Vercel. Merging a PR to `master` never touches Firestore rules; rules
  changes still require the explicit `deploy:rules:prod` command run with owner sign-off per
  `docs/GO_LIVE_CHECKLIST.md`.
- **Paid/live API keys and any live-provider calls** - CI runs against mock providers, so nothing in
  the CI pipeline itself calls a paid AI provider. Preview is different: it carries real
  `GO_UPC_API_KEY` / `OPENAI_API_KEY` values and can make live paid decode calls, bounded by the same
  daily cap as production - see "Preview environment" below before treating a preview URL as spend-free.
- **The local CLI deploy path** - emergency-only now that production ships from `master`; see below.
- **Branch protection, required-check config, and the Vercel Git connection itself** - changing any
  of these is a deploy-mechanism change and needs the same explicit owner approval as a production
  promote.

## Local CLI deploy (emergency-only)

`node scripts/deploy-preview.mjs` is a **preview-only** wrapper (never `--prod`). Production ships
from `master`, so this script is an emergency-only fallback for previews - use it only when
GitHub-driven previews are themselves unavailable (e.g. the Vercel Git integration is down or
misconfigured), never as a routine alternative to opening a PR. It still requires the same explicit
owner authorization as any other deploy action before it runs. Mechanically it
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

Branch protection on `master` was put in place **before** the `vercel.json` auto-deploy flag was
removed - protection was confirmed live first, then PR #21 removed the flag. Flipping the flag first,
with no protection in place, would have meant any direct push to `master` deployed straight to
production with no required checks - the exact failure mode the 2026-07-22 disconnect was originally
reacting to, just automated instead of manual. Any future change to either branch protection or the
Git integration setting must preserve that ordering: protection changes first, deploy-trigger changes
last. Both steps are done: the flag removal (PR #21) and the dashboard Git connection
(Production Branch = `master`, active since 2026-08-06).

## Preview environment: dedicated authenticated Firebase project

Preview deployments use `smart-inventory-preview`, a Firebase project separate from
`smart-inventory-scanner-app` production. Preview carries its own browser Firebase configuration,
explicit `FIREBASE_PROJECT_ID`, and Preview-scoped Admin credential so authentication, Firestore,
sessions, and tenant-isolation can be tested without touching production users or inventory. This
supersedes the earlier mock/no-login-by-design Preview state described in historical commit messages
and `DECISIONS.md`'s 2026-07-22 deployment-model entry; this file (not `FIREBASE_SETUP.md`) is the
authoritative current statement of Preview policy.

**Owner-ratified policy (2026-07-27): paid AI keys REMAIN in Preview.** `scripts/env-manifest.json`
requires `GO_UPC_API_KEY` and `OPENAI_API_KEY` in the `preview` environment (same as production) so
PR previews can exercise live decode end to end, not just against mocks. The guard against runaway
spend is the daily AI cap (`AI_LOOKUP_DAILY_LIMIT`), shared across environments the same way it bounds
production - NOT the absence of keys. A preview link is therefore not spend-free: opening a PR and
exercising decode on its preview URL can burn paid budget, capped daily.

Preview must never use emulator mode, a production-mode opt-in, raw service-account JSON, or platform
owner overrides - those remain forbidden by `scripts/env-manifest.json`. Runtime browser proof must
also confirm the public Firebase project ID before any authenticated test.

### Current safety stop (2026-07-26)

The previously deployed Preview bundle contained the production Firebase project. That deployment is
not an acceptable authenticated test target. A dedicated Preview project now exists, but the Vercel
Preview variables and runtime proof must be updated before a new authenticated Preview is deployed.

## Production environment

Production carries the real Firebase config (`NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_AUTH_MODE=live`,
`FIREBASE_SERVICE_ACCOUNT_JSON`/`_BASE64`) per `docs/GO_LIVE_CHECKLIST.md`. As of 2026-07-22,
production also includes `GO_UPC_API_KEY` so the paid Go-UPC rung of the decode ladder is live in
production. As of the 2026-07-27 owner-ratified Preview policy above, `GO_UPC_API_KEY` is now also
required in Preview (no longer production-only) - see "Preview environment" above. Whenever a new env
var is added to one environment, check the other environments for parity before assuming it is
everywhere the code expects it.

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
  var silently missing (e.g. `GO_UPC_API_KEY` absent from Preview, which IS required there per the
  Preview environment section above) and a forbidden var silently present (e.g. emulator mode, a
  production-mode opt-in, or raw service-account JSON leaking into Preview, which would break the
  dedicated-project isolation guarantee above). Exit 0 = no gaps, exit 1 = gaps printed per
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
doc rather than trusting it. Current state: branch protection, CI required checks, the `vercel.json`
flag removal (PR #21), and the Vercel Git connection are all done; a merge to `master` deploys
production and is therefore owner-gated.
