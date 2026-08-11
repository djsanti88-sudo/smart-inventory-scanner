# Product Readiness Audit and Local Blocker Triage Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit the unchanged GitHub-master SHA across Scanbin's local and cloud surfaces, locally repair only confirmed blockers in a separate patch track, and explain what improved and what still prevents production readiness.

**Architecture:** Five independent evidence lanes cover local source, GitHub, Vercel, Turso, and the shop-owner journey. The unchanged base-SHA audit and any changed local patch are separate evidence identities and receive separate verdicts. Confirmed local defects use failing-first tests and independent review; cloud mutations remain outside authority.

**Tech Stack:** Audited base Next.js 16.2.12; local patch Next.js 16.3.0; React 19.2.4, TypeScript 5, Vitest 4.1.8, Playwright 1.61.1, Firebase emulators, Turso/libSQL, GitHub CLI, Vercel CLI 58.9.1, Scanbin certification controllers, Fable 5.

## Goal and context

Scanbin needs current readiness evidence covering the source GitHub protects, the source Vercel serves, the Turso data plane, and the shop-owner journey. The starting state is split: GitHub `master` and its CI are current at `9f50440bb6a21b24efbbd03de3ad312147d1e68c`, Vercel production serves older SHA `431c66eafeeeef56c72105d813354424a929fa2c`, the original checkout is dirty, and production browser certification is blocked by missing safety prerequisites. Track A audits an unchanged detached worktree at the base SHA. Track B may prove a local patch, but cannot call that patch deployable or production-ready until the owner separately authorizes a commit and deployment. The default expected overall verdict is `NOT_PRODUCT_READY` unless production journey prerequisites are independently unblocked before Task 7.

## Evidence identities and verdicts

- `BASE_SHA_AUDITED`: proof from a second clean detached worktree at `C:\tmp\scanbin-readiness-baseline-9f50440b`, with `HEAD=9f50440bb6a21b24efbbd03de3ad312147d1e68c` and zero nonignored changes before and after each gate.
- `LOCAL_PATCH_PROVEN`: proof from `C:\tmp\scanbin-product-readiness-20260810` after local changes. Bind it to the base SHA plus a deterministic manifest containing every tracked/nonignored-untracked path, mode, Git blob hash, porcelain-v2 status, and aggregate SHA-256. This is not a deployable SHA.
- `PRODUCT_READY`: reserved for one committed and deployed SHA with all release-critical lanes and executable production customer-journey proof. This plan is not expected to reach it under the current production gates.

## Acceptance criteria

1. Every lane records exact target, SHA or deployment id, timestamp, command, exit code, redacted evidence, and interpretation.
2. The detached base-SHA worktree completes every applicable local foundation, invariant, Firebase, browser, Shop Owner, and deterministic review gate with exact totals, or each failing boundary is captured exactly.
3. GitHub current-master protection and CI are verified live and bound to exact SHAs.
4. Vercel project linkage, production deployment identity, environment-name parity, checks, and available logs are verified read-only.
5. Turso expected tables, indexes, aggregate invariants, backup evidence, and control-plane coverage are verified or explicitly `INDETERMINATE`.
6. Production certification obeys the controller. A blocked controller launches no browser and performs no authenticated workflow. Live role and tenant isolation remain `BLOCKED/INDETERMINATE` unless a safe multi-role, cross-business matrix executes against a real backend.
7. Each product-code fix has observed red-green regression proof, affected-lane proof, and independent review.
8. The final report distinguishes base-SHA, local patch, local/mock, emulator, live read-only, production preflight, and production-executable evidence, and applies the fail-closed verdict rule.

## Risk and failure modes

- A test or probe could inherit provider keys and spend money. Mitigation: controller-owned mock environments, explicit zero-paid settings, and no live/provider scripts.
- A production probe could mutate inventory or expose tenant data. Mitigation: no production browser/auth workflow while blocked; only documented unauthenticated GET/HEAD checks with no barcode payload.
- Turso metadata queries could accidentally mutate or dump real data. Mitigation: allowlisted read-only statements, aggregate-only results, no payload columns, and no restore/promotion commands.
- The dirty original checkout could be overwritten or mistaken for release truth. Mitigation: all work occurs in the two isolated audit worktrees; original repo is read-only.
- Playwright could reuse a server from another worktree. Mitigation: inspect and attribute all planned ports immediately before every browser lane, fail on any unexpected listener, and set `CI=1` so Playwright starts a fresh server.
- A green focused test could be misreported as product readiness. Mitigation: separate lane verdicts plus aggregate Scanbin and Shop Owner certification.
- Cloud state could change during the audit. Mitigation: refresh all live read-only facts immediately before the final verdict.
- Dependency audit findings could trigger unsafe bulk upgrades. Mitigation: triage reachability and fix availability; never run automatic audit fix.
- Missing observability could hide production failures. Mitigation: label absent logs/checks/metrics as an evidence gap, never infer health.

## Rollback and recovery

- Audit documents and optional local fixes exist only on `audit/product-readiness-20260810`; no commit or remote mutation occurs. The unchanged base audit runs in a separate detached worktree.
- Before each remediation, record the base SHA and full diff. A local fix can be abandoned by leaving the worktree intact for owner review; do not use destructive reset or checkout commands.
- No live Turso mutation occurs, so Turso rollback is inspection-only. Record the existing promotion/rollback identifiers without executing them.
- No Vercel or GitHub mutation occurs, so production rollback is out of execution scope. The report may name the documented rollback procedure but must not invoke it.
- If a test process fails or times out, terminate only the exact controller-owned process tree and preserve its logs/traces.

