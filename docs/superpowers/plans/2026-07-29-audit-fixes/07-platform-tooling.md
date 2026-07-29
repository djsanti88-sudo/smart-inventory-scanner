# Agent 7 — Platform Tooling & Observability (rev 4)

> Read `00-orchestration.md` and master plan Tasks 10, 15, 9 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/07-platform-tooling`.

**Scope:** master-plan **Task 10 (F-11)** narrow preauth + no-write Stop-hook mode; **Task 15 (F-14)**
hash-verify the jwks-rsa patch; **Task 9 (F-10)** production observability — minimal in-repo, $0.

**Files you OWN:**
- `.claude/settings.local.json`, `scripts/hooks/fable5-stop.ps1`, `scripts/hooks/deep-review-radar.mjs`
- `scripts/patch-jwks-rsa.cjs`, `package.json`, and `package-lock.json` only if the chosen dependency strategy changes it
- Observability INFRASTRUCTURE: `src/server/log.ts`, **new** `src/app/api/telemetry/route.ts` (+ test),
  **new** `src/app/global-error.tsx` (+ component test), **new** `src/lib/telemetry.ts` (client helper),
  **new** `docs/OBSERVABILITY.md`.

**F-10 feasibility boundary (external review, 2026-07-29) — READ THIS:**
- A Next error boundary (`global-error.tsx`) is a CLIENT component and CANNOT import server-only `log.ts`.
  It POSTs a sanitized payload to `/api/telemetry` (via `src/lib/telemetry.ts`), and the route (server-side)
  calls `logServerEvent`.
- "$0 alerting" = structured, queryable logs + a documented example log query in `docs/OBSERVABILITY.md`.
  Real paging is OUT of the $0 scope (note as a follow-up). No Sentry/OTel vendor, no paid dependency.
- **SECURITY — the sink is public, so it must not let attackers forge operational logs.** `logServerEvent`'s
  real shape is `{ route, event, reasonCode?, businessId?, status?, detail? }` (no `severity`/`kind`/`source`).
  The route MUST: allowlist `event` to exactly `breaker_open` + `client_error` (else 400); FORCE
  `route:"/api/telemetry"` server-side; DROP client-supplied `businessId` (unverifiable, no auth); derive
  `status`/`reasonCode` server-side; accept only a short `.slice(0,200)`-sanitized `detail`; reject an
  oversized declared `Content-Length`, then CAP the actual UTF-8 bytes from `request.text()` with
  `TextEncoder` BEFORE `JSON.parse` (413); and rate-limit via `checkRateLimit` (mirror
  `catalog-dispute/route.ts:73-89`, fail-open on storage error).
- **You build the infrastructure only.** The 1-2 emit CALLS that live in OTHER agents' files — the client
  circuit-breaker POST (in `scanStore.ts`, Agent 1) and the daily-cap-exhausted event (in Agent 2's
  aiSpendGuard/decode area) — are wired by the INTEGRATOR after merge, NOT by you. Do NOT edit `scanStore.ts`,
  `aiSpendGuard*`, or `ai-lookup` (those belong to Agents 1 and 2). Provide the helper + sink they call into.
- `postTelemetry` is best-effort and MUST catch fetch/rejection failures so reporting an error cannot throw
  another error or recurse. Per the installed Next.js 16 contract, `global-error.tsx` is a Client Component
  that renders its own `<html>` and `<body>` tags and exposes a safe retry action.
- F-09 already emits `spend_write_diverged` + `charge_pair_incomplete`; your log-based alert doc references
  them — you do not re-implement them.

**Internal order:** F-11 is independent. F-14 and F-10 can both touch `package.json` (postinstall /
a possible dep) — F-10 adds NO paid dependency, so coordinate the two package.json edits serially if both need
it (same agent, trivial).

**Executor sequence (the file groups are mostly disjoint, but this lane has one executor):**
- F-11 narrow preauth + env-driven no-write hook mode (verify hooks work without the flag and
  write nothing with it).
- F-14 input/output hash verification (or maintained patch-package) so the patch fails LOUDLY on
  upstream drift; prove `npm ci` still applies it + `tsc`.
- F-10 infrastructure — `logServerEvent` events for server-only sites you own, the `/api/telemetry`
  sink (sanitize + size-cap + rate-limit), `global-error.tsx`, `src/lib/telemetry.ts`, `docs/OBSERVABILITY.md`,
  and tests for the sink + boundary.

**Proof gates:** `npx vitest run src/server/log.test.ts src/app/api/telemetry`, component test for the boundary,
`npx tsc --noEmit`, a clean `npm ci` still applies the jwks-rsa patch (F-14), hooks verified in both modes.

**Definition of done:** narrower permissions + no-write hook mode; jwks patch fails loudly on drift; the
telemetry sink + client helper + global error boundary + server events + log-alert doc ship (no vendor, $0);
the cross-cutting emit calls are left for the integrator to wire. Merge into `audit-fixes`.
