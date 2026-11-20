-- SYNTHETIC DEVELOPMENT DATA ONLY. Applied by `supabase db reset` on a LOCAL stack.
-- Never run against production. All names, phones and coordinates are fictional.
-- Local sign-in is by email OTP (codes appear in the local test inbox). Password set below is unused by the app.
--   owner@example.test (owner) · amit.staff@example.test · neha.staff@example.test
-- Admin MFA is disabled for the dev organization so you can log in immediately.

do $$
declare
  v_org uuid := '00000000-0000-4000-8000-000000000001';
  v_owner uuid := '00000000-0000-4000-8000-0000000000a1';
  v_amit uuid := '00000000-0000-4000-8000-0000000000b1';
  v_neha uuid := '00000000-0000-4000-8000-0000000000b2';
  v_pw text := crypt('KisanRoute-dev-1', gen_salt('bf'));
  u record;
begin
  if current_setting('app.environment', true) = 'production' then
    raise exception 'Refusing to seed synthetic data in production';
  end if;

  insert into public.organizations (id, name, timezone, settings)
  values (v_org, 'Greenfield Agro (DEV)', 'Asia/Kolkata', '{"require_admin_mfa": false}')
  on conflict (id) do nothing;

  for u in select * from (values
      (v_owner, 'owner@example.test', 'Dev Owner', 'owner'::public.app_role),
      (v_amit, 'amit.staff@example.test', 'Amit (synthetic)', 'staff'::public.app_role),
      (v_neha, 'neha.staff@example.test', 'Neha (synthetic)', 'staff'::public.app_role)) as t(id, email, name, role)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, v_pw, now(), now(), now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('display_name', u.name), '', '', '', '')
    on conflict (id) do nothing;
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now())
    on conflict do nothing;
    insert into public.profiles (id, organization_id, role, status, display_name, email, coverage_area)
    values (u.id, v_org, u.role, 'active', u.name, u.email, case when u.role = 'staff' then 'Maval taluka (synthetic)' end)
    on conflict (id) do nothing;
  end loop;

  insert into public.products (organization_id, sku, name, category, unit, price, active) values
    (v_org, 'SEED-SOY-01', 'Soybean seed JS-335 (sample)', 'Seeds', 'bag 30 kg', 2450.00, true),
    (v_org, 'FERT-NPK-19', 'NPK 19:19:19 (sample)', 'Fertilizer', 'kg', 128.50, true),
    (v_org, 'BIO-TRI-01', 'Trichoderma bio-fungicide (sample)', 'Bio inputs', 'kg', 310.00, true),
    (v_org, 'DRIP-16MM', 'Drip lateral 16 mm (sample)', 'Irrigation', 'roll 400 m', 3150.00, true)
  on conflict do nothing;

  perform set_config('kisanroute.verifying_location', 'on', true);
  insert into public.farmers (organization_id, name, phone, village, district, state, postcode, address, crops, lat, lon, location_verified, geocode_source) values
    (v_org, 'Test Farmer Ramesh', '9000000001', 'Talegaon (sample)', 'Pune', 'Maharashtra', '410506', 'Plot 12, sample road', '{soybean,onion}', 18.7357, 73.6755, true, 'seed'),
    (v_org, 'Test Farmer Sunita', '9000000002', 'Vadgaon (sample)', 'Pune', 'Maharashtra', '412106', 'Near sample temple', '{sugarcane}', 18.7426, 73.6406, true, 'seed'),
    (v_org, 'Test Farmer Prakash', '9000000003', 'Kamshet (sample)', 'Pune', 'Maharashtra', '410405', 'Sample farm lane', '{rice,tomato}', null, null, false, null);
  perform set_config('kisanroute.verifying_location', 'off', true);
end $$;