## Out of scope

- Push, PR creation, merge, commit, deploy, production promote/rollback/alias, or cloud configuration changes.
- Production credentials, QA account/tenant creation, real customer data import, production cleanup, or destructive database tests.
- Paid/live decode, benchmarks, harvesters, cloud-smoke writes, or provider-console spend reconciliation.
- Cleaning, reconciling, or moving files in `C:\Users\djsan\inventory` or any existing sibling worktree.
- Broad feature development, visual redesign, and unrelated refactoring.

## Files to touch

- New audit design: `docs/superpowers/specs/2026-08-10-full-product-readiness-audit-design.md`.
- New execution plan: `docs/superpowers/plans/2026-08-10-full-product-readiness-closure.md`.
- Checkpoint files only when evidence changes their truth: `PROGRESS.md`, `TESTING.md`, `RISK_REGISTER.md`, `REPO_HEALTH.md`.
- External artifacts only under `C:\tmp\scanbin-audits\2026-08-10-product-readiness\`.
- Product and test files remain unspecified until a confirmed defect is reproduced and added through an attacked plan amendment.
- If no existing Turso auditor satisfies Task 4, create `audit-turso-readonly.mjs` and `audit-turso-readonly.test.mjs` under the external evidence root through TDD. Do not add one-off audit tooling to the product repository.

## Cost and spend

- Product API spend budget: exactly `$0`; all paid/live provider calls are forbidden.
- Agent work uses the ChatGPT subscription through GPT-5.5 medium; report token usage if available, never invent a dollar conversion.
- GitHub, Vercel, npm advisory, and read-only Turso metadata queries are expected to have no incremental provider charge; if a tool exposes a chargeable operation, do not run it.
- True external spend, if any provider reports it, must be reconciled from that provider console. No response metadata alone is treated as wallet truth.

## Global Constraints

- Audit worktree: `C:\tmp\scanbin-product-readiness-20260810`.
- Immutable base proof worktree: `C:\tmp\scanbin-readiness-baseline-9f50440b`.
- Audit base SHA: `9f50440bb6a21b24efbbd03de3ad312147d1e68c`.
- Original checkout `C:\Users\djsan\inventory` is read-only for this plan.
- Every scan appears and counts. Identity gates never suppress quantity.
- Wrong identity is worse than unknown.
- Automated AI/provider behavior is mock-only, with paid lookups forced to zero.
- Never print secret values, credentials, cookies, emails, customer identifiers, or foreign tenant IDs. Live command output is reduced to an explicit allowlisted shape before it reaches the command ledger or reports.
- No commit, push, merge, deploy, production promotion/rollback/alias, cloud configuration mutation, production database write, real-data import, paid/live API call, credential creation, email, or publication.
- Production browser automation is forbidden unless `scanbin-shop-owner` returns `launchBrowser: true`; the current expected safe result is `false`.
- A focused or historical pass never substitutes for current aggregate proof.
- Any source remediation requires an observed failing regression test before production code changes.
- All cloud facts must be current, read-only, and bound to exact identifiers or labeled `INDETERMINATE`.
- Final verdict is fail-closed: unresolved production drift, blocked production journey, release-critical Turso uncertainty, or an uncommitted local patch means `NOT_PRODUCT_READY`.

---

### Task 1: Evidence workspace and immutable identity

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\evidence-manifest.md`
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\command-ledger.jsonl`
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\capture-tree.mjs`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: Git worktree state, local SHA, live GitHub master SHA, Vercel production deployment identity.
- Produces: one evidence root, an append-only command record, a clean detached base worktree, and deterministic local-patch identity used by Tasks 2 through 7.

- [ ] **Step 1: Create the external evidence directory**

Run:

```powershell
New-Item -ItemType Directory -Force -Path 'C:\tmp\scanbin-audits\2026-08-10-product-readiness' | Out-Null
```

- [ ] **Step 2: Record immutable identities**

Run and append redacted output to the manifest:

```powershell
git rev-parse HEAD
git status --short --branch
git ls-remote origin refs/heads/master
gh api repos/djsanti88-sudo/smart-inventory-scanner/commits/master --jq '.sha'
cmd.exe /c vercel inspect https://inventory-sharpenly.vercel.app
```

Expected starting relationship: worktree and GitHub master are `9f50440bb6a21b24efbbd03de3ad312147d1e68c`; Vercel production is `431c66eafeeeef56c72105d813354424a929fa2c`.

- [ ] **Step 3: Create the immutable base proof worktree**

After verifying the target path is absent, create a detached worktree and install the existing lockfile graph:

```powershell
git worktree add --detach 'C:\tmp\scanbin-readiness-baseline-9f50440b' 9f50440bb6a21b24efbbd03de3ad312147d1e68c
Push-Location 'C:\tmp\scanbin-readiness-baseline-9f50440b'
npm.cmd ci
Pop-Location
```

Before and after every base-SHA gate, require `git status --porcelain=v2` to produce no output.

