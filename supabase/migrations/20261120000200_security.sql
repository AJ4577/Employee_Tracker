-- KisanRoute security: identity helpers, tenant triggers, audit, RLS, grants.
-- Identity always comes from the verified JWT (auth.uid(), auth.jwt()), never from request bodies.

-- ---------------------------------------------------------------- lock down schemas
revoke create on schema public from public;
revoke all on schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke create on schema public from anon, authenticated';
    execute 'revoke all on schema private from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------- default settings & helpers
create or replace function private.default_settings()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'app_name', 'KisanRoute',
    'arrival_radius_m', 100,
    'low_accuracy_m', 100,
    'stale_after_s', 600,
    'sample_interval_s', 45,
    'sample_distance_m', 75,
    'route_retention_days', 90,
    'reminder_offset_min', 60,
    'require_admin_mfa', true,
    'require_delivery_ack', false,
    'require_photo_on_complete', false,
    'map_tile_url', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'map_tile_attribution', '&copy; OpenStreetMap contributors'
  )
$$;

create or replace function private.org_settings(p_org uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select private.default_settings() || coalesce(o.settings, '{}'::jsonb)
         || jsonb_build_object('timezone', o.timezone, 'organization_name', o.name)
  from public.organizations o where o.id = p_org
$$;

create or replace function private.my_profile()
returns public.profiles language sql stable security definer set search_path = public, pg_temp as $$
  select p.* from public.profiles p where p.id = auth.uid()
$$;

create or replace function private.my_org()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select p.organization_id from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;

create or replace function private.is_active()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active')
$$;

-- Admins must hold an aal2 (MFA) session when the organization requires it.
create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active' and p.role in ('owner', 'admin')
      and (
        coalesce((private.org_settings(p.organization_id) ->> 'require_admin_mfa')::boolean, true) = false
        or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      )
  )
$$;

create or replace function private.is_owner()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select private.is_admin() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
$$;

create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'staff')
$$;

-- Visit currently assigned to the caller (reassignment/cancellation removes access to the farmer).
create or replace function private.is_my_visit(p_visit uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select private.is_active() and exists (select 1 from public.visits v where v.id = p_visit and v.staff_id = auth.uid())
$$;

create or replace function private.distance_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable set search_path = pg_catalog, pg_temp as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )))
$$;

create or replace function private.normalize_phone(raw text)
returns text language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare d text;
begin
  if raw is null then return null; end if;
  d := regexp_replace(raw, '[^0-9+]', '', 'g');
  if d like '+%' then d := substr(d, 2);
  elsif d like '00%' then d := substr(d, 3);
  elsif d like '0%' and length(d) = 11 then d := '91' || substr(d, 2);
  elsif length(d) = 10 then d := '91' || d;
  end if;
  if d !~ '^[0-9]{11,15}$' then return null; end if;
  return '+' || d;
end $$;

create or replace function private.raise_err(code text, detail jsonb default null)
returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = code, detail = coalesce(detail::text, '');
end $$;

-- ---------------------------------------------------------------- generic triggers
create or replace function private.touch_updated()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then
    begin new.updated_by := auth.uid(); exception when undefined_column then null; end;
  end if;
  return new;
end $$;

-- Force organization_id (and creator) from the caller's trusted profile for direct client writes.
-- Service-role/backend callers (auth.uid() is null) must supply organization_id explicitly.
create or replace function private.set_tenant()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  if auth.uid() is not null then
    v_org := private.my_org();
    if v_org is null then perform private.raise_err('forbidden'); end if;
    if tg_op = 'INSERT' then
      new.organization_id := v_org;
      begin new.created_by := auth.uid(); exception when undefined_column then null; end;
    elsif new.organization_id is distinct from old.organization_id then
      perform private.raise_err('forbidden');
    end if;
  end if;
  return new;
end $$;

