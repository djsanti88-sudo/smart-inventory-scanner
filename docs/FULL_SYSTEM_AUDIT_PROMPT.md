# Full-System Audit Prompt (reusable, read-only)

Paste the block below as one message when you want a complete audit of Scanbin.
It is designed to prove local, GitHub, deployment, and infrastructure truth without
changing source code or any remote system.

---

**MISSION**

Run a complete, read-only, adversarially verified audit of the Scanbin system. Prove
whether the authoritative local checkout, all local work, GitHub, CI, Vercel deployments,
Firebase configuration, and Turso state agree. Audit product correctness, security,
operational readiness, cost exposure, and resistance to app cloning or data extraction.
Return one ranked report. Do not fix anything during this audit.

**READ-ONLY CONTRACT**

- Do not edit source, configuration, documentation, Git metadata, branches, commits,
  stashes, tags, worktrees, dependencies, lockfiles, cloud configuration, accounts, data,
  rules, domains, aliases, deployments, or billing settings.
- Do not run `git fetch`, `git pull`, checkout, reset, clean, stash, worktree creation, or
  any command that changes `.git`. Query live GitHub state through read-only GitHub API,
  MCP, or `gh` calls instead of refreshing remote refs.
- Do not push, open or modify PRs, deploy, promote, roll back, send messages, import data,
  call paid AI providers, run live decode, or execute production writes.
- Read-only network and control-plane queries are allowed for GitHub, Vercel, Firebase,
  package advisories, and Turso. A read must not change configuration or data.
- Turso access is limited to bounded `SELECT`, `EXPLAIN`, and `PRAGMA` queries. Prefer
  schema, counts, constraints, and aggregate integrity checks. Do not dump row-level
  customer data, barcodes, prices, PII, tokens, or proprietary corpus contents.
- Firebase access is limited to project metadata, auth configuration, deployed rules,
  indexes, and bounded aggregate metadata that does not expose customer documents. If a
  conclusive data check would incur material billed reads or reveal customer data, mark it
  `NEEDS OWNER APPROVAL` and do not run it.
- Never print, copy, store, or send secret values. Report only the variable or credential
  name, scope, existence, exposure path, and a masked fingerprint if essential.
- The only allowed persistent output is the final audit report outside the repository at
  `C:\tmp\scanbin-audits\SYSTEM_AUDIT_<YYYY-MM-DD>_<run-id>.md`. Also provide the summary
  in chat. Do not save the report inside the repository because that would change the
  synchronization result.