- [ ] **Step 4: Implement the local-patch identity manifest**

Create an external Node script that runs `git status --porcelain=v2 -z` and `git ls-files -co --exclude-standard -z`, records each path's mode and `git hash-object` result, sorts paths bytewise, and hashes the canonical JSON with SHA-256. It must include deletion markers for tracked paths absent from disk. Unit-test deterministic ordering, changed content, untracked files, deletion markers, and ignored-file exclusion before using it. Do not include file contents or environment values.

- [ ] **Step 5: Record instruction reconciliation**

Append a dated checkpoint to `PROGRESS.md` listing the governing files, safety gates, adopted rules, conflicts, and exact audit resume point. Do not change product status claims beyond evidence collected in this run.

- [ ] **Step 6: Verify the worktree remains scoped**

Run:

```powershell
git status --short
git diff --check
```

Expected: only the approved audit spec, plan, progress checkpoint, and later confirmed remediation files are present. Label this tree `LOCAL_PATCH_PROVEN` only after its manifest and gates pass.

### Task 2: Local source, dependency, and deterministic proof lane

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\local-lane.md`
- Modify only if a confirmed defect requires it: exact source and matching test files named in an attacked plan amendment.

**Interfaces:**
- Consumes: the detached immutable base worktree and lockfile-installed dependencies.
- Produces: exact command results, test counts, dependency-risk triage, and confirmed local defects.

- [ ] **Step 1: Capture dependency audit without applying fixes**

Run:

```powershell
npm.cmd audit --json
```

Treat the expected nonzero exit as advisory input rather than a lane crash. Record direct versus transitive packages, affected runtime/dev scope, fix availability, and whether the vulnerable code is reachable. Do not run `npm audit fix`.

- [ ] **Step 2: Run foundation and build proof**

Run from the detached base worktree:

```powershell
npm.cmd run proof:full
```

- [ ] **Step 3: Run domain invariant proof**

Run sequentially:

```powershell
npm.cmd run test:ledger
npm.cmd run test:golden
npm.cmd run test:corpus-drift
npm.cmd run test:firebase
```

- [ ] **Step 4: Preflight ports, then run browser and customer proof**

Immediately before each browser/emulator command, inspect ports `3100`, `3200`, `3300`, `8080`, `9099`, and `4001` with `Get-NetTCPConnection` plus `Win32_Process`. Fail closed if any listener is not attributable to the command just launched. Do not kill unrelated processes. Run sequentially with `CI=1` so `reuseExistingServer` is false:

```powershell
$env:CI='1'
npm.cmd run test:e2e
npm.cmd run test:e2e:firebase
npm.cmd run qa:bots
cmd.exe /c "C:\Users\djsan\.local\bin\scanbin-shop-owner.cmd run --target local --repo C:\tmp\scanbin-readiness-baseline-9f50440b"
Remove-Item Env:CI
```

- [ ] **Step 5: Run deterministic review and release checks**

Run:

```powershell
python -m tools.fable5 doctor
python -m tools.fable5 selftest
python -m tools.fable5 review-build --gate release
npm.cmd run release:check
```

Classify release-sentinel owner-approval and rollback fields separately from source/test defects.

### Task 3: GitHub and Vercel live read-only lane

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\github-vercel-lane.md`

**Interfaces:**
- Consumes: authenticated `gh`, authenticated Vercel CLI, production alias, audit SHA.
- Produces: live branch protection, CI, PR, deployment, project, environment, checks, and log evidence.

- [ ] **Step 1: Verify GitHub source and protection**

Use authenticated read-only `gh api` calls with `--jq` projections that emit only booleans, SHA, numeric ids, status/conclusion, timestamps, check names, and repository-relative run paths. Do not emit actor objects, emails, commit messages, branch authors, or raw API responses. Do not change settings.

- [ ] **Step 2: Verify exact-SHA CI**

Record every required check for current master and production SHA, including conclusion and run URL. A branch-level green summary without matching SHA is insufficient.

- [ ] **Step 3: Verify Vercel linkage and production identity**

Run read-only commands:

```powershell
cmd.exe /c vercel --version
cmd.exe /c vercel project inspect inventory
cmd.exe /c vercel inspect https://inventory-sharpenly.vercel.app
cmd.exe /c vercel project checks inventory
node scripts/check-env-parity.mjs --env=production
```

- [ ] **Step 4: Inspect available production logs**

Record Vercel authentication as `authenticated: true/false` from command exit status only; do not capture `whoami` output. Do not capture raw production log lines. A reviewed allowlisted parser may emit only deployment id, timestamp bucket, severity, route template, status-class counts, and platform error-class counts while discarding all other fields before stdout or file output. Without that parser, record log-content observability as `INDETERMINATE` rather than inferring health.

- [ ] **Step 5: Reconcile revision drift**

Compute the Git relationship among audit SHA, current GitHub master, production SHA, and any newer deployment. State whether production is current, behind, ahead, or unrelated.

