-- Distributors (business customers the company supplies products to) and product supplies to them.
-- Admin-only data; staff have no access. Same tenant, audit and price-snapshot rules as farmers/purchases.

create table public.distributors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null check (length(trim(name)) between 1 and 160),
  contact_person text check (contact_person is null or length(contact_person) <= 120),
  phone text,
  normalized_phone text,
  alt_contact text,
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  gstin text check (gstin is null or gstin ~* '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  address text check (address is null or length(address) <= 1000),
  village text,
  district text,
  state text,
  postcode text check (postcode is null or postcode ~ '^[0-9A-Za-z -]{3,10}$'),
  notes text check (notes is null or length(notes) <= 4000),
  lat double precision check (lat is null or (lat between -90 and 90)),
  lon double precision check (lon is null or (lon between -180 and 180)),
  location_verified boolean not null default false,
  geocode_source text,
  location_confirmed_by uuid,
  location_confirmed_at timestamptz,
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint distributors_latlon_pair check ((lat is null) = (lon is null))
);
create index distributors_org_name_idx on public.distributors (organization_id, lower(name));
create index distributors_org_phone_idx on public.distributors (organization_id, normalized_phone);

create table public.distributor_supplies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  distributor_id uuid not null references public.distributors (id),
  supplied_at timestamptz not null,
  reference text,
  status public.purchase_status not null default 'confirmed',
  total numeric(14, 2) not null default 0 check (total >= 0),
  notes text,
  void_reason text,
  idempotency_key text not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplies_void_reason check (status <> 'void' or void_reason is not null)
);
create unique index supplies_idem_uq on public.distributor_supplies (organization_id, idempotency_key);
create index supplies_org_dist_idx on public.distributor_supplies (organization_id, distributor_id, supplied_at desc);

create table public.distributor_supply_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  supply_id uuid not null references public.distributor_supplies (id) on delete cascade,
  product_id uuid not null references public.products (id),
  product_name text not null,
  product_sku text not null,
  unit text not null,
  quantity numeric(12, 3) not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(14, 2) not null check (line_total >= 0)
);
create index supply_items_supply_idx on public.distributor_supply_items (supply_id);
create index supply_items_product_idx on public.distributor_supply_items (organization_id, product_id);

-- normalisation + pin rules (same as farmers)
create or replace function private.distributor_normalize()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.normalized_phone := private.normalize_phone(new.phone);
  if new.phone is not null and trim(new.phone) <> '' and new.normalized_phone is null then
    perform private.raise_err('validation', jsonb_build_object('field', 'phone', 'message', 'Invalid phone number'));
  end if;
  if new.gstin is not null then new.gstin := upper(trim(new.gstin)); end if;
  if tg_op = 'UPDATE' and (new.lat is distinct from old.lat or new.lon is distinct from old.lon)
     and current_setting('kisanroute.verifying_location', true) is distinct from 'on' then
    new.location_verified := false; new.location_confirmed_by := null; new.location_confirmed_at := null;
  end if;
  if tg_op = 'INSERT' and current_setting('kisanroute.verifying_location', true) is distinct from 'on' then
    new.location_verified := false;
  end if;
  if new.active = false and new.archived_at is null then new.archived_at := now(); end if;
  if new.active = true then new.archived_at := null; end if;
  return new;
end $$;

create trigger distributors_touch before update on public.distributors for each row execute function private.touch_updated();
create trigger distributor_supplies_touch before update on public.distributor_supplies for each row execute function private.touch_updated();
create trigger distributors_tenant before insert or update on public.distributors for each row execute function private.set_tenant();
create trigger distributors_normalize before insert or update on public.distributors for each row execute function private.distributor_normalize();
create trigger distributors_audit after insert or update or delete on public.distributors for each row execute function private.audit_row();
create trigger distributor_supplies_audit after insert or update or delete on public.distributor_supplies for each row execute function private.audit_row();
create trigger supply_items_immutable before update on public.distributor_supply_items for each row execute function private.deny_mutation();

alter table public.distributors enable row level security;
alter table public.distributor_supplies enable row level security;
alter table public.distributor_supply_items enable row level security;

create policy distributors_admin_select on public.distributors for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy distributors_admin_insert on public.distributors for insert to authenticated
  with check (private.is_admin());
create policy distributors_admin_update on public.distributors for update to authenticated
  using (private.is_admin() and organization_id = private.my_org())
  with check (private.is_admin() and organization_id = private.my_org());
