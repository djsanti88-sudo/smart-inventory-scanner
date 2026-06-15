# Supabase local setup (Launch MVP Phase 1)

Phase 1 stands up the real backend (multi-tenant Postgres + Auth + RLS) on a **local** Supabase stack.
No cloud, no production. The live scan/count workflow is NOT wired to Supabase yet (that is Phase 2);
this phase delivers and PROVES the foundation.

## Prerequisites
- Docker Desktop (installed + running).
- Node 24 + npm (already used by the app).
- Deps already added: `@supabase/supabase-js` (runtime), `supabase` (dev CLI).

## 1. Start Docker, then the stack
```bash
# (start Docker Desktop first)
npx supabase start          # boots Postgres + Auth + PostgREST (first run pulls images)
npx supabase status         # prints API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY
```
Ports are remapped to the **553xx** range in `supabase/config.toml` because Windows reserves the default
542xx range (Hyper-V/WinNAT excluded ports). API = 55321, DB = 55322, Studio = 55323.

## 2. Apply schema + seed
```bash
npx supabase db reset       # applies migrations/*.sql then seed.sql
```
- `supabase/migrations/20260614000001_init.sql` - tables (businesses, memberships, products, aliases,
  inventory_sessions, inventory_counts, scan_events, unknown_code_reviews, settings, catalog_entries,
  shop_overrides, audit_log). Every tenant table has `business_id`.
- `supabase/migrations/20260614000002_rls.sql` - RLS + helpers + `create_business` RPC + grants.
- `supabase/seed.sql` - demo AUTO shop + TIRE shop (login: `admin@autoshop.test` / `admin@tireshop.test`,
  password `demo-password-123`) + sample products + a few global catalog rows.

## 3. Env
Copy the printed values into `.env.local` (git-ignored):
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from `supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `supabase status`>   # server-only, never NEXT_PUBLIC
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres
```

## 4. Regenerate typed DB types after a schema change
```bash
# This CLI version gates `gen types` behind a token check; any value satisfies it for --db-url:
SUPABASE_ACCESS_TOKEN=local npx supabase gen types typescript \
  --db-url "postgresql://postgres:postgres@127.0.0.1:55322/postgres" > src/services/db/database.types.ts
```

## 5. Run the tenant-isolation proof (authenticated user clients)
```bash
SUPABASE_URL=http://127.0.0.1:55321 \
SUPABASE_ANON_KEY=<ANON_KEY> \
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
npx vitest run src/services/db/tenantIsolation.integration.test.ts src/services/db/repositories.integration.test.ts
```
The service role is used ONLY to create/delete test users; all isolation assertions run as normal
authenticated User A / User B sessions.

## 6. Gates
```bash
npx vitest run        # unit + dom (integration tests skip unless the SUPABASE_* env above is set)
npx tsc --noEmit
npx eslint src e2e
npx next build
npx playwright test   # auth bypass (e2e only) keeps these green without a live Supabase
```

## Security notes
- `SUPABASE_SERVICE_ROLE_KEY` is server-only (`src/lib/supabaseServer.ts`, `import "server-only"`).
  `src/services/keySafety.test.ts` fails the build if it (or service-role usage) appears in client code
  or a `NEXT_PUBLIC_` var.
- The E2E auth bypass (`src/services/auth/authBypass.ts`) is impossible in production
  (`NODE_ENV === "production"` short-circuits it off); proven by `authBypass.test.ts`.
- `.env.local` is git-ignored; never commit real keys.

## RLS helper recursion-safety
`public.is_member()` / `public.has_role()` are `SECURITY DEFINER` with `SET search_path = ''`, owned by
`postgres` (which has BYPASSRLS). Their internal read of `public.memberships` therefore does NOT
re-evaluate memberships' own RLS policies, so there is no recursive-RLS loop. `EXECUTE` is granted to
`authenticated` only. `create_business` is likewise `SECURITY DEFINER` + fixed `search_path`, rejects
unauthenticated callers, and is granted to `authenticated` only.
