# Inventory Stabilization Phase 1 Report

Date: 2026-07-26

## Outcome

Phase 0 and the local Phase 1 gate are complete. Phase 2 authenticated preview proof starts after
this exact change set is committed. Phases 3 through 6 have not started.

No commit, push, deployment, paid/live provider call, production data write, or production
configuration change was made.

## Worktree

- Path: `C:\tmp\inventory-stabilization`
- Branch: `fix/release-stabilization`
- Base: `master` at `e5f01576088353922cb4524f0881378238a05b24`
- Original dirty worktree: preserved and untouched

## Implemented

### Authentication and provisioning

- Verified Firebase bearer-token provisioning route.
- Atomic, idempotent business and owner-membership provisioning.
- One repairable flow for signup, password login, and Google login.
- Safe Firebase error-code mapping.
- Explicit business selection for ambiguous membership.
- Orphan membership filtering and parent-business name resolution.
- Opaque, independent pending named-business requests.
- Login and business-selection recovery states.

### Sync and tenant isolation

- Deterministic safe applied-key document IDs with legacy compatibility.
- Canonical payload hashing and full marker-envelope validation.
- Terminal idempotency-conflict handling.
- Duplicate scan-event no-op behavior.
- Tenant-partitioned pending queues.
- Stale drain and stale loader protection.
- Immediate tenant-visible state reset on context switch.
- Active-tenant filtering in sync and export UI.

### Firestore authorization

- Parent business existence required for membership access.
- Counter product creation limited to provisional, unverified products.
- Counter session writes limited to the user's active, unlocked session.
- Counter scan, review, and count writes tied to that session.
- Count transitions require a matching applied marker, exact delta, and append-only scan-event IDs.
- Owner/admin trusted-catalog capabilities remain separate from counter capabilities.

### Local environment

- Browser Firebase SDK and Admin SDK emulator variables are configured together.
- Firebase test command includes both Auth and Firestore emulators.
- Firebase Playwright configuration uses the emulator development command.

## Independent Security Review

The first whole-change review found one Critical and two High defects. All three have local fixes
and regression tests:

| Severity | Finding | Repair |
|---|---|---|
| Critical | Admin could self-promote to owner or remove the real owner | Member identity is immutable; owner memberships are server-managed; admins manage non-owner roles only; business `createdBy` is immutable |
| High | A foreign account could preclaim a predictable provisioning ID | Business creation is server-only; existing targets must belong to the verified UID; default and named requests converge on a fresh transaction-persisted fallback |
| High | Counter could forge counts without real scans | Counter count writes require a matching same-session, same-product `+1` scan event; duplicate events remain zero-delta no-ops |

The owner/admin count path remains separate so authorized maintenance transfers and corrections are
not forced into the counter `+1` contract.

## Verification

| Gate | Result |
|---|---|
| Non-incremental TypeScript | Passed |
| Ledger | 45/45 passed |
| Post-review provisioning | 15/15 passed |
| Post-review focused auth/provisioning | 69/69 passed |
| Post-review focused sync/tenant | 27/27 passed; 13 emulator cases skipped |
| Store regression suite | 532/532 passed |
| Sign-out/orphan UI | 12/12 passed |
| Emulator environment helper | 2/2 passed |
| Final Auth + Firestore emulator sweep | 95/95 passed |
| Full corpus-backed proof | 365 files passed; 3,472 tests passed; 59 intentionally skipped |
| Next.js production build | Passed |
| Changed-file lint | Zero errors; two existing warnings |
| `git diff --check` | Passed |

The 88 full-suite failures cascade from the generated SQLite corpus being unavailable in the
isolated worktree. The full lint baseline contains 46 unrelated pre-existing errors.

## Environment Repair

The generated corpus and fixtures were restored with `node scripts/provision-worktree.mjs`. The
official Firebase CLI was installed and the final emulator suite passed. The worktree's external
`node_modules` junction caused a Next 16 Turbopack build failure, so it was replaced with a local
`npm ci` install. The build now passes. npm audit reports 16 existing dependency findings; no
dependency versions were changed during this stabilization phase.

## Resume Order

1. Commit Phase 0 and Phase 1 with the passing local proof.
2. Create a preview from that exact SHA.
3. Refresh Vercel inventory and test the newest preview, not an older alias.
4. Begin Phase 2 stable-preview proof on that exact committed SHA.

Production promotion remains separately gated by the exact phrase `DEPLOY THIS SHA`.