### Task 4: Turso live read-only schema and resilience lane

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\turso-lane.md`
- Create if needed: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\audit-turso-readonly.mjs`
- Create if needed: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\audit-turso-readonly.test.mjs`

**Interfaces:**
- Consumes: existing server-only Turso env names from the original authorized environment without printing their values.
- Produces: redacted schema/index/count/invariant evidence and a control-plane coverage verdict.

- [ ] **Step 1: Map expected Turso schema from code**

Read migrations, storage initializers, corpus indexes, promotion scripts, backup scripts, and env manifest. Record expected table and index names plus recovery controls.

- [ ] **Step 2: Use or add a fail-closed read-only auditor**

Prefer an existing script. If none covers the contract, build an external auditor with fixed templates only: `sqlite_schema` names, `PRAGMA table_info(<allowlisted-table>)`, `PRAGMA index_list(<allowlisted-table>)`, `PRAGMA index_info(<discovered-allowlisted-index>)`, one-row `COUNT(*)` aggregates, and `EXPLAIN QUERY PLAN` for hard-coded parameterized lookup templates. Allowlisted tables are `retail`, `tires`, `tire_part_numbers`, `canonical_tire_products`, `tire_product_part_number_aliases`, `provenance`, `decode_cache`, `decode_outcomes`, `goupc_usage`, `goupc_miss_cache`, `decode_archive`, and `ladder_kv`. Results may contain schema names and counts only, with a maximum of 500 schema rows and one row per aggregate.

First write tests that reject arbitrary `SELECT` column lists, raw rows, tenant/group identifiers, semicolons, SQL comments, stacked statements, arbitrary PRAGMAs, CTEs, `ATTACH`, `DETACH`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `UPSERT`, `VACUUM`, and `ANALYZE`. The auditor must log template ids, not SQL or parameters, and must never echo `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. Observe the tests fail before implementing it.

- [ ] **Step 3: Query metadata and aggregate invariants only**

Run against the configured Turso database without selecting raw rows or customer payload columns. Record table/index presence, aggregate counts, aggregate duplicate/orphan counts, and safe query-plan evidence. Any needed raw-row inspection is separately owner-gated and remains out of scope.

- [ ] **Step 4: Verify recovery evidence**

Inspect current backup/restore documentation and artifacts without restoring or modifying live data. Record backup freshness, restore-test recency, rollback identifiers, and gaps.

- [ ] **Step 5: Verify or fail-close the control plane**

Attempt no tool installation. If the real Turso cloud-management CLI or authenticated dashboard capability is unavailable, label organization identity, token scope, primary region, replicas, PITR/backups, and failover `INDETERMINATE` with exact next steps.

### Task 5: Production link safety and customer-journey lane

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\production-lane.md`

**Interfaces:**
- Consumes: production alias, production deployment identity, Shop Owner controller.
- Produces: safe public-surface evidence and the exact production certification gate result.

- [ ] **Step 1: Run production certification preflight**

Run:

```powershell
cmd.exe /c "C:\Users\djsan\.local\bin\scanbin-shop-owner.cmd plan --target production --confirm-production --repo C:\tmp\scanbin-product-readiness-20260810"
cmd.exe /c "C:\Users\djsan\.local\bin\scanbin-shop-owner.cmd weekly --target production --repo C:\tmp\scanbin-product-readiness-20260810"
```

Expected starting result: `BLOCKED`, `launchBrowser: false`, `liveDecode: 0`, `maxPaidLookups: 0`. Treat that result as a pass for the safety controller and a blocker for product readiness.

- [ ] **Step 2: Respect the controller decision**

If `launchBrowser` is false, do not open a production browser, log in, sign up, scan, import, reconcile, export, or learn from production observations.

- [ ] **Step 3: Run bounded unauthenticated HTTP safety checks**

Only use documented read-only GET/HEAD probes that cannot trigger decode or write state. Verify TLS, redirects, security/cache headers, route status, failed-deployment masquerade protection, and public capability/status responses. Do not send barcodes or customer data.

Label this evidence only as `public surface smoke`, `deployment fingerprint`, and `capability status`. It does not certify login, authenticated routes, customer data protection, membership, roles, or tenant isolation. Prefer the repository's host-allowlisted GET-only `scripts/smoke-fingerprint.mjs` over ad hoc endpoints.

- [ ] **Step 4: Record the executable coverage gap**

List each missing prerequisite for production journey certification and identify whether it requires local code, deployment, configuration, credentials, or owner action.

Add a dedicated final-report row: local `qa:bots:security` is mock regression evidence only; production role, membership, and cross-business isolation remain `BLOCKED/INDETERMINATE` until a safe real-backend multi-role matrix executes.

### Task 6: Confirmed-defect remediation and independent review

**Files:**
- Modify: only paths named by confirmed findings and an attacked plan amendment.
- Test: one or more exact regression files per defect.
- Modify: `docs/superpowers/plans/2026-08-10-full-product-readiness-closure.md` when adding concrete remediation tasks.

**Interfaces:**
- Consumes: confirmed defects from Tasks 2 through 5.
- Produces: minimal local fixes with red-green evidence, focused proof, risk-lane proof, independent review, and a deterministic local-patch manifest. It does not produce a deployable SHA.

- [ ] **Step 1: Rank and select findings**

Fix only confirmed defects that prevent measuring the audit or violate the core scan/count/identity/data-protection laws. Defer cosmetic, speculative, cloud-owner-gated, dependency-upgrade, and unrelated debt.

- [ ] **Step 2: Amend and re-attack the plan**

For each selected defect, add exact files, interfaces, reproduction, failing test content, minimal implementation, focused command, affected aggregate gates, and rollback. Re-run the plan attack panel before editing source.

- [ ] **Step 3: Execute strict TDD**

Observe each new regression fail for the expected reason before production code changes. Implement the smallest fix, then observe focused and neighboring tests pass.

- [ ] **Step 4: Obtain independent task review**

Provide the task brief, implementation report, and full diff package to a fresh reviewer. Resolve every Critical and Important finding before closure.

- [ ] **Step 5: Re-run affected lanes**

Re-run focused proof plus every risk lane touched by the fix. Ledger/counting changes require `test:ledger`; auth/tenancy changes require `test:firebase`; customer-flow changes require browser and Shop Owner proof. Then regenerate the deterministic local-patch manifest.

#### Attacked amendment A: Turso connection-log minimization

**Confirmed reproduction:** `src/server/upc/storage.ts` and `src/server/retail-knowledge/retailKnowledgeIndex.ts` pass the complete `TURSO_DATABASE_URL` to `console.log` after client construction. The read-only Turso auditor did not leak it, but production log collection could persist the database hostname and URL query material.

**Exact files:**

- Modify: `src/server/upc/storage.ts`
- Test: `src/server/upc/storage.test.ts`
- Modify: `src/server/retail-knowledge/retailKnowledgeIndex.ts`
- Test: `src/server/retail-knowledge/retailKnowledgeIndex.test.ts`
- Create only if both call sites need it: `src/server/tursoLogSafety.ts`

**Interfaces and invariant:** Turso client construction continues to receive the original URL and token. Success and failure logs may emit only constant backend status markers; they must not emit the URL, hostname, query string, token, or a provider exception message that can repeat those values. Connection/fallback behavior must not change.

- [ ] Add focused tests that set a sentinel URL/token and spy on both `console.log` and `console.warn`. Cover successful construction, a mocked construction failure, and a mocked retail query failure whose exception messages repeat the sentinel URL and token. Prove the joined log output contains none of the sentinel URL, hostname, query string, token, or exception message. Run the tests first and capture the expected failures.
- [ ] Make the smallest implementation change: remove the URL argument from each success log and remove provider exception text from each failure log, retaining only constant status/fallback wording. A shared constant redacted marker is acceptable if operationally useful. Do not parse or partially preserve hostnames.
- [ ] Run both focused test files, neighboring server tests, TypeScript, and the final aggregate gate. Grep the server runtime for any remaining console call that receives `TURSO_DATABASE_URL` or a variable directly derived from it.
- [ ] Rollback is file-local: retain the client-selection code and revert only the log arguments if the changed logging causes an unexpected test failure. Never restore raw URL output.

#### Attacked amendment B: production smoke-host allowlist

**Confirmed reproduction:** `node scripts/smoke-fingerprint.mjs https://inventory-sharpenly.vercel.app` exits before network access because `isAllowedDeploymentUrl` omits the current official production alias, while Vercel inspection maps that alias to the same deployment as the accepted generated hostname.

