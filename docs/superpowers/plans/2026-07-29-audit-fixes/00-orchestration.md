# Audit Fixes — Parallel Orchestration Index (2026-07-29, rev 4)

**What this is:** the master plan `docs/superpowers/plans/2026-07-29-audit-remediation.md` (Tasks 1-16)
split into **7 independent agent plans** that run in successive waves of up to three specialists. Executor
agents do not spawn nested sub-agents. This index defines the split, the isolation guarantees, the branch/merge model, and the
global constraints every agent obeys. **Nothing here is executed yet — this is the plan of record.**

> **Rev 2 (2026-07-29):** hardened after an external review (ChatGPT). Key changes: Agent 2 now OWNS the
> reconcile/match client callers + the 3 reconcile E2E specs (F-12 changes their contract); Agent 7's F-10
> is redesigned to be feasible and OWNS a new telemetry route + a global error boundary; cross-cutting
> emit-call sites are integrator-wired; branch standardized to `audit-fixes`; explicit-path staging only;
> a full integration gate + finding-closure status added; F-09 is verification-only.
>
> **Rev 3 (2026-07-29):** second external review + 4-agent code investigation applied — task labels are
> TARGET (only the integrator marks CODE-CLOSED after the gate); F-16 separates payload vs base-source
> lineage fields; F-12 uses the `isAuthBypassEnabled()` bypass pattern (E2E specs stay green, no token edit)
> + a prod bypass-denial test; F-10 telemetry sink gets a strict event allowlist + drops unverifiable client
> fields + caps the body before parsing; F-05 handles first-promotion absent tables (ABSENT sentinel) and
> tests both scenarios; F-03 gets the exact emulator path `src/services/db/firebase/markWrongTransfer.rules.test.ts`.
>
> **Rev 4 (2026-07-29):** closes final execution hazards found in direct plan/code review: all three
> payload-derived corpus counts refresh through temp-fixture tests; Turso canonical hashing is injective;
> F-06 cannot escape its file ownership; telemetry uses UTF-8 byte limits, a non-throwing client helper, and
> the Next.js 16 global-error document contract. Specialists use the lower-tier/default executor model;
> high-tier reasoning is reserved for the integrator and triggered adversarial review.

**Single source of task detail:** the master plan holds the verbatim per-task TDD steps, test code, and
acceptance criteria (Task 1-16). Each sub-plan references its master-plan Task numbers rather than
duplicating them. Every agent MUST read, in order: (1) its own sub-plan, (2) the referenced master-plan
tasks, (3) this orchestration index, (4) `CLAUDE.md` + `AGENTS.md`.

## The parallelization principle

Agents parallelize by **disjoint file sets**. Two agents NEVER edit the same file. Where two tasks are
welded to one file, they live in the SAME agent and run SEQUENTIALLY. Verified isolation (each file is
owned by exactly one agent):

| File / area | Owner agent |
|---|---|
| `src/stores/scanStore.ts` (+ store tests), and the ONE new F-03 emulator test `src/services/db/firebase/markWrongTransfer.rules.test.ts` (Agent 1 creates this one file; the rest of `src/services/db/firebase/**` stays read-only reference) | Agent 1 only |
| `src/app/api/account/export/**`, `src/app/api/reconcile/match/**`, `src/app/api/prefix-floor/**`, `src/app/api/ai-lookup/**`, `src/services/security/aiSpendGuard*`, **the reconcile client callers** (`components/ReconcilePanel*`, `stores/reconcileStore.ts`, `components/UniversalImportPanelContainer*`), **the 3 reconcile E2E specs** (`e2e/reconcile.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts`, `e2e/phase4-universal-import.spec.ts`) | Agent 2 only |
| `scripts/tire-db-repair/10_promote_execute.mjs` (+ test, runbook doc) | Agent 3 only |
| `src/server/tire-knowledge/**` (corpus meta + drift test), NEW `scripts/refresh-tire-meta.mjs`, NEW `scripts/refresh-tire-meta.test.mjs` | Agent 4 only |
| `firestore.rules`, `firestore.indexes.json`, existing Firebase rules tests under `src/services/db/firebase/**` EXCEPT Agent 1's NEW `markWrongTransfer.rules.test.ts`, `docs/RECOVERY.md` | Agent 5 only |
| `e2e/**` EXCEPT the 3 reconcile specs above, `.github/workflows/**`, `docs/DEPLOY_TRUTH.md` | Agent 6 only |
| `.claude/settings.local.json`, hook scripts, `scripts/patch-jwks-rsa.cjs`, `package.json`, `package-lock.json` if dependency strategy changes, `src/server/log.ts` + test, **new** `src/app/api/telemetry/**`, **new** `src/app/global-error.tsx` + test, **new** `src/lib/telemetry.ts`, `docs/OBSERVABILITY.md` | Agent 7 only |