- Ephemeral verification output is allowed only in a new, dedicated directory under
  `C:\tmp\scanbin-audits\<run-id>\`. Redirect caches and test artifacts there when
  possible. If a test or review tool would write anywhere else, skip it and record the
  coverage gap. Never delete or alter a pre-existing directory.

**PHASE 0: IDENTITY, ACCESS, AND BASELINE PREFLIGHT**

Before inspecting findings:

1. Record timestamp and timezone, operating system, canonical repository path, current
   branch, local HEAD SHA, configured remotes, and default GitHub repository/branch.
2. Prove which checkout is authoritative. Inventory every linked worktree and any other
   plausible Scanbin checkout. Do not assume the starting directory is authoritative.
3. Capture the baseline with read-only Git commands using `--no-optional-locks` where
   supported: tracked modifications, staged changes, untracked paths, ignored-path
   summary, branches, upstreams, tags, stashes, submodules, and Git LFS state. Never print
   secret or customer-data file contents.
4. Preflight each audit tool and its authenticated identity: GitHub, Vercel, Firebase,
   Turso, Node/npm, test tools, browser tools, and any specialist-agent runner. CLI
   installation alone is not authentication proof. Confirm that `turso` is the Turso
   cloud-management CLI with `auth`, `db`, and organization commands, not the separate
   local Turso interactive SQL shell (`tursodb`).
   Never run an authentication command or JSON mode that returns access tokens, refresh
   tokens, ID tokens, cookies, or credential payloads. In particular, do not run
   `firebase login:list --json`. Use the redacted Firebase MCP environment summary or a
   plain-text identity command that has been proven not to emit credentials.
5. Resolve exact targets before querying them: GitHub owner/repository, Vercel team and
   project, Firebase project ID and alias, and Turso organization/database. Do not rely on
   a CLI's inherited active project when production is one of the configured targets.
6. Build an access matrix with `AVAILABLE`, `MISSING`, `AUTH BLOCKED`, or `WRONG TARGET`.
   Continue independent lanes when access is missing. Mark affected conclusions
   `INDETERMINATE`; never convert missing access into a pass.
7. If any target identity is ambiguous, stop only that lane and ask the owner. Do not
   guess a repository, project, database, deployment, account, or organization.

**SYNC TRUTH STANDARD**

Produce a synchronization matrix before the findings report. Each row must be
`MATCH`, `MISMATCH`, or `INDETERMINATE`, with exact SHAs, timestamps, and evidence:

- Authoritative local checkout and current branch.
- Tracked working tree, staged changes, untracked work, ignored sensitive files.
- Every worktree, local branch, detached HEAD, stash, and local-only commit.
- Live GitHub default branch and all relevant remote branches.
- Open PR head/base SHAs, mergeability, reviews, and required check results.
- Latest successful CI SHA versus GitHub default-branch SHA.
- Vercel production deployment SHA versus the intended GitHub production SHA.
- Relevant Preview deployment SHA versus its PR or branch SHA.
- Runtime fingerprint or version endpoint versus Vercel deployment metadata.
- Firebase deployed rules/indexes/configuration versus repository source hashes.
- Turso schema version and integrity invariants versus repository expectations.
- Generated corpus/database artifacts versus their tracked generators and source inputs.

Do not call the system "synced" merely because local `HEAD` equals a cached
`origin/master`. Live remote truth and deployed runtime truth must be independently
verified. Classify intentional local-only work separately from accidental unsynced work.

**EXECUTION AND VERIFICATION MODEL**

- Use parallel specialist agents when available, one per independent lane. Use only
  subscription or OAuth-backed agent execution already authorized by the owner. Never
  fall back to an API key or metered provider without current-session approval.
- Model names are preferences, not requirements. Use the best available authorized
  agents and record what actually ran. Missing providers are a coverage note, not a
  reason to invent verification.
- Maintain one candidate-findings ledger. Each candidate has a status:
  `CANDIDATE`, `CONFIRMED`, `DROPPED`, or `INDETERMINATE`.
- A council vote is not evidence. `CONFIRMED` requires direct source/config evidence and,
  where safely possible, deterministic reproduction or a second independent evidence
  path. The adversarial panel challenges evidence, severity, reach, and counterexamples.
- Drop false positives. Do not place unverified claims in the final findings table.
- Pass claims require a named check that actually ran. Absence of a discovered defect is
  not proof that the surface is healthy.

**AUDIT LANES**

1. **Workspace, Git, and release truth.** Prove no local work or commit is lost or
   misidentified. Inventory worktrees, branches, stashes, untracked files, ignored
   sensitive paths, tags, LFS, submodules, open PRs, CI, branch protection, releases, and
   deployed commit provenance. Identify duplicate or obsolete checkouts without deleting
   them.

2. **App logic and inventory data integrity.** Enforce the top-level law that every
   physical scan immediately appears and counts. Verify scan 10 equals count 10 across
   failures, retry, offline/reconnect, reload, cloud refresh, correction, merge,
   `markWrong`, and idempotent replay. Wrong identity remains worse than unknown.

3. **Authentication, authorization, and tenant isolation.** Audit `businessId` scoping,
   platform-owner boundaries, role mutation, self-demotion, Admin SDK bypass paths,
   IDOR/BOLA, invitation/provisioning races, session fixation, auth bypasses, and
   cross-tenant reads, writes, exports, logs, caches, or AI payloads.

4. **Code security, secrets, and dependencies.** Audit OWASP and relevant CWE risks,
   SSRF, SQL/command/prompt injection, XSS, unsafe deserialization, open redirects,
   request-size and rate-limit gaps, dependency advisories, supply-chain scripts,
   lockfile integrity, secret exposure, client-side key reads, source history, CI
   artifacts, and error messages. Scan secret evidence in redacted mode only.

5. **App cloning, intellectual-property extraction, and scraping resistance.** Approach
   the public website as a competitor or attacker trying to duplicate Scanbin.

   - Separate inherently public browser assets from assets that should remain server-only.
     Rendered UI, shipped JavaScript, CSS, network request shapes, and public images cannot
     be made secret.
   - Verify that proprietary tire/retail corpora, aliases, resolver logic, evidence rules,
     provider orchestration, cost controls, internal prompts, admin capabilities, and
     customer data never ship in client bundles, source maps, static assets, public build
     artifacts, or unauthenticated API responses.
   - Check production source-map exposure, readable stack traces, public `.map` files,
     embedded environment values, hidden route discovery, debug endpoints, build
     manifests, downloadable databases, generated JSON, and accidental repository or CI
     artifact publication.
   - Test public and low-privilege APIs for enumeration, bulk extraction, pagination
     abuse, predictable IDs, catalog scraping, response overexposure, missing quotas,
     weak bot/rate controls, cache leakage, and role-based export bypasses.
   - Review GitHub visibility, collaborators, deploy access, token scope, package
     publication, logs, backups, and third-party integrations as source-exfiltration
     paths.
   - Evaluate realistic friction and deterrence: server-side execution, least-privilege
     APIs, response minimization, quotas, anomaly monitoring, bot controls, customer terms,
     copyright/trademark notices, and evidence preservation. Do not present obfuscation,
     minification, CORS, robots.txt, or hidden URLs as primary security controls.
   - Report `UNAVOIDABLY PUBLIC`, `EXPOSED BUT FIXABLE`, and `PROTECTED SERVER-SIDE`
     assets separately.

6. **Hygiene, tooling, performance, observability, and cost.** Audit stale/duplicated
   docs and code, oversized files, abandoned artifacts, test gaps, bundle and startup
   cost, Core Web Vitals, scan-to-feedback latency, error monitoring, alerting,
   backup/restore readiness, paid-provider breakers, daily caps, client-abort billing,
   quotas, and unmeterable spend traps. Inventory enabled versus merely cached agents,
   skills, plugins, MCP servers, and hooks. Identify duplicate capabilities, conflicting
   hooks, overly broad skill triggers, irrelevant language/tool plugins, context bloat,
   and safely removable disabled packages. Distinguish project files from user-global
   tooling so global cache size is never misreported as application bundle size.

7. **GitHub infrastructure.** Audit branch protection, required checks, review rules,
   force-push/deletion protection, secret scanning and push protection, Actions security,
   permissions, pinned actions, Dependabot/alerts, collaborators, deploy keys, GitHub Apps,
   environments, and any path allowing unreviewed code to reach production.

8. **Vercel infrastructure.** Audit Git integration and production branch, deployment
   protection, domains/aliases, environment-variable names and scopes, Preview access to
   real keys/data, build-time secret handling, runtime configuration, function limits,
   logs/error exposure, deployment provenance, rollback posture, and production source
   maps. Never reveal environment values.

9. **Turso infrastructure.** Audit token scope, read/write separation, parameterized
   queries, schema integrity, constraints, tenant isolation, orphan/invariant counts,
   backup/restore posture, rollback capability, write-race exposure, and quota/billing
   headroom. Do not dump proprietary or customer rows.

10. **Firebase infrastructure.** Audit Firestore/Storage rules, default deny, tenant
    isolation, Auth providers and abuse settings, Admin SDK/service-account exposure,
    indexes, emulator-versus-production drift, deployed rules parity, backup/recovery, and
    whether privileged server routes enforce the authorization that rules cannot enforce.

**OUTPUT**

Return one report containing:

1. **Executive verdict:** overall posture, synchronization verdict, release-readiness
   verdict, and the single scariest confirmed issue.
2. **Access and scope matrix:** exact targets, authenticated identities in masked form,
   tools used, and all blocked surfaces.
3. **Synchronization matrix:** every local, GitHub, CI, deployment, Firebase, Turso, and
   generated-artifact comparison listed above.
4. **Top fixes first:** the smallest ranked shortlist that most reduces real risk.
5. **Confirmed findings table:** severity, lane, title, evidence, timestamp, concrete
   failure scenario, verification method, counterevidence considered, recommended fix,
   and rough effort.
6. **App-cloning exposure map:** unavoidable public assets, fixable exposures, protected
   server-side assets, and the highest-value extraction path.
7. **What is healthy:** only named checks that actually passed.
8. **Dropped candidates:** short false-positive ledger showing what was challenged and
   why it was dropped.
9. **Coverage gaps:** `INDETERMINATE` and `NEEDS OWNER APPROVAL` checks with the exact
   missing access or prohibited action.
10. **Spend report:** subscription usage if observable. For any billed service use
    `computed floor $X; true spend = provider console`. This audit authorizes no paid
    provider calls.

Rank findings by severity, likelihood, reach, and recoverability. Use exact file and line
evidence for repository claims and exact control-plane/API locations for remote claims.
Include timestamps for drift-prone evidence. Use plain hyphens rather than em or en dashes
in report prose.

**STOP CONDITIONS**

- Stop before any remote write, deploy, push, paid provider call, real-data export,
  customer-document read, credential change, destructive action, or operation whose
  read-only behavior cannot be established.
- Stop a lane if the target account/project/database is ambiguous.
- Do not stop the whole audit for a missing optional tool. Continue safe lanes and report
  the exact coverage gap.
- Ask the owner only for a real permission or target blocker. Never silently broaden
  authority.
