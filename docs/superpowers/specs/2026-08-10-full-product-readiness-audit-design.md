# Full Product Readiness Audit Design

## Goal

Determine whether the unchanged GitHub-master Scanbin revision and the older production revision are safe and usable for a shop owner, close locally reproducible release blockers in a separately identified patch track, and produce one evidence-backed report covering local, Turso, Vercel, GitHub, and the production customer journey.

## Starting facts

- The audit worktree starts at GitHub `master` SHA `9f50440bb6a21b24efbbd03de3ad312147d1e68c`.
- The current Vercel production alias serves SHA `431c66eafeeeef56c72105d813354424a929fa2c`, two commits behind that GitHub revision.
- GitHub CI and Playwright are green at `9f50440bb6a21b24efbbd03de3ad312147d1e68c`.
- The original checkout remains dirty on `fix/atomic-daily-cap-increment` and is outside the audit write scope.
- Production Shop Owner certification is fail-closed with `launchBrowser: false` because the allowlist, dedicated QA credentials, server free-only capability, strict-login harness, and identity/tenancy fingerprints are incomplete.
- Vercel CLI `58.7.0` is installed and authenticated.
- The installed `turso` executable is the interactive SQL shell, not the Turso cloud-management CLI.
- Lockfile installation currently reports 14 vulnerabilities: 8 moderate and 6 high.

## Audit architecture

The audit has five evidence lanes and three distinct verdict identities:

1. Local immutable source and full offline/mock proof.
2. GitHub source, protection, CI, pull request, and deployment-record truth.
3. Vercel project linkage, production deployment, environment-name parity, logs, checks, and safe HTTP smoke truth.
4. Turso runtime schema/invariant truth plus an explicit control-plane evidence gap when replica and token-scope metadata cannot be queried.
5. Shop-owner customer-journey certification, split into local executable proof and production fail-closed preflight.

Each lane records the command, timestamp, exact SHA/target, exit code, redacted output, and interpretation. `BASE_SHA_AUDITED` applies only to an unchanged detached base worktree. `LOCAL_PATCH_PROVEN` binds changes to a deterministic file/blob manifest and is not deployable. `PRODUCT_READY` requires one committed and deployed SHA plus production-executable proof. A green lane cannot compensate for a red or indeterminate release-critical lane.

## Remediation model

No product code changes are assumed in advance. A confirmed defect enters a failing-first remediation loop:

1. Reproduce it on the immutable audit worktree.
2. Add the smallest regression test and observe the expected failure.
3. Implement the smallest safe fix.
4. Re-run focused proof, affected risk-lane proof, and aggregate certification.
5. Obtain independent diff review.

If a finding changes product direction, cost, production risk, or approved scope, execution stops for owner direction. Otherwise the plan may be amended and re-attacked without another routine approval.

## Safety boundaries

- Every physical scan must remain visible and counted regardless of identity outcome.
- Wrong identity is worse than unknown.
- No push, merge, commit, deploy, production promote/rollback/alias, production configuration mutation, production database write, real-data import, credential creation, paid/live provider call, email, or publication is authorized.
- Production browser automation remains prohibited while the deterministic controller returns `launchBrowser: false`.
- Read-only production HTTP requests must not authenticate, mutate state, invoke paid decode, or include customer identifiers.
- Secrets, tokens, cookies, emails, tenant IDs, raw customer rows, and environment values never enter reports.
- The original checkout and all existing worktrees remain untouched.

## Acceptance criteria

1. The audit binds all evidence to exact local, GitHub, Vercel, and production SHAs.
2. The clean GitHub-master worktree completes the planned local gate battery with exact pass/fail totals.
3. GitHub protection and current-master CI are verified live through authenticated read-only queries.
4. Vercel deployment identity, env-name parity, checks, and available logs are verified without changing the project.
5. Turso expected tables, indexes, counts, and read-only invariants are compared with code expectations without dumping customer rows.
6. Turso organization, primary region, replicas, backups, and token scope are either verified or labeled `INDETERMINATE` with the exact missing capability.
7. The production Shop Owner controller result is preserved exactly. No browser launches while it is blocked.
8. Every confirmed code defect fixed in this run has observed red-green regression proof and independent review.
9. Full local Scanbin certification and Shop Owner certification run after the final local change.
10. The final report ranks blockers by severity and reach, explains what improved and why, and distinguishes local/mock, live read-only, production preflight, and untested evidence.

## Product-ready verdict rule

`PRODUCT_READY` requires all release-critical lanes to pass against one committed and deployed SHA and requires executable production customer-journey evidence. The expected result of this plan is `NOT_PRODUCT_READY` unless the owner separately unblocks the production prerequisites. If production remains behind, the production controller remains blocked, live role/tenant isolation is unproven, the local result is only an uncommitted patch manifest, or Turso release-critical controls remain indeterminate, the verdict is `NOT_PRODUCT_READY` even when local tests and GitHub CI are green.

## Out of scope

- Shipping any fix.
- Changing production or cloud configuration.
- Creating production QA users or tenants.
- Running paid decode or live data-import campaigns.
- Treating dependency audit output alone as proof of exploitability.
- Cleaning or reconciling the owner's original dirty checkout.
