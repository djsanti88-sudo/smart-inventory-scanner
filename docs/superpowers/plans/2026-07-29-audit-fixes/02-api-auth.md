# Agent 2 — API Authorization & Cost (rev 4)

> Read `00-orchestration.md` and master plan Tasks 4, 7, 16 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/02-api-auth`.

**Scope:** master-plan **Task 4 (F-04)** export owner/admin-only (403 for viewer/counter); **Task 7 (F-12)**
authenticate + rate-limit `reconcile/match` AND update its client callers + reconcile E2E specs, rate-limit
`prefix-floor` (no auth); **Task 16 (F-09)** VERIFICATION-ONLY (divergence signal already implemented).

**Files you OWN (touched by no other agent):**
- Routes: `src/app/api/account/export/route.ts` (+ test), `src/app/api/reconcile/match/route.ts` (+ test),
  `src/app/api/prefix-floor/route.ts` (+ test).
- Reconcile client callers (F-12 changes their contract, so they are YOURS): `src/components/ReconcilePanel.tsx`
  + `ReconcilePanel.test.tsx`, `src/stores/reconcileStore.ts`, `src/components/UniversalImportPanelContainer.tsx`
  + `UniversalImportPanelContainer.test.tsx`.
- Reconcile E2E specs (carved from Agent 6): `e2e/reconcile.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts`,
  `e2e/phase4-universal-import.spec.ts`.
- F-09 verification only: `src/services/security/aiSpendGuard*`, `src/app/api/ai-lookup/route*` (read-only
  unless you find a missing emit site).
- READ-ONLY reference: `firestore.rules` (auditLog policy), the shared `checkRateLimit` helper, the auth
  verifier `account/export` uses.

**Internal order:** F-04, F-12, and F-09 use disjoint files and may be sequenced in either order. Within
F-12, do route → callers → E2E (the callers/E2E depend on the route's new contract).

**Executor sequence (the three file groups are independent, but this lane has one executor):**
- F-04 — role gate returning exactly **403** for viewer/counter; owner/admin unchanged; tests.
- F-12 — add `authorize()` to reconcile/match MIRRORING `import-mapping/route.ts:44-76`
  (`isAuthBypassEnabled() || !isLiveAuth()` short-circuit, then `verifyIdToken` + `businessMembers` membership;
  NOT `account/export`'s strict refusal) + rate limit + byte/row caps + a PRODUCTION bypass-denial test
  (`vi.stubEnv("NODE_ENV","production")`, cf. `ProdFirebaseBanner.test.tsx`). Update `ReconcilePanel`/
  `reconcileStore`/`UniversalImportPanelContainer` to attach idToken+businessId + their unit tests. Then just
  RUN the 3 reconcile E2E specs to CONFIRM they stay green (the E2E bypass keeps them passing with NO token
  edit; only fix if one actually fails). Reject oversized declared `Content-Length`, then measure actual
  UTF-8 bytes with `TextEncoder` before parsing. Use a documented row cap no higher than 5,000 and an explicit
  response DTO allowlist enforced recursively by a test. Prefix-floor = rate-limit + byte cap, NO auth.
- F-09 — run the existing `aiSpendGuard.gptLadder.test.ts` + `route.legacyChargePair.test.ts`,
  confirm `spend_write_diverged` + `charge_pair_incomplete` fire; add a missing emit + test ONLY if a gap
  exists; otherwise no code change. Do NOT add a redundant alert (that overlaps Agent 7's F-10).

**Locked contracts (2026-07-29, rev 3):** F-12 reconcile/match = authenticated + rate-limited via the
`isAuthBypassEnabled()` bypass pattern (mirror `import-mapping`, NOT `account/export`) + a prod bypass-denial
test; the reconcile E2E specs stay green via the bypass (RUN to verify, do not rewrite); prefix-floor =
rate-limited only, no auth; F-04 = owner/admin only, exactly 403 for viewer/counter; F-09 = verify-only.

**Dependency:** your reconcile changes (route + callers + 3 E2E specs) MUST be green and merged before the
integrator's final full `npm run test:e2e`, so the Mock E2E gate stays green after the contract change.

**Proof gates:** `npx vitest run src/app/api/account/export src/app/api/reconcile/match src/app/api/prefix-floor src/components/ReconcilePanel.test.tsx src/components/UniversalImportPanelContainer.test.tsx src/stores src/services/security`,
then the 3 reconcile specs via `npm run test:e2e`, `npm run test:firebase` (F-04 role), `npx tsc --noEmit`,
focused `npx eslint <changed paths>`.

**Definition of done:** viewer/counter get 403 on export; reconcile/match requires auth + is rate/byte-capped
with callers + E2E updated; prefix-floor rate-limited (no auth); F-09 confirmed already-implemented; all tests
green. Merge into `audit-fixes`.
