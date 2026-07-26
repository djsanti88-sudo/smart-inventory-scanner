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

- **Preview deploys**: manual `vercel` CLI invocation. There is no committed wrapper script yet
  (`scripts/deploy-preview.mjs` does not exist in this repo as of this writing) - a preview deploy is
  a plain `vercel deploy` run by hand. If a wrapper script is added later, it belongs here and this
  paragraph should be updated to name it.
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

## Preview environment: mock/no-login by design

Preview deployments deliberately lack `NEXT_PUBLIC_FIREBASE_*` and `AUTH_MODE` env vars. This is not
an oversight - it means every preview always runs the mock backend with no login wall, regardless of
what branch or code is deployed, so a preview link is always safe to hand out or click without
touching real Firebase data. See `FIREBASE_SETUP.md` for the corresponding one-line policy note.

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
- **Not yet built** (proposed in the post-incident "never again" decision package, not implemented):
  a fix-lineage ancestry check (would refuse a deploy candidate that doesn't descend from commits the
  owner marked "must ship"), a full env-parity diff across environments, and a post-deploy smoke
  fingerprint that hits a live URL and checks decode-ladder rung availability against a canary
  manifest. If/when these are built, this section is where they get named and linked.

## What this replaces

Treat this file as authoritative over any older, vaguer description of "how deploy works" elsewhere in
the docs. If another doc's deploy description conflicts with this one, this file wins; fix the other
doc rather than trusting it.