**Exact files:**

- Modify: `scripts/smoke-fingerprint.mjs`
- Test: `scripts/smoke-fingerprint.test.mjs`

**Interfaces and invariant:** Only exact Scanbin production aliases and the existing project-scoped generated-host pattern are accepted. HTTPS, no credentials, no port, and lookalike-host rejection remain mandatory. The smoke remains GET-only and does not certify authentication or tenancy.

- [ ] Add the exact official alias and its `.evil.example` lookalike to the existing allowlist test. Run the named test first and capture the expected failure for the official alias.
- [ ] Add one literal equality check for `inventory-sharpenly.vercel.app`; do not widen the regex.
- [ ] Run the complete smoke test file, then run the read-only public smoke against the official alias and record it only as public-surface/deployment-fingerprint evidence.
- [ ] Rollback is the one literal host entry plus its tests; if live Vercel inspection no longer maps the alias to this project, fail closed instead of retaining it.

#### Attacked amendment C: Playwright discovery isolation

**Confirmed reproduction:** the default `playwright.config.ts` scans all Playwright-recognized `.test.mjs` files under `e2e`. Importing `e2e/teach/knowledge.test.mjs` during Shop Owner collection overwrote six tracked `testing/app-knowledge` files with fixture content. The first baseline evidence worktree is retained dirty as proof. All intended default-browser tests currently use `.spec.ts`; Teach node tests already have the separate `npm run teach:test` lane.

**Exact files:**

- Modify: `playwright.config.ts`
- Test: `src/eval/playwrightConfigSafety.test.ts`

**Interfaces and invariant:** the default mock Playwright suite discovers only `e2e/**/*.spec.ts`. Firebase, human-bot, and Teach suites retain their dedicated configs/commands. Merely listing or running default Playwright tests must never import node:test fixtures or modify tracked knowledge.