`firebaseSyncTarget.ts` is READ-ONLY reference for Agent 1 (F-03). `firestore.rules` is READ-ONLY reference
for Agent 2 (F-04 tests) — edited only by Agent 5. `src/services/security/aiSpendGuard*` and
`src/app/api/ai-lookup/**` are Agent 2's (F-09 verification lives there) — Agent 7 must NOT edit them.

**Shared low-churn seams to watch (the honest exceptions to strict isolation):**
- `src/types.ts` / a shared constants module may receive ADDITIVE edits (Agent 1's F-03 may add a
  transfer-op type; Agent 2/7 may add an event/op type). Rule: additive only (never rename/reshape an
  existing symbol), merge Agent 1 first, resolve trivial markers at integration.
- **F-10 cross-cutting emit sites are INTEGRATOR-WIRED, not Agent 7's edits.** Agent 7 builds the
  observability INFRASTRUCTURE (the `/api/telemetry` sink, `global-error.tsx`, a client `lib/telemetry.ts`
  helper, `log.ts` server events for server-only sites it owns, tests, docs). The 1-2 emit CALLS that live
  in other agents' files — the client circuit-breaker `POST` (in `scanStore.ts`, Agent 1's file) and the
  daily-cap-exhausted event (in `aiSpendGuard`/decode pipeline, Agent 2's area) — are added by the
  INTEGRATOR (Opus) after those agents merge, as one-line calls into Agent 7's helper, then the gate is
  re-run. This keeps every agent's file set clean.

## The 7 agents

| # | Agent | Sub-branch | Master-plan Tasks (findings) | Internal order | Closure |
|---|---|---|---|---|---|
| 1 | Scan Ledger Correctness | `audit-fixes/01-scan-ledger` | T1 (F-02), T3 (F-03) | SEQUENTIAL (same file) | TARGET: CODE-CLOSED |
| 2 | API Authorization & Cost | `audit-fixes/02-api-auth` | T4 (F-04), T7 (F-12), T16 (F-09) | parallel; F-09 verify-only | TARGET: CODE-CLOSED |
| 3 | Turso Promotion Tooling | `audit-fixes/03-turso-promote` | T6 (F-05), T14 (F-17) | SEQUENTIAL (same file; F-05 first) | TARGET: CODE-CLOSED (live promote OWNER-GATED) |
| 4 | Corpus Provenance | `audit-fixes/04-corpus-provenance` | T13 (F-16) | single task | TARGET: CODE-CLOSED |
| 5 | Firestore Rules/Indexes/Recovery | `audit-fixes/05-firestore-infra` | T2 (F-01+F-07), T8 (F-08) | parallel | **CODE-PREPARED / OWNER-GATED (OPEN)** |
| 6 | Release & CI | `audit-fixes/06-release-ci` | T5 (F-06), T11 (F-13), T12 (F-15) | parallel (disjoint) | TARGET: CODE-CLOSED |
| 7 | Platform Tooling & Observability | `audit-fixes/07-platform-tooling` | T10 (F-11), T15 (F-14), T9 (F-10) | mostly parallel; serialize package.json | TARGET: CODE-CLOSED |

## Locked decisions (owner, 2026-07-29)

- **F-12** `reconcile/match` = **authenticated + rate-limited via the `isAuthBypassEnabled()` bypass pattern**
  (mirror `import-mapping/route.ts`, NOT `account/export`'s strict refusal) so the real-route reconcile E2E
  specs stay green WITHOUT token edits (Agent 2 just RUNS them to verify) + a production bypass-denial test;
  `prefix-floor` = **rate-limited only, NOT authenticated** (Agent 2).
- **F-09** = already implemented; **verification-only**, no redundant alert edit (Agent 2).
- **F-10** = **minimal in-repo, $0**: server events + `/api/telemetry` sink + `global-error.tsx` +
  log-based alert doc; NO external vendor or paid dependency (Agent 7).
- **F-04** = account export is **owner/admin only; 403 for viewer/counter** (exact contract).

## Branch and merge model (single PR for ChatGPT review)

- Integration branch: **`audit-fixes`** (already created off `master` @ `35bebdb`). This is the single
  branch the owner turns into ONE PR for ChatGPT (desktop app) to review.
- Each agent works in its OWN git worktree on its sub-branch (`audit-fixes/0N-...`) cut from `audit-fixes`.
- On task completion each sub-branch merges back into `audit-fixes`. File sets are disjoint by construction,
  so merges are conflict-free. The **integrator (Opus)** performs merges, verifies each diff, wires the
  F-10 cross-cutting emit calls, and runs the integration gate.
- **Merge order:** Agent 1 first (owns `scanStore.ts` + any shared type additions the F-10 breaker emit
  and F-03 transfer op depend on). Agent 2 before the integrator's final full `test:e2e` (its reconcile-spec
  changes must be present so the Mock E2E gate stays green). Others in any order.

## Global constraints (every executor + integrator obeys — from the master plan + project law)

- Inherit ALL "Global Constraints" from `2026-07-29-audit-remediation.md` verbatim: the TOP-LEVEL LAW,
  wrong-identity rules, markWrong-is-a-transfer, idempotency rules, services stay pure, no em/en dashes,
  TEST SAFETY (no live/paid providers), HARD GATES (no push/merge-to-master/deploy/prod without owner).
- **Stage EXPLICIT paths only — NEVER `git add -A`/`git add .`** (the tree carries unrelated untracked
  files). Each agent commits only to its own sub-branch; no push, no merge to `master`, no deploy.
- **Finding closure status — agents NEVER self-declare "closed."** Each task header states a TARGET
  (TARGET: CODE-CLOSED, or CODE-PREPARED/OWNER-GATED). An agent reports "target met, my tests green on my
  sub-branch." ONLY the integrator (Opus) marks a finding actually CODE-CLOSED, and only after the
  whole-effort integration gate passes on `audit-fixes`. F-01, F-07, F-08 stay OPEN (owner-gated) regardless.
- **Port isolation (critical for parallel test runs):** dev 3000, mock E2E 3100, firebase E2E 3200, qa bots
  3300; Firestore emulator 8080 / Auth 9099 / UI 4001. Agents 1, 2, 5 all use the Firestore emulator; Agents
  2, 6 use mock E2E 3100. Two agents running the SAME port-bound suite at once will collide — the integrator
  serializes emulator/E2E runs across agents (or gives each worktree distinct ports via env).
- **Agent budget:** the integrator occupies one slot and dispatches at most three of the seven specialists
  concurrently, in successive waves. Specialists do not spawn nested agents. Routine executor work uses the
  repository's lower-tier/default model; high-tier reasoning is reserved for the integrator and a triggered
  adversarial verification pass.
- **Owner-gated actions are prepared, never executed:** Firestore rules/indexes deploy + PITR (Agent 5),
  any live Turso re-promote (Agent 3).

## Integration gate (integrator runs on `audit-fixes` after all merges + F-10 wiring)

Run the full battery from the master plan's "Integration gate" section and require GREEN:
`npm run proof:full` → `npm run test:ledger` → `npm run test:firebase` (incl. F-03 transfer-and-reload) →
the Turso promotion node test → `node --test scripts/refresh-tire-meta.test.mjs` + corpus-drift + golden gates →
`npm run test:e2e` ×2 → focused `npx eslint <changed paths>` → `npm run qa:bots` (mock). Any red = fix root
cause before the PR is ready. Then confirm closure status (F-01/F-07/F-08 remain OPEN/owner-gated).

## Why 7 (and the 6 alternative)

7 is the finest split where no two agents share a primary file. The only foldable seam is Agent 4 (Corpus
Provenance, `src/server/tire-knowledge/**`) into Agent 3 (`scripts/tire-db-repair/**`) — independent files,
safe to fold to 6. Above 7 buys nothing.
