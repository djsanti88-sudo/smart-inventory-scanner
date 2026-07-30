Rescued from .tmp/skill-build 2026-07-29; canonical skill lives at .agents/skills/scanbin-shop-owner

# Scanbin Shop Owner Skill Design

## Goal

Build a local, automatically triggered skill that certifies Scanbin through a complete shop-owner shift on local, Preview, or production targets. The deterministic Playwright harness drives the app; independent specialists inspect the resulting evidence; only independently confirmed learning is retained.

## Target routing

- `local`: default for development and repair verification. Safe to invoke automatically. Run against a localhost URL and isolated knowledge/artifact paths.
- `preview`: select when the owner supplies a Preview URL or asks to verify a release candidate. Require an explicit run request, a non-production HTTPS URL, the Preview Firebase fingerprint, and a server-enforced free-only capability before browser mutations. Until that capability exists, Preview is preflight-only.
- `production`: select for the approved Sunday 05:00 America/Chicago schedule or an explicit production request. Require the exact allowlisted URL, a stable dedicated QA account, single-account reuse, and a headless run.
- Automatic skill invocation selects and plans the correct profile. It never silently authorizes a remote write, deploy, paid call, or arbitrary tenant.

## Deterministic driver

Reuse the repaired Teach Bot harness rather than fork its logic. Locate a clean harness with `e2e/teach/teach.mjs` and `liveDecodeGate.test.mjs`, preferring the current checkout and then the repaired `rescue/teach-bot` worktree. Version 1 pins the approved harness to `c9228d6f70880434d4909a844ec20d8995265379`; record and key knowledge by that SHA and reject a dirty or mismatched harness.

All profiles:

- force `TEACH_ALLOW_LIVE_DECODE` off;
- set `TEACH_MAX_PAID_LOOKUPS=0`;
- invoke `--lesson 1,2,3,4,5,6,7,8,9,10,11,12,13` and verify the plan contains exactly those 13 lessons;
- preserve the reports and manifests the harness actually writes;
- treat missing coverage as failure;
- keep the browser open until every phase is pass, blocked with evidence, or not applicable.
- never treat a Teach `pass:true` result containing a skip/block reason as coverage;
- use a per-target, per-commit, schema-versioned knowledge root with capped append-only history;
- acquire a single-writer lock before any browser run.

Production additionally:

- use `--one-window --persona tire --reuse-account`;
- require `TEACH_BOT_ACCOUNT_EMAIL` and `TEACH_BOT_ACCOUNT_PASSWORD` from the environment;
- never print credentials;
- refuse a target outside the exact production allowlist;
- never fall back to multi-account signup when credentials are missing.
- require a runtime capability response proving an authenticated dedicated-QA-tenant free-only contract before any scan or import mutation;
- verify the exact expected Firebase project, QA account identity, business ID, and non-platform-owner role before the first write;
- block the production run, rather than reduce the proof bar, while that server contract is unavailable.
- require a future strict-login harness mode that never falls back from failed login to signup. Until both strict login and the server capability exist, production is a preflight-only blocked profile.

## Coverage contract

The run must cover:

1. login, tenant selection, logout, and re-login;
2. ordinary scans, duplicates, raw-code preservation, counts, refresh, finish, and downloadable exports;
3. multiple durable inventory sessions and history navigation;
4. clean and messy CSV, TSV, semicolon, XLSX, renamed, shuffled, blank, duplicated, typo, size, and junk-column imports;
5. perfect, variance, ambiguous, fuzzy, different-size, malformed, and unmatched reconciliation, with fuzzy results review-only;
6. Needs Review and durable correction;
7. offline, reconnect, retry, idempotency, refresh, and browser restart;
8. safe route/control sweep on desktop and mobile;
9. accessibility, console errors, responsiveness, and performance budgets.

The existing lessons are the executable base. A coverage-gap report must state any contract item not yet represented by a passing lesson instead of claiming full certification. Version 1 is permitted to report `NOT CERTIFIED` after a complete 13-lesson local run; that verdict is proof integrity, not failure concealment.
Current lesson coverage is not sufficient by itself to certify logout/re-login, browser-context restart, parsed session exports, every messy format, accessibility, or all performance budgets. These remain explicit gaps until executable phases prove them.
Deterministic tracing, phase screenshots, and download retention are also version-1 gaps because the repaired harness does not currently capture them reliably.

## Specialist council

After each deterministic run, dispatch isolated read-only specialists:

- Shop Owner Generalist
- Ledger Inspector
- Decode Inspector
- Import and Reconcile Inspector
- Auth and Tenancy Inspector
- Reliability Inspector
- Performance Inspector
- UX and Accessibility Inspector
- Evidence Prosecutor

Claude and Codex cross-review substantive findings. Antigravity adjudicates unresolved high-risk disagreements. Specialists inspect the same immutable artifact set and do not click the same production tenant concurrently.

## Learning

Use four classes of retained knowledge:

- app map and verified selectors;
- coverage and performance history;
- failure fingerprints and reproduction recipes;
- proposed harness/test improvements.

Auto-promote low-risk app-map facts and performance baselines only after two independent confirmations. Selector or harness changes require a reviewed patch. Product expectations require owner approval. Production observations never modify product code or locked requirements.

## Safety and authority

- No deploy, push, merge, provider call, production credential creation, or cleanup is implied.
- The production account is dedicated synthetic data only.
- Unknown and vendor scans may run because the app does not auto-decode them; the live-decode button lesson remains code-gated off.
- Any observed `/api/ai-lookup` POST during a zero-paid run is a blocking safety incident.
- Remove provider keys from the child environment. A client-side mock is not production proof.
- Separate learning by target, commit SHA, and schema version. Never learn from skipped, blocked, flaky, or setup-failed phases.
- Redact secrets, auth headers, cookies, emails, and foreign tenant identifiers from every agent prompt and retained artifact.
- Reports distinguish mocked, local, Preview, and production proof.
- Cleanup remains manifest-scoped and separately owner-gated.

## Weekly automation

Schedule Sunday at 05:00 America/Chicago. The automation invokes the skill in `weekly production` mode. Until the strict-login and server free-only capabilities exist, the scheduled action is preflight-only and exits blocked without opening a production browser. It must never overwrite the separate weekly intelligence task.