- [ ] Add a failing config regression asserting both `testDir === "./e2e"` and `testMatch === "**/*.spec.ts"`, while preserving the existing live-suite exclusions. The pair is the discovery boundary; neither assertion alone is sufficient.
- [ ] Add `testMatch: "**/*.spec.ts"` to the default config. Do not exclude the actual Boss UI `.spec.ts`; its private-corpus prerequisite remains a separate certification input.
- [ ] Run the focused config test, `npx playwright test --list`, prove the listing contains zero `e2e/teach/*.test.mjs` entries, and compare `git status --porcelain=v2` before/after. Then run the default mock browser suite during aggregate proof.
- [ ] For final Shop Owner proof, source `BOSS_RECONCILIATION_PATH` into the controller process without printing its value when the already-authorized local private source exists. Record only `BOSS_RECONCILIATION_PATH_present=true/false` and `BOSS_RECONCILIATION_PATH_exists=true/false`. If both are true, the final Shop Owner report must show the Boss UI test is not skipped or the lane remains blocked. If absent, preserve the skip and label private-corpus UI proof blocked; never substitute a synthetic source or claim certification.
- [ ] Rollback is the single `testMatch` field and regression assertion. Keep the original dirty evidence worktree untouched; validate the fix only in the patch worktree or a new clean detached proof tree.

#### Diagnostic finding D: baseline proof resource contention

The first successful absolute-launcher `proof:full` attempt reached Vitest but ended with one timing-sensitive DOM assertion plus 23 worker-start timeouts. The named DOM test passed immediately in isolation. Before the exact aggregate rerun, record the Node/Vitest/Next/Playwright process inventory and planned ports and prove there is no overlapping proof process. Treat the first result as a suite/resource diagnosis, not a product-code defect, only until that clean rerun. If the unmodified default aggregate fails again under clean-process conditions, it becomes a current aggregate blocker. Do not weaken assertions or silently lower canonical coverage. A lower-worker run may be used only to diagnose machine pressure; it cannot support a release or local-patch green claim. The final release claim still requires the repository's unmodified aggregate command or an explicitly reviewed configuration fix.

#### Deferred finding E: dependency advisories

The clean base lockfile reports 14 advisories: 6 high, 8 moderate, 0 critical. Before changing dependencies, record every advisory id and primary source, vulnerable package, direct/transitive parent, installed and fixed versions, dev/build/runtime reachability, exploit preconditions, and verdict; read the relevant installed Next.js 16 guide and primary advisory/release sources; and run a dry-run resolution. Any lockfile/package update becomes its own failing/security-reproduction or advisory-removal wave with build, unit, browser, Firebase, and Shop Owner proof; never run automatic `npm audit fix` or accept a forced major downgrade. Any unresolved production-runtime-reachable High advisory, or any advisory whose reachability remains unknown after reasonable inspection, blocks `PRODUCT_READY` and must appear as a final-report security finding. A dry-run resolution alone is not safety proof.

#### Attacked amendment F: non-major dependency security update

**Confirmed reproduction and reachability:** the clean lockfile installs `next@16.2.12` with vulnerable `postcss@8.4.31` and `sharp@0.34.5`. The audited registry metadata for stable `next@16.3.0` declares `postcss@8.5.23` and optional `sharp@^0.35.3`, which meet the current advisory patched versions. PostCSS is build-path reachable; sharp is production image-processing code and the advisory applies when untrusted images are processed, so the unresolved High chain blocks readiness even though no exploit was attempted. The installed Next.js 16 upgrade guide has been read in full. The same audit reports patchable transitive findings in `brace-expansion`, `js-yaml`, `nanoid`, and `dompurify`; their fixed releases fit the existing parent ranges. Remaining Firebase Admin/Google Storage/ExcelJS `uuid` advisories have no safe non-major parent resolution and must be reachability-triaged rather than forced to old parent versions.

**Exact files:**

- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces and invariant:** keep React/React DOM at the current compatible 19.2 release; align `next` and `eslint-config-next` at stable `16.3.0`; retain `npm ci` determinism; do not add overrides, change package managers, run an automatic audit fix, or accept a major downgrade. Product behavior and API contracts must remain unchanged.

- [ ] Before mutation, prove and record the Windows toolchain without secrets: `Get-Command npm.cmd -All`, `where.exe npm.cmd`, `node --version`, and `& 'C:\Program Files\nodejs\npm.cmd' --version`. Every npm command in this wave must use the absolute launcher `C:\Program Files\nodejs\npm.cmd` (or the equivalent direct global `npm-cli.js`), never a bare `npm.cmd` launched through `.NET ProcessStartInfo`.
- [ ] Preserve RED evidence from the exact base lockfile: `npm audit --json` reports 14 findings including the direct Next chain, and `npm ls` proves the installed vulnerable descendants. Record primary advisory ids and fixed versions without executing exploit payloads.
- [ ] Require `package.json` and `package-lock.json` to be unchanged before this wave. Run `& 'C:\Program Files\nodejs\npm.cmd' install next@16.3.0 eslint-config-next@16.3.0 --save-exact --package-lock-only`, then `& 'C:\Program Files\nodejs\npm.cmd' update brace-expansion js-yaml nanoid dompurify --package-lock-only`. Assert `package.json` changed only the `next` and `eslint-config-next` versions; reject new direct dependencies, `overrides`, audit configuration, package-manager changes, unrelated top-level version changes, or forced downgrades.
- [ ] Assert every vulnerable resolved path was updated, not merely a root package name: `next@16.3.0`; `next/node_modules/postcss@8.5.23`; `sharp>=0.35.0`; all installed `brace-expansion` 1.x/2.x/5.x paths at `>=1.1.18`, `>=2.1.4`, and `>=5.0.9`; `js-yaml>=4.3.1`; `nanoid>=3.3.17`; and `dompurify>3.4.12`.
- [ ] Create a new detached exact-base proof worktree, reproduce only the reviewed package/lock diff into it, and run `& 'C:\Program Files\nodejs\npm.cmd' ci --ignore-scripts=false`. Re-run the resolved-version assertions and `npm audit --json`, then repeat `npm ci` and prove both `package-lock.json` and the deterministic tree manifest are unchanged. Expected security delta: zero High/Critical findings from Next/PostCSS/sharp and the patchable transitive set. Any residual advisory receives an explicit reachability/verdict row; do not call the dependency lane green merely because totals fell.
- [ ] Run focused config/server/smoke tests, TypeScript, the full `npm run lint` gate, CI's production-source lint command (`npx eslint src --ignore-pattern "**/*.test.ts" --ignore-pattern "**/*.test.tsx" --ignore-pattern "**/*.test.mjs"`), `proof:full`, browser mock, Firebase, and Shop Owner/certification aggregates. Because `eslint-config-next` itself changes, a path-scoped lint pass is insufficient. A stable minor update that fails any required behavior is reverted as a package/lock pair and remains a readiness blocker.
- [ ] Independent review must verify the package pair, resolved nested versions, installed Next guide compatibility, audit interpretation, and that no advisory was hidden with `overrides`, omission flags, or audit configuration.

