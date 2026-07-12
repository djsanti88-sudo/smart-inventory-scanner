# Launch MVP Phase 1 - Report (2026-06-14)

Supabase backend, schema, RLS, Auth, business separation. Foundation + proof ONLY (the scan/count
workflow stays local; Phase 2 wires it onto these repositories). Branch: `phase1-supabase-foundation`.

> Naming: the earlier "Phase 1 benchmark" work was the **Lookup Benchmark Sprint**
> (LOOKUP_BENCHMARK_SPRINT.md), NOT this Launch MVP Phase 1.

## Completed TODOs
Local Supabase (CLI + Docker) · schema migrations · RLS policies + helpers · hardened create_business ·
Supabase Auth (email/password) · business-creation flow · admin/counter membership · typed repositories ·
generated DB types · demo auto/tire seed · tenant-isolation negative test (authenticated clients) ·
repositories integration test · guarded E2E auth bypass + its production-off test · extended key-safety
test · .env.example · SUPABASE_SETUP.md · all gates.

## Files changed / added
- Migrations/seed: `supabase/config.toml` (ports->553xx), `supabase/migrations/20260614000001_init.sql`,
  `supabase/migrations/20260614000002_rls.sql`, `supabase/seed.sql`.
- Supabase libs: `src/lib/supabaseClient.ts` (browser), `src/lib/supabaseServer.ts` (server-only).
- Auth: `src/lib/auth.ts` (rewritten), `src/components/AuthGuard.tsx`, `src/app/login/page.tsx`,
  `src/services/auth/authBypass.ts` (+ `authBypass.test.ts`), `src/components/Nav.tsx` (logout->signOut).
- Business/membership: `src/app/(app)/business/page.tsx`.
- Repositories: `src/services/db/repositories.ts`, `src/services/db/database.types.ts` (generated).
- Tests: `src/services/db/tenantIsolation.integration.test.ts`,
  `src/services/db/repositories.integration.test.ts`, `src/services/keySafety.test.ts` (extended).
- Config/docs: `package.json` (deps), `playwright.config.ts` (e2e bypass env), `.env.example`,
  `SUPABASE_SETUP.md`, this report, PROGRESS/DECISIONS/TESTING/RISK_REGISTER/LESSONS_LEARNED.

## Supabase setup status
Local stack running via `npx supabase start` (Docker). Ports remapped to 553xx (API 55321, DB 55322,
Studio 55323) because Windows WinNAT reserves the default 542xx range. `npx supabase db reset` applies
migrations + seed cleanly.

## Schema tables created (12, all RLS-enabled)
`businesses`, `memberships`, `products`, `aliases`, `inventory_sessions`, `inventory_counts`,
`scan_events`, `unknown_code_reviews`, `settings`, `catalog_entries` (global, no business_id),
`shop_overrides` (tenant), `audit_log` (table only; write-wiring is Phase 2). Every tenant table carries
`business_id`.

## RLS policies created
RLS enabled on all 12 tables. Per tenant table: SELECT/UPDATE/DELETE `USING (is_member(business_id))`,
INSERT `WITH CHECK (is_member(business_id))` (the forged-business_id defense). Admin-gated writes
(`has_role(business_id,'admin')`) on memberships, settings, and business mutations. `audit_log` write =
member, read = admin. `catalog_entries` = read for any authenticated/anon; writes service-role only.

## RLS helper safety (recursion avoidance)
`public.is_member(uuid)` and `public.has_role(uuid,text)` are `SECURITY DEFINER` with `SET search_path =
''` (fully-qualified `public.memberships`), `STABLE`, `EXECUTE` granted to `authenticated` only. They are
owned by `postgres`, which has BYPASSRLS, so their internal read of `memberships` does NOT re-evaluate
memberships' own RLS policies -> **no recursive-RLS loop**. `create_business` is likewise SECURITY
DEFINER + `search_path=''`, rejects unauthenticated callers (`auth.uid()` null), creates the business +
first admin membership atomically, and is `EXECUTE`-granted to `authenticated` only.

