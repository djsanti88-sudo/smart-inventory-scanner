# Deploy Truth (canonical)

This is the single source of truth for how a deploy actually happens on this project today. When
CLAUDE.md, COMMANDS.md, GO_LIVE_CHECKLIST.md, or any other doc describes deploy mechanics, it should
point here rather than restate it - this file is what gets updated when the mechanism changes.

## GitHub is disconnected from Vercel (deliberate, 2026-07-22)

`vercel.json` sets `git.deploymentEnabled.master: false`. Pushing to `master` (or any branch) does
NOT trigger a Vercel build or deploy. This was a deliberate decision after an incident where a
preview-only branch reached production through an assumed "push = deploy" pipeline that did not
actually exist as believed. Treat "I pushed" and "it deployed" as two completely unrelated facts on
this project - never assume one implies the other.

## Deploys are manual/CLI or owner-only dashboard, never automatic

- **Preview deploys**: `node scripts/deploy-preview.mjs` is the sanctioned wrapper (added
  2026-07-22, the day of the incident this doc describes). It acquires an exclusive `.deploy-lock`
  (stale locks over 30 min are reclaimed), runs the fix-lineage and env-parity preflight gates below
  (tolerating their absence only if they are ever removed), runs a plain `vercel deploy` (never
  `--prod`), then runs the post-deploy smoke fingerprint against the resulting URL, releasing the
  lock in all cases. `node scripts/deploy-preview.mjs --dry-run` exercises the lock + preflight
  logic without shelling out to `vercel` or making any network call - use this to sanity-check the
  wrapper itself. A raw `vercel deploy` run by hand still works and is not blocked, but skips the
  lock and both gates, so prefer the wrapper.
- **Production promote/rollback**: **OWNER-ONLY**, via the Vercel dashboard or an explicit
  `vercel --prod` / `vercel promote` / `vercel rollback` / `vercel alias set` CLI call that the owner
  has approved in the moment. No agent session may run these without that explicit approval, even if
  a prior session already got a yes for a similar action - approval does not carry across sessions.

## Live enforcement: the hookify prod gate

`.claude/hookify.vercel-prod-gate.local.md` is a local, deterministic hook (not just a doc convention)
that hard-blocks any Bash invocation matching production-flipping Vercel patterns:
`vercel --prod`, `vercel deploy ... --prod`, `vercel promote`, `vercel rollback`, `vercel alias set`.
Plain preview/read-only commands (`vercel deploy` with no `--prod`, `vercel ls`, `vercel inspect`,
`vercel env ls`, `vercel logs`) are unaffected and remain allowed for local verification. This is the
actual enforcement mechanism, not just written policy - a session cannot "forget" the No-Deploy Rule
for these specific commands because the hook blocks them mechanically.

## Preview environment: dedicated authenticated Firebase project

Preview deployments use `smart-inventory-preview`, a Firebase project separate from
`smart-inventory-scanner-app` production. Preview carries its own browser Firebase configuration,
explicit `FIREBASE_PROJECT_ID`, and Preview-scoped Admin credential so authentication, Firestore,
sessions, and tenant-isolation can be tested without touching production users or inventory.

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
production also includes `GO_UPC_API_KEY` (added that date) so the paid Go-UPC rung of the decode
ladder is live in production; this key is not present in Preview. Whenever a new env var is added to
one environment, check the other environments for parity before assuming it is everywhere the code
expects it.

## Preflight gates (facts in, verdict out)

- `npm run release:check` / `npm run deploy:card` - `scripts/release-sentinel.mjs`. Pure, read-only,
  no network calls of its own: evaluates local git facts (dirty tree, staged secrets/generated files)
  plus cross-system facts passed in via `SENTINEL_*` env vars (Vercel project/alias, Firebase prod
  project, branch protection) into a blocker/warning list and a deploy card with the mandatory owner
  approval phrase (`DEPLOY THIS SHA`). Never mutates anything and never deploys by itself.
- `node scripts/check-fix-lineage.mjs [ref]` (prevention item 1) - git-ancestry based, not a
  hand-maintained file manifest: fails unless local `master` is an ancestor of the candidate ref
  (`ref` defaults to `HEAD`) AND every commit in `scripts/fix-lineage-pins.json` (if present) is also
  an ancestor. Exit 0 = lineage OK, exit 1 = missing mainline/pinned commits (named in the message),
  exit 2 = usage/environment error. This is the direct fix for the 2026-07-22 incident (a deploy
  candidate built from a lineage missing already-shipped fixes).
- `node scripts/check-env-parity.mjs [--env=production|preview]` (prevention item 2) - shells out to
  `vercel env ls <environment>` and diffs variable NAMES ONLY (never values - Vercel only ever shows
  Encrypted/Plain, and this script deliberately never runs `vercel env pull`) against
  `scripts/env-manifest.json`'s required/forbidden/optional sets per environment. Catches a required
  var silently missing (e.g. `GO_UPC_API_KEY` absent from Preview) and a forbidden var silently
  present (e.g. `NEXT_PUBLIC_FIREBASE_*` leaking into Preview, which would break the mock/no-login
  guarantee above). Exit 0 = no gaps, exit 1 = gaps printed per environment.
- `node scripts/smoke-fingerprint.mjs <deployed-url> [--expect-lineage-mismatch]` (prevention item 3)
  - post-deploy, read-only GET checks against a URL that has already been deployed: the
  `/api/ai-lookup` capability JSON matches `scripts/smoke-expected.json` (empty `missingKeys`, Go-UPC
  configured, daily limit, ladder order, Gemini never used for decode), a route fingerprint
  (`/scan`, `/history`, `/catalog-review`, `/reconcile` 200/307 as expected; `/sessions` 404 is
  correct, not a bug - there is no index route under `sessions/`, only `sessions/[id]`), and a check
  for Vercel's "Deployment has failed" masquerade page (a failed build can still answer 200 while
  serving Vercel's own error HTML). Exit 0 = all checks passed, exit 1 = a mismatch, exit 2 =
  usage/network error. `--expect-lineage-mismatch` is for the script's own self-test only.
- All three gates above are wired into `scripts/deploy-preview.mjs` (see above) and also runnable
  standalone for manual verification before a raw `vercel deploy`.

## What this replaces

Treat this file as authoritative over any older, vaguer description of "how deploy works" elsewhere in
the docs. If another doc's deploy description conflicts with this one, this file wins; fix the other
doc rather than trusting it.
