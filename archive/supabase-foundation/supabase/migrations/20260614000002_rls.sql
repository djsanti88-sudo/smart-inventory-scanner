-- Launch MVP Phase 1: RLS + helpers + create_business. Guardrails:
--  (1) helpers are SECURITY DEFINER with SET search_path = '' (fully-qualified), STABLE, EXECUTE granted
--      to `authenticated` only. They are owned by `postgres` (BYPASSRLS), so their internal read of
--      public.memberships does NOT re-evaluate memberships' own RLS -> no recursive-RLS loop.
--  (3) create_business is SECURITY DEFINER, search_path='', rejects unauthenticated callers, creates the
--      business + first admin membership atomically, EXECUTE granted to `authenticated` only.

-- ---- table privileges (Supabase no longer auto-exposes new tables; RLS still gates row access) ----
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant select on public.catalog_entries to anon;

-- ============================ RLS helper functions ============================

create or replace function public.is_member(b uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.memberships m
    where m.business_id = b and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_role(b uuid, r text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.memberships m
    where m.business_id = b and m.user_id = (select auth.uid()) and m.role = r
  );
$$;

revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.has_role(uuid, text) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.has_role(uuid, text) to authenticated;

-- ============================ create_business RPC ============================

create or replace function public.create_business(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_business_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'business name is required' using errcode = '22023';
  end if;
  insert into public.businesses (name, created_by)
    values (btrim(p_name), v_uid)
    returning id into v_business_id;
  insert into public.memberships (business_id, user_id, role)
    values (v_business_id, v_uid, 'admin');
  return v_business_id;
end;
$$;

revoke all on function public.create_business(text) from public, anon;
grant execute on function public.create_business(text) to authenticated;

-- ============================ enable RLS on every table ============================

alter table public.businesses           enable row level security;
alter table public.memberships          enable row level security;
alter table public.products             enable row level security;
alter table public.aliases              enable row level security;
alter table public.inventory_sessions   enable row level security;
alter table public.inventory_counts     enable row level security;
alter table public.scan_events          enable row level security;
alter table public.unknown_code_reviews enable row level security;
alter table public.settings             enable row level security;
alter table public.catalog_entries      enable row level security;
alter table public.shop_overrides       enable row level security;
alter table public.audit_log            enable row level security;

-- ============================ businesses ============================
-- A user sees businesses they belong to. Direct insert is allowed only with created_by = self (normal
-- creation goes through create_business). Mutations are admin-only.
create policy businesses_select on public.businesses for select to authenticated
  using (public.is_member(id));
create policy businesses_insert on public.businesses for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy businesses_update on public.businesses for update to authenticated
  using (public.has_role(id, 'admin')) with check (public.has_role(id, 'admin'));
create policy businesses_delete on public.businesses for delete to authenticated
  using (public.has_role(id, 'admin'));

-- ============================ memberships (admin-managed) ============================
create policy memberships_select on public.memberships for select to authenticated
  using (public.is_member(business_id));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.has_role(business_id, 'admin'));
create policy memberships_update on public.memberships for update to authenticated
  using (public.has_role(business_id, 'admin')) with check (public.has_role(business_id, 'admin'));
create policy memberships_delete on public.memberships for delete to authenticated
  using (public.has_role(business_id, 'admin'));

-- ============================ tenant CRUD tables (any member) ============================
-- products
create policy products_select on public.products for select to authenticated using (public.is_member(business_id));
create policy products_insert on public.products for insert to authenticated with check (public.is_member(business_id));
create policy products_update on public.products for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy products_delete on public.products for delete to authenticated using (public.is_member(business_id));
-- aliases
create policy aliases_select on public.aliases for select to authenticated using (public.is_member(business_id));
create policy aliases_insert on public.aliases for insert to authenticated with check (public.is_member(business_id));
create policy aliases_update on public.aliases for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy aliases_delete on public.aliases for delete to authenticated using (public.is_member(business_id));
-- inventory_sessions
create policy sessions_select on public.inventory_sessions for select to authenticated using (public.is_member(business_id));
create policy sessions_insert on public.inventory_sessions for insert to authenticated with check (public.is_member(business_id));
create policy sessions_update on public.inventory_sessions for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy sessions_delete on public.inventory_sessions for delete to authenticated using (public.is_member(business_id));
-- inventory_counts
create policy counts_select on public.inventory_counts for select to authenticated using (public.is_member(business_id));
create policy counts_insert on public.inventory_counts for insert to authenticated with check (public.is_member(business_id));
create policy counts_update on public.inventory_counts for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy counts_delete on public.inventory_counts for delete to authenticated using (public.is_member(business_id));
-- scan_events
create policy scan_events_select on public.scan_events for select to authenticated using (public.is_member(business_id));
create policy scan_events_insert on public.scan_events for insert to authenticated with check (public.is_member(business_id));
create policy scan_events_update on public.scan_events for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy scan_events_delete on public.scan_events for delete to authenticated using (public.is_member(business_id));
-- unknown_code_reviews
create policy reviews_select on public.unknown_code_reviews for select to authenticated using (public.is_member(business_id));
create policy reviews_insert on public.unknown_code_reviews for insert to authenticated with check (public.is_member(business_id));
create policy reviews_update on public.unknown_code_reviews for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy reviews_delete on public.unknown_code_reviews for delete to authenticated using (public.is_member(business_id));
-- shop_overrides
create policy overrides_select on public.shop_overrides for select to authenticated using (public.is_member(business_id));
create policy overrides_insert on public.shop_overrides for insert to authenticated with check (public.is_member(business_id));
create policy overrides_update on public.shop_overrides for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy overrides_delete on public.shop_overrides for delete to authenticated using (public.is_member(business_id));

-- ============================ settings (read any member; write admin) ============================
create policy settings_select on public.settings for select to authenticated using (public.is_member(business_id));
create policy settings_insert on public.settings for insert to authenticated with check (public.has_role(business_id, 'admin'));
create policy settings_update on public.settings for update to authenticated using (public.has_role(business_id, 'admin')) with check (public.has_role(business_id, 'admin'));

-- ============================ audit_log (write any member; read admin) ============================
create policy audit_select on public.audit_log for select to authenticated using (public.has_role(business_id, 'admin'));
create policy audit_insert on public.audit_log for insert to authenticated with check (public.is_member(business_id));

-- ============================ catalog_entries (GLOBAL read; writes service_role only) ============================
-- Any authenticated (or anon) user may READ the shared catalog. No insert/update/delete policy exists for
-- non-privileged roles, so only service_role (which bypasses RLS) can write it.
create policy catalog_select on public.catalog_entries for select to anon, authenticated using (true);
