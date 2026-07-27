# Release Targets

Last verified: 2026-07-26.

This file records identifiers only. It must never contain tokens, passwords, service-account JSON,
or environment-variable values.

## Canonical Targets

| System | Target |
|---|---|
| GitHub repository | `djsanti88-sudo/smart-inventory-scanner` |
| Release base branch | `master` |
| Stabilization branch | `fix/release-stabilization` |
| Vercel team | `sharpenly` (`team_SX7Ai864Cry7DL3jRq924eSE`) |
| Vercel project | `inventory` (`prj_6GqhjSjVk0C7BbyHvfcYdFAdWxZ6`) |
| Production alias | `inventory-lovat-six.vercel.app` |
| Current production deployment URL | `inventory-bfkqewgfk-sharpenly.vercel.app` |
| Stable Preview alias | `inventory-preview-sharpenly.vercel.app` |
| Firebase production project | `smart-inventory-scanner-app` |
| Firebase local/emulator alias | `demo-smart-inventory` |
| Turso database | `inventory-retail` |
| Supported Node major | 24 |

`vercel.json` intentionally disables automatic production deployment from `master`. Production
promotion is manual and requires an exact approved SHA.

## Current Release Evidence

- Production deployment ID: `dpl_1jwL8FwKDpE5CJzA83ZmqMAarY5W`.
- Current production and latest preview must be refreshed with `vercel ls inventory --scope sharpenly`
  immediately before every proof run; Vercel URLs and aliases are deployment state, not durable facts.
- At the 2026-07-26 Phase 1 gate, current production was
  `inventory-bfkqewgfk-sharpenly.vercel.app` and the newest existing preview was
  `inventory-etygvjowc-sharpenly.vercel.app`.
- Firebase authorized domains include the production aliases and stable preview alias. Random Vercel
  deployment URLs are not a supported authenticated entry point.
- The stable Preview alias currently resolves to the newest Preview deployment, but that deployment's
  public browser bundle targets the production Firebase project. This violates the mock-preview
  policy and blocks authenticated Preview testing or another Preview deployment until a separate
  Firebase preview project is provisioned and verified.
- The newest Vercel Production deployment and the public production alias currently resolve to
  different deployment IDs. Treat the alias as the customer-facing production target and test both
  URLs during release investigation until the alias is reconciled.
- Firebase Firestore and Turso deletion protection were both disabled when inventoried.

## Repository State at Stabilization Start

- `master`: `e5f01576088353922cb4524f0881378238a05b24`.
- Original working branch: `feat/teach-bot` at `118e616`.
- Original branch divergence from `master`: 282 commits behind, 27 commits ahead.
- Open conflict-marked pull requests: #11 and #3.
- Original worktree contained four untracked artifacts; it remains untouched.
- Fifteen worktrees existed before the stabilization worktree was created.

## Release Invariants

1. The tested preview SHA must equal the promoted SHA.
2. The release worktree must be clean and committed.
3. `npm run release:check` and the full release proof must pass.
4. Firebase rules/indexes must match the repository.
5. A dedicated, non-production Firebase preview must pass authenticated onboarding, scan, sync,
   history, and tenant-isolation checks.
6. The deploy card must identify the rollback deployment.
7. Production promotion requires the exact phrase `DEPLOY THIS SHA`.