#### Attacked amendment G: asynchronous DOM aggregate stabilization

**Confirmed reproduction:** under the unmodified full Vitest aggregate, `LiveScanFeedSuggestion.test.tsx` exhausted the default short `vi.waitFor` window before the mocked decode attached a pending suggestion, and `scanFocus.test.tsx` asserted the async Needs Review enqueue immediately after Enter. The exact two files passed together five consecutive times in isolation, so there is no reproduced product-state failure; the aggregate RED proves their synchronization contracts are too weak under normal suite contention.

**Exact files:**

- Modify: `src/components/LiveScanFeedSuggestion.test.tsx`
- Modify: `src/components/scanFocus.test.tsx`

**Interfaces and invariant:** do not change product code, global Vitest workers, suite coverage, or assertion meaning. Tests must wait for the same observable store states they already require, using bounded five-second polling that remains far below the repository's 30-second test timeout. Focus and count/identity assertions remain intact.

- [ ] Preserve the full-aggregate failures as RED evidence and the five isolated passes as proof of load-sensitive synchronization rather than a deterministic product failure.
- [ ] In both suggestion approve/decline flows, keep the existing pending-status assertion but give `vi.waitFor` an explicit 5,000 ms timeout. In the unknown focus test, preserve an immediate focus assertion directly after Enter, then use Testing Library `waitFor` with the same timeout only around the Needs Review assertion, then assert focus again after the wait. This prevents async polling from masking a scanner-focus regression.
- [ ] Run both files together five times, then rerun the exact unmodified `proof:full`. If the aggregate fails again in either case, this amendment fails and the aggregate remains blocked; do not keep increasing timeouts or reduce workers.
- [ ] Independent review must confirm only polling bounds/imports changed, the assertions were not weakened, and no production code or global concurrency setting changed.

#### Attacked amendment H: deterministic Vitest aggregate worker bound

**Confirmed reproduction:** two exact `npm run proof:full` attempts on otherwise idle Scanbin proof ports failed with broad, unrelated Vitest worker-start and per-file timeouts while the machine hosted more than 200 unrelated Node processes. The count-integrity `sessionRotationSyncSafety.store.test.ts` then passed 10/10 in isolation. Without changing the test set, assertions, or timeouts, the matching diagnostic `npx vitest run --maxWorkers=4` passed 446 files with 4,120 tests (14 files and 105 tests skipped by their existing contracts). This proves uncontrolled worker pressure is the reproduced aggregate failure mechanism; the diagnostic itself is not release proof.

**Exact files:**

- Modify: `vitest.config.ts`
- Create: `src/eval/vitestConfigSafety.test.ts`

**Interfaces and invariant:** pin only root `test.maxWorkers` to `4`. Both projects must continue to inherit the root via `extends: true`; neither project may define its own worker override. Project names, environments, include/exclude/setup lists, root 30-second test/hook timeouts, coverage, and assertions remain unchanged.

- [ ] Add an exact failing config regression that asserts root `maxWorkers === 4`, root timeouts remain `30000`, both projects retain `extends: true`, neither project nor its nested `test` object defines `maxWorkers`, and the existing project names/environments/include/exclude/setup arrays are byte-for-byte semantically unchanged.
- [ ] Preserve that RED result, then add only `maxWorkers: 4` to the root `test` block in `vitest.config.ts`. Run the focused config test and confirm the existing config-safety test remains green.
- [ ] Rerun the exact unchanged `npm run proof:full`. Only that canonical command on the final tree can clear the aggregate blocker; the diagnostic CLI override may not be cited as a release green.
- [ ] If the exact command still fails, keep the aggregate blocked and diagnose the remaining failing contract. Do not reduce coverage, add project-specific worker overrides, increase global/file timeouts, or kill unrelated owner processes.
- [ ] Independent review must verify inheritance semantics and the exact regression assertions, and confirm the diff contains no product-code or coverage-boundary change.

#### Attacked amendment I: Firebase History readiness synchronization

