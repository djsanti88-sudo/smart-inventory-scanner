-- Launch MVP Phase 1: multi-tenant schema. Faithful to src/types.ts (camelCase domain -> snake_case DB;
-- repositories map between them). Every tenant table carries business_id; RLS is added in 00002_rls.sql.
-- gen_random_uuid() is a core function in Postgres 17 (no extension needed).

-- ============================ tenancy core ============================

create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references auth.users (id) on delete restrict,
  created_at  timestamptz not null default now()
);

create table public.memberships (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('admin', 'counter')),
  created_at   timestamptz not null default now(),
  unique (business_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);
create index memberships_business_idx on public.memberships (business_id);

-- ============================ domain ============================

create table public.products (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  name            text not null,
  brand           text,
  category        text,
  primary_sku     text,
  primary_barcode text,
  gtin            text,
  upc             text,
  ean             text,
  vendor_codes    text[] not null default '{}',
  verified        boolean not null default false,
  source          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index products_business_idx on public.products (business_id);
create index products_business_barcode_idx on public.products (business_id, primary_barcode);

create table public.aliases (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete cascade,
  raw_code_example text,
  clean_code       text not null,
  normalized_code  text,
  alias_type       text,
  approved         boolean not null default false,
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  unique (business_id, clean_code, product_id)
);
create index aliases_business_clean_idx on public.aliases (business_id, clean_code);

create table public.inventory_sessions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  name         text,
  location     text,
  status       text not null default 'active' check (status in ('active', 'completed')),
  created_by   uuid references auth.users (id) on delete set null,
  started_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index inventory_sessions_business_idx on public.inventory_sessions (business_id);

create table public.inventory_counts (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses (id) on delete cascade,
  session_id               uuid not null references public.inventory_sessions (id) on delete cascade,
  product_id               uuid not null references public.products (id) on delete cascade,
  quantity                 integer not null default 0,
  scan_event_ids           text[] not null default '{}',
  applied_idempotency_keys text[] not null default '{}',
  updated_at               timestamptz not null default now(),
  unique (business_id, session_id, product_id)
);
create index inventory_counts_business_idx on public.inventory_counts (business_id);

create table public.scan_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  session_id      uuid references public.inventory_sessions (id) on delete set null,
  raw_code        text,
  clean_code      text,
  match_type      text,
  status          text,
  resolver_status text,
  quantity_delta  integer not null default 1,
  idempotency_key text,
  created_at      timestamptz not null default now()
);
create index scan_events_business_idx on public.scan_events (business_id);
create index scan_events_session_idx on public.scan_events (session_id);

create table public.unknown_code_reviews (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  session_id        uuid references public.inventory_sessions (id) on delete set null,
  raw_code          text,
  clean_code        text,
  -- the 12+ suggested* fields from UnknownCodeReview live here as one jsonb blob (repos map them)
  suggested         jsonb not null default '{}',
  decode_status     text,
  status            text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  resolution_action text,
  idempotency_key   text,
  created_at        timestamptz not null default now()
);
create index unknown_reviews_business_idx on public.unknown_code_reviews (business_id);

create table public.settings (
  business_id        uuid primary key references public.businesses (id) on delete cascade,
  ai_lookup_enabled  boolean not null default true,
  primary_provider   text,
  -- catch-all for the many Settings fields (thresholds, flags, daily counts) so we don't sprawl columns
  data               jsonb not null default '{}',
  updated_at         timestamptz not null default now()
);

-- ============================ shared catalog ============================

-- GLOBAL barcode knowledge: intentionally NO business_id (shared, sanitized, never holds private data).
create table public.catalog_entries (
  id                  uuid primary key default gen_random_uuid(),
  normalized_barcode  text not null unique,
  name                text,
  brand               text,
  category            text,
  image_url           text,
  verification_status text not null default 'pending'
                        check (verification_status in ('verified', 'pending', 'conflict')),
  source_urls         text[] not null default '{}',
  evidence            jsonb,
  times_scanned       integer not null default 0,
  times_confirmed     integer not null default 0,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz,
  last_verified_at    timestamptz,
  created_at          timestamptz not null default now()
);

-- PRIVATE per-shop override of the global catalog (business_id-scoped; never merged upward).
create table public.shop_overrides (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses (id) on delete cascade,
  normalized_barcode text not null,
  name               text,
  brand              text,
  category           text,
  created_at         timestamptz not null default now(),
  unique (business_id, normalized_barcode)
);
create index shop_overrides_business_idx on public.shop_overrides (business_id);

-- ============================ audit trail (table only this phase) ============================

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  action      text not null,
  entity_type text,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_business_idx on public.audit_log (business_id, created_at desc);