create policy supplies_admin_select on public.distributor_supplies for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy supply_items_admin_select on public.distributor_supply_items for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

create or replace function public.verify_distributor_location(p_distributor uuid, p_lat double precision, p_lon double precision, p_source text default 'admin_pin')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); d public.distributors;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    perform private.raise_err('validation', jsonb_build_object('field', 'lat/lon'));
  end if;
  perform set_config('kisanroute.verifying_location', 'on', true);
  update public.distributors set lat = p_lat, lon = p_lon, location_verified = true,
         geocode_source = left(coalesce(p_source, 'admin_pin'), 60), location_confirmed_by = a.id, location_confirmed_at = now()
   where id = p_distributor and organization_id = a.organization_id returning * into d;
  perform set_config('kisanroute.verifying_location', 'off', true);
  if d.id is null then perform private.raise_err('not_found'); end if;
  return to_jsonb(d);
end $$;

create or replace function public.admin_create_supply(
  p_distributor uuid, p_supplied_at timestamptz, p_items jsonb, p_idempotency_key text,
  p_reference text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v_id uuid; v_item jsonb; pr public.products;
  v_qty numeric(12, 3); v_price numeric(12, 2); v_total numeric(14, 2) := 0; v_existing uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then perform private.raise_err('validation', jsonb_build_object('field', 'idempotency_key')); end if;
  select id into v_existing from public.distributor_supplies where organization_id = a.organization_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then return jsonb_build_object('supply_id', v_existing, 'replayed', true); end if;
  if not exists (select 1 from public.distributors where id = p_distributor and organization_id = a.organization_id) then perform private.raise_err('not_found'); end if;
  if p_supplied_at is null or p_supplied_at > now() + interval '1 day' then perform private.raise_err('validation', jsonb_build_object('field', 'supplied_at')); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 200 then
    perform private.raise_err('validation', jsonb_build_object('field', 'items'));
  end if;
  insert into public.distributor_supplies (organization_id, distributor_id, supplied_at, reference, notes, idempotency_key, created_by)
  values (a.organization_id, p_distributor, p_supplied_at, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''), p_idempotency_key, a.id)
  returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into pr from public.products where id = (v_item ->> 'product_id')::uuid and organization_id = a.organization_id;
    if pr.id is null then perform private.raise_err('validation', jsonb_build_object('field', 'product_id')); end if;
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then perform private.raise_err('validation', jsonb_build_object('field', 'quantity')); end if;
    v_price := coalesce((v_item ->> 'unit_price')::numeric, pr.price);
    if v_price is null or v_price < 0 then perform private.raise_err('validation', jsonb_build_object('field', 'unit_price', 'product', pr.sku)); end if;
    insert into public.distributor_supply_items (organization_id, supply_id, product_id, product_name, product_sku, unit, quantity, unit_price, line_total)
    values (a.organization_id, v_id, pr.id, pr.name, pr.sku, pr.unit, v_qty, v_price, round(v_qty * v_price, 2));
    v_total := v_total + round(v_qty * v_price, 2);
  end loop;
  update public.distributor_supplies set total = v_total where id = v_id;
  return jsonb_build_object('supply_id', v_id, 'total', v_total, 'replayed', false);
end $$;

create or replace function public.admin_void_supply(p_supply uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); s public.distributor_supplies;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'reason')); end if;
  update public.distributor_supplies set status = 'void', void_reason = trim(p_reason)
   where id = p_supply and organization_id = a.organization_id and status = 'confirmed' returning * into s;
  if s.id is null then perform private.raise_err('not_found'); end if;
  return to_jsonb(s);
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.distributors, public.distributor_supplies, public.distributor_supply_items from anon, authenticated;
    grant select on public.distributors, public.distributor_supplies, public.distributor_supply_items to authenticated;
    grant insert, update on public.distributors to authenticated;
    revoke all on function public.verify_distributor_location(uuid, double precision, double precision, text) from public, anon;
    grant execute on function public.verify_distributor_location(uuid, double precision, double precision, text) to authenticated;
    revoke all on function public.admin_create_supply(uuid, timestamptz, jsonb, text, text, text) from public, anon;
    grant execute on function public.admin_create_supply(uuid, timestamptz, jsonb, text, text, text) to authenticated;
    revoke all on function public.admin_void_supply(uuid, text) from public, anon;
    grant execute on function public.admin_void_supply(uuid, text) to authenticated;
    grant all on public.distributors, public.distributor_supplies, public.distributor_supply_items to service_role;
  end if;
end $$;