**Confirmed reproduction:** the emulator-backed browser journey completed real Auth-emulator sign-in, business provisioning, scanning, queue drain, approval, rescan, and survive-refresh assertions, then hard-navigated to `/history`. The captured failure screen showed the fail-closed `BusinessContextGate` state `Loading business data...`; the default five-second `history-table` assertion expired before the independently bounded Firebase bootstrap/data-loader contract completed. Lower-level Firebase rules/sync proof remained green at 132/132. No missing count or wrong-tenant row was observed.

**Exact files:**

- Modify: `src/stores/scanStore.ts`
- Test: `src/stores/refreshWipe.store.test.ts`
- Modify: `e2e/firebase-phase2/firebase-flow.spec.ts`

**Interfaces and invariant:** a same `(businessId, userId)` re-entry whose business data is already loaded must keep the already-safe same-tenant UI visible while a background refresh runs. A real tenant/user switch must still clear state and block children until its own data loads. Global test timeouts remain unchanged. The browser test may wait up to 90 seconds for exactly one of the real History readiness surfaces: `history-table` or `business-context-error`; a surfaced error must fail immediately and diagnostically. All row, four-scan, session-detail timeline, unknown-code, direct Admin SDK persistence, and audit assertions remain intact.

- [ ] Preserve the five-second History RED, screenshot, and error context. Do not reinterpret it as lost data without evidence.
- [ ] Add a failing store regression: after the same tenant has completed its initial load, make the next loader call stay pending, re-enter the same context, and prove `businessDataLoaded` remains true and the existing scan/count rows remain visible. Retain the separate tenant-switch tests that require a clean blocked state.
- [ ] Change only the same-tenant branch to preserve an already-true `businessDataLoaded` value while the background loader runs (`contextState.businessDataLoaded || !needsLoad`). Do not change bootstrap, placeholder adoption/rescope, genuine tenant switch, generation guards, or loader merge behavior.
- [ ] After `page.goto("/history")`, wait on the union of `history-table` and `business-context-error` for at most 90 seconds to cover a genuine cold load. If the error surface wins, throw a clear test failure before continuing; otherwise retain the ordinary visible-table assertion.
- [ ] Rerun the complete `npm run test:e2e:firebase` controller. It must finish all browser assertions and direct emulator-state assertions; an isolated History-table appearance is insufficient.
- [ ] Rerun same-tenant refresh, tenant-switch, Firebase rules/sync, aggregate, and ledger gates. Independent review must confirm the error branch cannot pass and no persistence, row-count, tenant, timeline, paid-provider, audit, or isolation assertion was weakened.

### Task 7: Final review, aggregate certification, and report

**Files:**
- Create: `C:\tmp\scanbin-audits\2026-08-10-product-readiness\FINAL-REPORT.md`
- Modify: `PROGRESS.md`
- Modify when proof changes: `TESTING.md`, `RISK_REGISTER.md`, `REPO_HEALTH.md`

**Interfaces:**
- Consumes: all lane reports, raw evidence, final diff, and exact cloud state.
- Produces: final readiness verdict, improvement narrative, blockers, and resume/deployment handoff.

- [ ] **Step 1: Run final whole-branch review**

Give an independent reviewer the complete base-to-head diff, local-patch manifest, evidence manifest, and deferred findings. Fix any confirmed Critical or Important code defect through one final failing-first wave. Regenerate the local-patch manifest after the final reviewed change.

- [ ] **Step 2: Select and run the canonical aggregate gate**

If no product/test files changed after the base-SHA lane, reuse that current-tree aggregate evidence and do not repeat it. If product/test files changed, run exactly one final aggregate sequence on the local-patch tree: `npm.cmd run qa:revision`, then the two controllers below. Earlier runs remain diagnostic/focused evidence.

- [ ] **Step 3: Run full local certification**

Run:

```powershell
cmd.exe /c "C:\Users\djsan\.local\bin\scanbin-certify.cmd -Repo C:\tmp\scanbin-product-readiness-20260810 -Mode full"
```

Record controller state and run directory. `CERTIFIED_LOCAL` never means production-certified.

- [ ] **Step 4: Re-run Shop Owner local certification**

Run the complete controller-owned local suite and record `suiteClean`, `coverageGaps`, and overall `certified` separately.

- [ ] **Step 5: Refresh live read-only state**

Re-query GitHub master/CI/deployments, Vercel production identity/env-name parity/log availability, Turso safe metadata, and production preflight immediately before the verdict.

- [ ] **Step 6: Write the final report**

The report must include:

```text
Executive verdict
Base-SHA, local-patch-manifest, GitHub, Vercel, and production identity matrix
Evidence matrix with environment, auth mode, data plane, paid-provider exposure, tenant scope proved, role scope proved, and allowed conclusion
What improved, how, and why
Critical/High/Medium/Low findings
Local proof table
GitHub proof table
Vercel proof table
Turso proof table
Production journey proof and gaps
Live role and tenant isolation status
Dependency vulnerability triage
Known limitations and indeterminate controls
Owner-gated next actions in exact order
Commands, timestamps, artifacts, and rollback notes
```

- [ ] **Step 7: Verify report integrity**

Confirm every positive claim has a fresh artifact, every blocker has exact reproduction/evidence, secrets are absent, and the final verdict follows the fail-closed rule.