## Tenant-isolation proof (authenticated user clients - service role NOT used for assertions)
`src/services/db/tenantIsolation.integration.test.ts` - **6/6 PASS** against the live local stack.
Service role creates/deletes the two test users only; every assertion runs as a real signed-in session:
- create_business made the creator an `admin` member of their business.
- (a) User A reads + writes Business A data.
- (b) User B SELECT of Business A rows -> 0 rows.
- (c) User B INSERT with forged `business_id = A` -> REJECTED (RLS WITH CHECK).
- (d) User B UPDATE Business A rows -> 0 rows affected (data unchanged).
- (e) User B DELETE Business A rows -> 0 rows affected (row still exists).

## Auth + business-creation flow status
Supabase email/password sign-in/sign-up (`/login`); `AuthGuard` gates protected routes on a real
session; `/business` lists the user's memberships (with admin/counter role) and creates a business via
the hardened RPC (creator becomes admin). E2E/test auth bypass keeps the 11 Playwright specs green and is
impossible in production (proven by `authBypass.test.ts`).

## Typed repositories created
`src/services/db/repositories.ts`: products, aliases, scan_events, inventory_counts, inventory_sessions,
unknown_code_reviews, memberships, businesses, settings, shop_overrides - typed via generated
`database.types.ts`, dependency-injected client, idempotent upsert-by-id. Proven by
`repositories.integration.test.ts` (authenticated round-trip). Ready for Phase 2 wiring.

## Seed data status
`supabase/seed.sql` applies cleanly: demo AUTO shop (`admin@autoshop.test`) + TIRE shop
(`admin@tireshop.test`), password `demo-password-123` (LOCAL ONLY), each with sample products + an
approved alias, plus a couple of global catalog rows.

## Tests run and exact results
| Gate | Command | Result |
|------|---------|--------|
| supabase start | `npx supabase start` | OK (stack healthy on 553xx) |
| db reset | `npx supabase db reset` | OK (migrations + seed clean) |
| tenant isolation | `vitest run tenantIsolation.integration` (with SUPABASE_* env) | **6/6 passed** |
| repositories | `vitest run repositories.integration` (with env) | **1/1 passed** |
| unit + dom | `npx vitest run` (no DB env) | **318 passed, 7 skipped** (integration skips) |
| typecheck | `npx tsc --noEmit` | clean (exit 0) |
| lint | `npx eslint src e2e` | clean (exit 0; 1 pre-existing benchmark warning) |
| build | `npx next build` | success (/business route added) |
| e2e | `npx playwright test` | **11/11 passed** |

## Known limitations
- Scan/count/sync still run on the LOCAL store (intended this phase); not yet writing to Supabase.
- `audit_log` table exists but writes are not yet wired (Phase 2).
- `gen types` requires a dummy `SUPABASE_ACCESS_TOKEN` with this CLI version (documented).
- Local stack only; no cloud/production project provisioned (by design).
- Seed/demo passwords are local-only; `.env.local` (real keys) is git-ignored and uncommitted.

## Phase 2 handoff instructions (do NOT start until approved)
1. Wire `scanStore` scan/count/session mutations onto the typed repositories (online-required,
   retry-safe idempotency via the existing idempotency keys + upsert-by-id).
2. Load the signed-in user's selected business + role into app state; scope all reads/writes by it.
3. Wire `audit_log` writes on every mutation (who/what/when).
4. Move the shared catalog onto `catalog_entries` / `shop_overrides`; add alias-approval (admin) +
   CSV import/export against the backend.
5. Add member-management UI (admins invite counters) and role-gated actions in the UI.
6. Provision a cloud Supabase project for staging/pilot; run the same migrations + RLS proof there.

## Git status
On branch `phase1-supabase-foundation` (off master). Committed as a checkpoint; NOT pushed/merged - awaiting
your Phase 1 proof approval. No secrets committed (`.env.local` git-ignored).
