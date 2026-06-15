-- Phase 1 demo seed: an AUTO shop and a TIRE shop, each with an admin user + sample products/aliases,
-- plus a few GLOBAL catalog rows. Runs as postgres during `supabase db reset` (auth inserts allowed).
-- The tenant-isolation test creates its OWN users via the admin API; this seed is for manual demos.
-- Passwords below are LOCAL DEV ONLY.

-- ---- demo auth users (login: admin@autoshop.test / admin@tireshop.test, password: demo-password-123) ----
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'admin@autoshop.test',
   extensions.crypt('demo-password-123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'admin@tireshop.test',
   extensions.crypt('demo-password-123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into auth.identities
  (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
values
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   '{"sub":"11111111-1111-1111-1111-111111111111","email":"admin@autoshop.test"}', 'email', now(), now()),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   '{"sub":"22222222-2222-2222-2222-222222222222","email":"admin@tireshop.test"}', 'email', now(), now());

-- ---- businesses + admin memberships ----
insert into public.businesses (id, name, created_by) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Demo Auto Shop', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Demo Tire Shop', '22222222-2222-2222-2222-222222222222');

insert into public.memberships (business_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin');

insert into public.settings (business_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- ---- AUTO shop sample products + an approved alias ----
insert into public.products (id, business_id, name, brand, category, primary_barcode, upc, verified, source) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Mobil 1 Full Synthetic 5W-30 5qt', 'Mobil 1', 'Motor Oil', '071924401570', '071924401570', true, 'seed'),
  ('a0000001-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Bosch ICON Wiper Blade 22"', 'Bosch', 'Wipers', '028851225229', '028851225229', true, 'seed');
insert into public.aliases (business_id, product_id, raw_code_example, clean_code, normalized_code, alias_type, approved) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000001-0000-0000-0000-000000000001',
   '071924401570', '071924401570', '071924401570', 'upc', true);

-- ---- TIRE shop sample products ----
insert into public.products (id, business_id, name, brand, category, primary_barcode, upc, verified, source) values
  ('b0000001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'Toyo Open Country A/T III 265/70R17', 'Toyo', 'Tire', '008888371234', '008888371234', true, 'seed'),
  ('b0000001-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'Falken Wildpeak A/T3W 245/75R16', 'Falken', 'Tire', '036846123456', '036846123456', true, 'seed');

-- ---- a few GLOBAL catalog rows (shared, no business_id) ----
insert into public.catalog_entries (normalized_barcode, name, brand, category, verification_status) values
  ('071924401570', 'Mobil 1 Full Synthetic 5W-30 5qt', 'Mobil 1', 'Motor Oil', 'verified'),
  ('008888371234', 'Toyo Open Country A/T III 265/70R17', 'Toyo', 'Tire', 'verified');
