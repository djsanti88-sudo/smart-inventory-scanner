# Inventory Stabilization and Recovery

**Goal:** Make authentication, cloud persistence, saved sessions, and releases dependable before
consolidating the repository and promoting a new production deployment.

**Execution model:** One coordinator plus up to three parallel low-tier execution workers. Workers
edit disjoint files, write failing-first tests, run focused gates, and do not commit. The coordinator
reviews every diff and runs the combined phase gates.

## Global Constraints

- Every scan appears and counts immediately. Identity work must never suppress a scan or quantity.
- Retry is a no-op after the first successful cloud application.
- Tenant data and pending operations never cross business boundaries.
- Do not push, deploy, call paid/live APIs, mutate production data/configuration, or rotate credentials
  without the action-specific owner gate.
- Preserve existing customer records and existing safe applied-key document IDs.
- Implement from `master` in the isolated `fix/release-stabilization` worktree. Do not modify or clean
  the owner's dirty `feat/teach-bot` worktree.

## Phase 0 - Safe Base

- Record the canonical repository, branch, Vercel project/domains, Firebase project, Turso database,
  Node version, current production deployment, and rollback target.
- Inventory branches, worktrees, PRs, unique commits, and untracked artifacts without deleting them.
- Gate: clean stabilization worktree and a release-sentinel run with no dirty-tree blocker.

## Phase 1 - Authentication and Persistence

### Track A - Cloud sync

- Add a deterministic applied-key document-ID helper. Preserve valid keys; SHA-256 map keys containing
  `/`, reserved IDs, or more than 1,500 UTF-8 bytes.
- Sanitize foreign-business queue items during every context resolution and at the cloud drain.
- Reject malformed entity/payload IDs with structured errors.
- Tests: unsafe and oversized keys, retry/concurrency, legacy-key compatibility, same-tenant refresh,
  stale demo queue, and malformed products.

### Track B - Provisioning and auth UX

- Add an authenticated Node route for idempotent, atomic default-business and owner-membership
  provisioning. Derive UID from a verified Firebase ID token.
- Route signup, password login, and Google login through the same repairable provisioning flow.
- Separate account creation from workspace setup failure and provide a retry path.
- Map Firebase error codes to safe user messages.
- Tests: fresh signup, password-login repair, concurrency, partial failure, safe error mapping, and UI
  recovery.

### Track C - Rules and roles

- Permit counters to create only provisional, unverified products and their own active count sessions.
- Keep trusted product mutation, alias creation, verification, and session administration restricted
  to owner/admin.
- Add Firebase emulator coverage for owner/admin/counter behavior and tenant isolation.

**Phase gate:** `npm run test:ledger`, `npm run test:firebase`, and `npm run proof:full`.

## Phase 2 - Stable Preview Proof

- Use `inventory-preview-sharpenly.vercel.app` as the only authenticated preview entry point.
- Prove fresh password and Google onboarding, a tire-heavy 30-code scan, queue drain, count equality,
  refresh/browser restart, completed-session history/reopen, second-user isolation, and counter flow.
- Random Vercel URLs receive only unauthenticated smoke tests.
- Gate: one exact preview SHA passes with no Firebase authentication or permission errors.

## Phase 3 - Repeatable Releases

- Standardize Node 24 locally, in package metadata, GitHub Actions, and Vercel.
- Add required parallel CI gates for static checks, unit/ledger, Firebase emulator, mock Playwright,
  production build, release sentinel, and secret scanning.
- Automate stable-preview alias movement with rollback and read-only Firebase authorized-domain
  preflight.
- Validate environment-variable names/scopes without printing values.
- Expand release-sentinel external facts and isolate the development share-token filesystem fallback
  so production bundles Turso storage only.

## Phase 4 - Repository Reconciliation

- Classify all branches and worktrees as merged, unique, superseded, or unknown.
- Port only reviewed work onto a current-master integration branch.
- Resolve or close conflict-marked PRs with a written disposition.
- Archive unique work before removing worktrees; never delete unclassified work.
- Update architecture, commands, Firebase, go-live, and progress documentation.

## Phase 5 - Data Protection

- With explicit owner approval, enable Firestore and Turso deletion protection.
- Create Firebase/Turso/decode-cache backups and prove restore into disposable targets.
- Verify rules/index drift, credential scope, stale environment variables, and secret-free artifacts.

## Phase 6 - Production Promotion

- Produce a deploy card with exact SHA, preview proof, backups, rollback deployment, and limitations.
- Require the explicit phrase `DEPLOY THIS SHA`.
- Promote the already-tested deployment, run a bounded smoke test, and monitor auth, Firestore
  permission errors, queue failures, API errors, and decode spend.

## Acceptance Criteria

- Google and password login work with user-safe errors.
- Fresh users receive exactly one usable business.
- Thirty scans produce exactly thirty durable counts.
- The cloud queue drains without permission errors or cross-tenant writes.
- Completed sessions survive refresh, new browser login, and history reopen.
- Required CI passes on Node 24, the tested SHA equals the release SHA, and rollback is verified.