create or replace function private.farmer_normalize()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.normalized_phone := private.normalize_phone(new.phone);
  if new.phone is not null and trim(new.phone) <> '' and new.normalized_phone is null then
    perform private.raise_err('validation', jsonb_build_object('field', 'phone', 'message', 'Invalid phone number'));
  end if;
  -- Moving the pin by direct edit clears verification unless done via verify_farmer_location().
  if tg_op = 'UPDATE' and (new.lat is distinct from old.lat or new.lon is distinct from old.lon)
     and current_setting('kisanroute.verifying_location', true) is distinct from 'on' then
    new.location_verified := false;
    new.location_confirmed_by := null;
    new.location_confirmed_at := null;
  end if;
  if tg_op = 'INSERT' and current_setting('kisanroute.verifying_location', true) is distinct from 'on' then
    new.location_verified := false;
  end if;
  if new.active = false and new.archived_at is null then new.archived_at := now(); end if;
  if new.active = true then new.archived_at := null; end if;
  return new;
end $$;

create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_diff jsonb;
  v_org uuid := coalesce((v_new ->> 'organization_id')::uuid, (v_old ->> 'organization_id')::uuid);
  k text;
begin
  if tg_op = 'UPDATE' then
    v_diff := '{}'::jsonb;
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at', 'updated_by', 'version', 'last_seen_at') and (v_new -> k) is distinct from (v_old -> k) then
        v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then return new; end if;
  else
    v_diff := coalesce(v_new, v_old);
  end if;
  -- Never copy phone numbers/addresses into the audit log in clear text.
  v_diff := v_diff - 'phone' - 'alt_contact' - 'address' - 'normalized_phone';
  insert into public.audit_log (organization_id, actor_id, action, entity, entity_id, diff, request_id)
  values (v_org, auth.uid(), lower(tg_op), tg_table_name, coalesce(v_new ->> 'id', v_old ->> 'id'), v_diff,
          nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id');
  return coalesce(new, old);
end $$;

create or replace function private.deny_mutation()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = 'append_only', detail = tg_table_name;
end $$;

-- updated_at triggers
create trigger organizations_touch before update on public.organizations for each row execute function private.touch_updated();
create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated();
create trigger products_touch before update on public.products for each row execute function private.touch_updated();
create trigger farmers_touch before update on public.farmers for each row execute function private.touch_updated();
create trigger purchases_touch before update on public.purchases for each row execute function private.touch_updated();
create trigger visits_touch before update on public.visits for each row execute function private.touch_updated();

-- tenant triggers for tables clients write directly (admin CRUD under RLS)
create trigger products_tenant before insert or update on public.products for each row execute function private.set_tenant();
create trigger farmers_tenant before insert or update on public.farmers for each row execute function private.set_tenant();
create trigger farmers_normalize before insert or update on public.farmers for each row execute function private.farmer_normalize();

-- audit triggers
create trigger products_audit after insert or update or delete on public.products for each row execute function private.audit_row();
create trigger farmers_audit after insert or update or delete on public.farmers for each row execute function private.audit_row();
create trigger purchases_audit after insert or update or delete on public.purchases for each row execute function private.audit_row();
create trigger visits_audit after insert or update or delete on public.visits for each row execute function private.audit_row();
create trigger profiles_audit after insert or update or delete on public.profiles for each row execute function private.audit_row();
create trigger organizations_audit after update on public.organizations for each row execute function private.audit_row();
create trigger invitations_audit after insert or update on public.invitations for each row execute function private.audit_row();

-- append-only tables
create trigger visit_events_append_only before update or delete on public.visit_events for each row execute function private.deny_mutation();
create trigger audit_log_append_only before update or delete on public.audit_log for each row execute function private.deny_mutation();
create trigger session_events_append_only before update or delete on public.session_events for each row execute function private.deny_mutation();

-- Purchase line items are immutable price snapshots.
create trigger purchase_items_immutable before update on public.purchase_items for each row execute function private.deny_mutation();

-- ---------------------------------------------------------------- RLS
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.invitations enable row level security;
alter table public.products enable row level security;
alter table public.farmers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.visits enable row level security;
alter table public.visit_events enable row level security;
alter table public.visit_outcomes enable row level security;
alter table public.duty_sessions enable row level security;
alter table public.trips enable row level security;
alter table public.location_points enable row level security;
alter table public.latest_staff_position enable row level security;
alter table public.user_notifications enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.device_tokens enable row level security;
alter table public.attachments enable row level security;
alter table public.audit_log enable row level security;
alter table public.session_events enable row level security;

-- organizations: members read their own org; changes only via update_org_settings()
create policy org_select on public.organizations for select to authenticated
  using (id = private.my_org());

-- profiles: self, or admins within their org
create policy profiles_select_self on public.profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_select_admin on public.profiles for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

create policy invitations_admin on public.invitations for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

-- products: admin read/write in own org (no hard delete). Staff use staff_product_options().
create policy products_admin_select on public.products for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy products_admin_insert on public.products for insert to authenticated
  with check (private.is_admin());
create policy products_admin_update on public.products for update to authenticated
  using (private.is_admin() and organization_id = private.my_org())
  with check (private.is_admin() and organization_id = private.my_org());

-- farmers: admin only. Staff receive minimal context through my_visit_detail().
create policy farmers_admin_select on public.farmers for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy farmers_admin_insert on public.farmers for insert to authenticated
  with check (private.is_admin());
create policy farmers_admin_update on public.farmers for update to authenticated
  using (private.is_admin() and organization_id = private.my_org())
  with check (private.is_admin() and organization_id = private.my_org());

-- purchases: admin read; writes via admin_create_purchase()/admin_void_purchase()
create policy purchases_admin_select on public.purchases for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy purchase_items_admin_select on public.purchase_items for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

-- visits: admin org-wide; staff only currently assigned. All writes via RPC.
create policy visits_admin_select on public.visits for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy visits_staff_select on public.visits for select to authenticated
  using (private.is_active() and staff_id = auth.uid());

create policy visit_events_admin_select on public.visit_events for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy visit_events_staff_select on public.visit_events for select to authenticated
  using (private.is_my_visit(visit_id));

create policy visit_outcomes_admin_select on public.visit_outcomes for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy visit_outcomes_staff_select on public.visit_outcomes for select to authenticated
  using (private.is_my_visit(visit_id));

create policy duty_admin_select on public.duty_sessions for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy duty_staff_select on public.duty_sessions for select to authenticated
  using (private.is_active() and staff_id = auth.uid());

create policy trips_admin_select on public.trips for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy trips_staff_select on public.trips for select to authenticated
  using (private.is_active() and staff_id = auth.uid());

create policy location_admin_select on public.location_points for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy location_staff_select on public.location_points for select to authenticated
  using (private.is_active() and staff_id = auth.uid());

create policy latest_admin_select on public.latest_staff_position for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy latest_staff_select on public.latest_staff_position for select to authenticated
  using (private.is_active() and staff_id = auth.uid());

create policy notifications_recipient_select on public.user_notifications for select to authenticated
  using (private.is_active() and recipient_id = auth.uid());

create policy outbox_admin_select on public.notification_outbox for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

create policy device_tokens_own_select on public.device_tokens for select to authenticated
  using (user_id = auth.uid());

create policy attachments_admin_select on public.attachments for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy attachments_staff_select on public.attachments for select to authenticated
  using (private.is_my_visit(visit_id));

create policy audit_admin_select on public.audit_log for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());

create policy session_events_admin_select on public.session_events for select to authenticated
  using (private.is_admin() and organization_id = private.my_org());
create policy session_events_own_select on public.session_events for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------- grants
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated, public';
    execute 'revoke all on all functions in schema private from anon, authenticated, public';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated, public';
    execute 'grant usage on schema public to anon, authenticated';
    -- authenticated may SELECT (RLS filters rows); direct writes only where a policy exists.
    execute 'grant select on all tables in schema public to authenticated';
    execute 'grant insert, update on public.products, public.farmers to authenticated';
    -- Helpers used inside RLS policies must be executable by authenticated.
    execute 'grant usage on schema private to authenticated';
    execute 'grant execute on function private.my_org(), private.is_active(), private.is_admin(), private.is_owner(), private.is_staff(), private.is_my_visit(uuid), private.org_settings(uuid), private.my_profile(), private.default_settings(), private.raise_err(text, jsonb), private.normalize_phone(text), private.distance_m(double precision, double precision, double precision, double precision) to authenticated';
  end if;
end $$;
