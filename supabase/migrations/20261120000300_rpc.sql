-- KisanRoute business functions (exposed as PostgREST RPC: POST /rest/v1/rpc/<name>).
-- Every function derives caller, role and organization from auth.uid(); request bodies
-- cannot choose staff_id/organization_id/actor. SECURITY DEFINER functions pin search_path.

-- ================================================================ internal helpers
create or replace function private.bounded_time(p timestamptz)
returns timestamptz language sql stable set search_path = pg_catalog, pg_temp as $$
  select case
    when p is null then now()
    when p > now() + interval '5 minutes' then now()
    when p < now() - interval '7 days' then now()
    else p end
$$;

create or replace function private.visit_transition_allowed(p_from public.visit_status, p_to public.visit_status)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select case p_from
    when 'assigned' then p_to in ('in_progress', 'rescheduled', 'cancelled', 'blocked')
    when 'rescheduled' then p_to in ('in_progress', 'rescheduled', 'cancelled', 'blocked')
    when 'blocked' then p_to in ('assigned', 'rescheduled', 'cancelled')
    when 'in_progress' then p_to in ('arrived', 'rescheduled', 'cancelled', 'blocked')
    when 'arrived' then p_to in ('completed', 'cancelled', 'blocked')
    else false end
$$;

create or replace function private.notify(
  p_org uuid, p_recipient uuid, p_type text, p_visit uuid, p_title text, p_body text, p_idem text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.user_notifications (organization_id, recipient_id, type, visit_id, title, body, idempotency_key)
  values (p_org, p_recipient, p_type, p_visit, p_title, p_body, p_idem)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then return; end if;
  -- Push payload is minimal: no farmer name, phone or address on the lock screen.
  insert into public.notification_outbox (organization_id, recipient_id, notification_id, type, visit_id, payload, idempotency_key)
  values (p_org, p_recipient, v_id, p_type, p_visit,
          jsonb_build_object('title', p_title, 'body', coalesce(p_body, 'Open KisanRoute for details'),
                             'data', jsonb_build_object('type', p_type, 'visit_id', p_visit, 'notification_id', v_id)),
          'push:' || p_idem)
  on conflict (idempotency_key) do nothing;
end $$;

create or replace function private.require_admin()
returns public.profiles language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  if not private.is_admin() then perform private.raise_err('forbidden'); end if;
  select * into p from public.profiles where id = auth.uid();
  return p;
end $$;

create or replace function private.require_staff_member()
returns public.profiles language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid() and status = 'active';
  if p.id is null then perform private.raise_err('forbidden'); end if;
  return p;
end $$;

create or replace function private.visit_json(p_visit uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(v) - 'organization_id' from public.visits v where v.id = p_visit
$$;

create or replace function private.lock_my_visit(p_visit uuid)
returns public.visits language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.visits;
begin
  select * into v from public.visits where id = p_visit and staff_id = auth.uid() for update;
  if v.id is null then perform private.raise_err('not_found'); end if;
  return v;
end $$;

create or replace function private.lock_org_visit(p_visit uuid, p_org uuid, p_version integer)
returns public.visits language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.visits;
begin
  select * into v from public.visits where id = p_visit and organization_id = p_org for update;
  if v.id is null then perform private.raise_err('not_found'); end if;
  if p_version is not null and v.version <> p_version then
    perform private.raise_err('version_conflict', jsonb_build_object('current_version', v.version));
  end if;
  return v;
end $$;

create or replace function private.replayed(p_visit uuid, p_idem text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_idem is not null and exists (select 1 from public.visit_events where visit_id = p_visit and idempotency_key = p_idem)
$$;

-- ================================================================ session / profile
create or replace function public.me()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.profiles; v_duty public.duty_sessions; v_trip public.trips;
begin
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then perform private.raise_err('no_profile'); end if;
  select * into v_duty from public.duty_sessions where staff_id = p.id and ended_at is null;
  select * into v_trip from public.trips where staff_id = p.id and status = 'active';
  return jsonb_build_object(
    'profile', to_jsonb(p),
    'settings', case when p.status = 'active' then private.org_settings(p.organization_id) else null end,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'is_admin', private.is_admin(),
    'duty', case when v_duty.id is null then null else to_jsonb(v_duty) end,
    'active_trip', case when v_trip.id is null then null else to_jsonb(v_trip) end,
    'unread_notifications', (select count(*) from public.user_notifications where recipient_id = p.id and read_at is null)
  );
end $$;

create or replace function public.log_session_event(p_event text, p_device text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform private.raise_err('unauthenticated'); end if;
  if p_event not in ('login', 'logout', 'mfa_verified', 'password_reset', 'invite_accepted') then
    perform private.raise_err('validation', jsonb_build_object('field', 'event'));
  end if;
  insert into public.session_events (organization_id, user_id, event, device)
  select p.organization_id, p.id, p_event, left(p_device, 200) from public.profiles p where p.id = auth.uid();
  update public.profiles set last_seen_at = now() where id = auth.uid();
end $$;

create or replace function public.accept_invitation()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles; i public.invitations;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if p.id is null then perform private.raise_err('no_profile'); end if;
  if p.status = 'active' then return jsonb_build_object('status', 'active'); end if;
  if p.status = 'suspended' then perform private.raise_err('forbidden'); end if;
  select * into i from public.invitations
   where auth_user_id = p.id and status = 'pending' order by created_at desc limit 1 for update;
  if i.id is null then perform private.raise_err('invitation_not_found'); end if;
  if i.expires_at < now() then
    update public.invitations set status = 'expired' where id = i.id;
    perform private.raise_err('invitation_expired');
  end if;
  update public.invitations set status = 'accepted', accepted_at = now() where id = i.id;
  update public.profiles set status = 'active', last_seen_at = now() where id = p.id;
  insert into public.session_events (organization_id, user_id, event) values (p.organization_id, p.id, 'invite_accepted');
  return jsonb_build_object('status', 'active');
end $$;

-- ================================================================ settings
create or replace function public.update_org_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); k text; v jsonb; v_clean jsonb := '{}'::jsonb;
  v_name text; v_tz text;
begin
  for k, v in select * from jsonb_each(coalesce(p_patch, '{}'::jsonb)) loop
    case k
      when 'organization_name' then v_name := trim(v #>> '{}');
        if v_name is null or length(v_name) not between 1 and 120 then perform private.raise_err('validation', jsonb_build_object('field', k)); end if;
      when 'timezone' then v_tz := v #>> '{}';
        if not exists (select 1 from pg_timezone_names where name = v_tz) then perform private.raise_err('validation', jsonb_build_object('field', k)); end if;
      when 'app_name', 'map_tile_url', 'map_tile_attribution' then
        if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 300 then perform private.raise_err('validation', jsonb_build_object('field', k)); end if;
        if k = 'map_tile_url' and (v #>> '{}') !~ '^https://' then perform private.raise_err('validation', jsonb_build_object('field', k, 'message', 'must be https')); end if;
        v_clean := v_clean || jsonb_build_object(k, v);
      when 'arrival_radius_m', 'low_accuracy_m', 'stale_after_s', 'sample_interval_s', 'sample_distance_m', 'route_retention_days', 'reminder_offset_min' then
        if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100000 then
          perform private.raise_err('validation', jsonb_build_object('field', k)); end if;
        if k = 'sample_interval_s' and (v #>> '{}')::numeric < 10 then perform private.raise_err('validation', jsonb_build_object('field', k, 'message', 'minimum 10 seconds')); end if;
        if k = 'arrival_radius_m' and (v #>> '{}')::numeric < 20 then perform private.raise_err('validation', jsonb_build_object('field', k, 'message', 'minimum 20 m')); end if;
        v_clean := v_clean || jsonb_build_object(k, v);
      when 'require_admin_mfa', 'require_delivery_ack', 'require_photo_on_complete' then
        if jsonb_typeof(v) <> 'boolean' then perform private.raise_err('validation', jsonb_build_object('field', k)); end if;
        if k = 'require_admin_mfa' and a.role <> 'owner' then perform private.raise_err('forbidden'); end if;
        v_clean := v_clean || jsonb_build_object(k, v);
      else perform private.raise_err('validation', jsonb_build_object('field', k, 'message', 'unknown setting'));
    end case;
  end loop;
  update public.organizations
     set settings = settings || v_clean, name = coalesce(v_name, name), timezone = coalesce(v_tz, timezone)
   where id = a.organization_id;
  return private.org_settings(a.organization_id);
end $$;

-- ================================================================ staff management (DB side)
create or replace function public.admin_update_staff(p_staff uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); s public.profiles;
begin
  select * into s from public.profiles where id = p_staff and organization_id = a.organization_id for update;
  if s.id is null then perform private.raise_err('not_found'); end if;
  if p_patch ? 'role' then
    if a.role <> 'owner' or s.id = a.id then perform private.raise_err('forbidden'); end if;
    if (p_patch ->> 'role') not in ('admin', 'staff') then perform private.raise_err('validation', jsonb_build_object('field', 'role')); end if;
  end if;
  if s.role = 'owner' and a.role <> 'owner' then perform private.raise_err('forbidden'); end if;
  if p_patch ? 'manager_id' and (p_patch ->> 'manager_id') is not null and not exists (
       select 1 from public.profiles m where m.id = (p_patch ->> 'manager_id')::uuid and m.organization_id = a.organization_id) then
    perform private.raise_err('validation', jsonb_build_object('field', 'manager_id'));
  end if;
  update public.profiles set
    display_name = coalesce(nullif(trim(p_patch ->> 'display_name'), ''), display_name),
    phone = case when p_patch ? 'phone' then nullif(trim(p_patch ->> 'phone'), '') else phone end,
    coverage_area = case when p_patch ? 'coverage_area' then nullif(trim(p_patch ->> 'coverage_area'), '') else coverage_area end,
    manager_id = case when p_patch ? 'manager_id' then (p_patch ->> 'manager_id')::uuid else manager_id end,
    role = coalesce((p_patch ->> 'role')::public.app_role, role)
  where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

-- Called by the admin-staff Edge Function, which then revokes auth sessions with the service role.
create or replace function public.admin_set_staff_status(p_staff uuid, p_status public.profile_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); s public.profiles;
begin
  select * into s from public.profiles where id = p_staff and organization_id = a.organization_id for update;
  if s.id is null then perform private.raise_err('not_found'); end if;
  if s.id = a.id or (s.role = 'owner' and a.role <> 'owner') then perform private.raise_err('forbidden'); end if;
  if p_status = 'invited' then perform private.raise_err('validation', jsonb_build_object('field', 'status')); end if;
  update public.profiles set status = p_status where id = s.id returning * into s;
  if p_status = 'suspended' then
    update public.device_tokens set active = false where user_id = s.id;
    update public.trips set status = 'abandoned', ended_at = now() where staff_id = s.id and status = 'active';
    update public.duty_sessions set ended_at = now(), end_reason = 'suspended' where staff_id = s.id and ended_at is null;
    insert into public.session_events (organization_id, user_id, event, failure_reason)
    values (s.organization_id, s.id, 'token_revoked', left(coalesce(p_reason, 'suspended'), 300));
  end if;
  return to_jsonb(s);
end $$;

-- ================================================================ farmers
create or replace function public.verify_farmer_location(p_farmer uuid, p_lat double precision, p_lon double precision, p_source text default 'admin_pin')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); f public.farmers;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    perform private.raise_err('validation', jsonb_build_object('field', 'lat/lon'));
  end if;
  perform set_config('kisanroute.verifying_location', 'on', true);
  update public.farmers set lat = p_lat, lon = p_lon, location_verified = true,
         geocode_source = left(coalesce(p_source, 'admin_pin'), 60),
         location_confirmed_by = a.id, location_confirmed_at = now()
   where id = p_farmer and organization_id = a.organization_id returning * into f;
  perform set_config('kisanroute.verifying_location', 'off', true);
  if f.id is null then perform private.raise_err('not_found'); end if;
  -- Open visits that relied on the farmer pin follow the confirmed location.
  update public.visits set target_lat = p_lat, target_lon = p_lon, version = version + 1
   where farmer_id = f.id and status in ('assigned', 'rescheduled', 'blocked');
  return to_jsonb(f);
end $$;

create or replace function public.find_farmer_duplicates(p_phone text, p_name text default null, p_exclude uuid default null)
returns table (id uuid, name text, village text, normalized_phone text, match text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v_norm text := private.normalize_phone(p_phone);
begin
  return query
    select f.id, f.name, f.village, f.normalized_phone,
           case when v_norm is not null and f.normalized_phone = v_norm then 'phone' else 'name' end
      from public.farmers f
     where f.organization_id = a.organization_id
       and (p_exclude is null or f.id <> p_exclude)
       and ((v_norm is not null and f.normalized_phone = v_norm)
            or (p_name is not null and length(trim(p_name)) >= 3 and lower(f.name) = lower(trim(p_name))))
     limit 10;
end $$;

-- ================================================================ purchases
create or replace function public.admin_create_purchase(
  p_farmer uuid, p_purchased_at timestamptz, p_items jsonb, p_idempotency_key text,
  p_external_reference text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v_id uuid; v_item jsonb; pr public.products;
  v_qty numeric(12, 3); v_price numeric(12, 2); v_total numeric(14, 2) := 0; v_existing uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then perform private.raise_err('validation', jsonb_build_object('field', 'idempotency_key')); end if;
  select id into v_existing from public.purchases where organization_id = a.organization_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then return jsonb_build_object('purchase_id', v_existing, 'replayed', true); end if;
  if not exists (select 1 from public.farmers where id = p_farmer and organization_id = a.organization_id) then perform private.raise_err('not_found'); end if;
  if p_purchased_at is null or p_purchased_at > now() + interval '1 day' then perform private.raise_err('validation', jsonb_build_object('field', 'purchased_at')); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    perform private.raise_err('validation', jsonb_build_object('field', 'items'));
  end if;
  insert into public.purchases (organization_id, farmer_id, purchased_at, external_reference, notes, idempotency_key, created_by)
  values (a.organization_id, p_farmer, p_purchased_at, nullif(trim(p_external_reference), ''), nullif(trim(p_notes), ''), p_idempotency_key, a.id)
  returning id into v_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into pr from public.products where id = (v_item ->> 'product_id')::uuid and organization_id = a.organization_id;
    if pr.id is null then perform private.raise_err('validation', jsonb_build_object('field', 'product_id')); end if;
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then perform private.raise_err('validation', jsonb_build_object('field', 'quantity')); end if;
    v_price := coalesce((v_item ->> 'unit_price')::numeric, pr.price);
    if v_price is null or v_price < 0 then perform private.raise_err('validation', jsonb_build_object('field', 'unit_price', 'product', pr.sku)); end if;
    insert into public.purchase_items (organization_id, purchase_id, product_id, product_name, product_sku, unit, quantity, unit_price, line_total)
    values (a.organization_id, v_id, pr.id, pr.name, pr.sku, pr.unit, v_qty, v_price, round(v_qty * v_price, 2));
    v_total := v_total + round(v_qty * v_price, 2);
  end loop;
  update public.purchases set total = v_total where id = v_id;
  return jsonb_build_object('purchase_id', v_id, 'total', v_total, 'replayed', false);
end $$;

create or replace function public.admin_void_purchase(p_purchase uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); p public.purchases;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'reason')); end if;
  update public.purchases set status = 'void', void_reason = trim(p_reason)
   where id = p_purchase and organization_id = a.organization_id and status = 'confirmed' returning * into p;
  if p.id is null then perform private.raise_err('not_found'); end if;
  return to_jsonb(p);
end $$;

-- ================================================================ visits (admin)
create or replace function public.admin_create_visit(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); f public.farmers; s public.profiles; v public.visits;
  v_sched timestamptz; v_due timestamptz; v_lat double precision; v_lon double precision; v_warn jsonb := '[]'::jsonb;
  v_products uuid[] := '{}'; v_tz text;
begin
  select * into f from public.farmers where id = (p ->> 'farmer_id')::uuid and organization_id = a.organization_id and active;
  if f.id is null then perform private.raise_err('validation', jsonb_build_object('field', 'farmer_id')); end if;
  select * into s from public.profiles where id = (p ->> 'staff_id')::uuid and organization_id = a.organization_id and status = 'active';
  if s.id is null then perform private.raise_err('validation', jsonb_build_object('field', 'staff_id', 'message', 'Staff must be active in this organization')); end if;
  v_sched := (p ->> 'scheduled_at')::timestamptz;
  if v_sched is null then perform private.raise_err('validation', jsonb_build_object('field', 'scheduled_at')); end if;
  v_due := (p ->> 'due_at')::timestamptz;
  if v_due is not null and v_due < v_sched then perform private.raise_err('validation', jsonb_build_object('field', 'due_at', 'message', 'Due time is before scheduled time')); end if;
  v_tz := coalesce(p ->> 'timezone', (select timezone from public.organizations where id = a.organization_id));
  if not exists (select 1 from pg_timezone_names where name = v_tz) then perform private.raise_err('validation', jsonb_build_object('field', 'timezone')); end if;
  if p ? 'product_ids' and jsonb_typeof(p -> 'product_ids') = 'array' then
    select coalesce(array_agg(pr.id), '{}') into v_products from public.products pr
     where pr.organization_id = a.organization_id and pr.id in (select (x #>> '{}')::uuid from jsonb_array_elements(p -> 'product_ids') x);
  end if;
  v_lat := coalesce((p ->> 'target_lat')::double precision, f.lat);
  v_lon := coalesce((p ->> 'target_lon')::double precision, f.lon);
  if f.lat is null and p ->> 'target_lat' is null then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'no_farmer_pin', 'message', 'Farmer has no map pin yet'));
  elsif not f.location_verified and p ->> 'target_lat' is null then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'pin_unverified', 'message', 'Farmer pin is approximate (not confirmed)'));
  end if;
  if exists (select 1 from public.visits ov where ov.staff_id = s.id and ov.status in ('assigned', 'rescheduled', 'in_progress', 'arrived')
             and ov.scheduled_at between v_sched - interval '60 minutes' and v_sched + interval '60 minutes') then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'overlap', 'message', 'Staff has another visit within 60 minutes'));
  end if;

  insert into public.visits (organization_id, farmer_id, staff_id, type, instructions, scheduled_at, timezone, due_at, priority,
                             product_ids, target_lat, target_lon, parent_visit_id, created_by, updated_by)
  values (a.organization_id, f.id, s.id, coalesce((p ->> 'type')::public.task_type, 'meeting'), nullif(trim(p ->> 'instructions'), ''),
          v_sched, v_tz, v_due, coalesce((p ->> 'priority')::public.priority, 'normal'), v_products, v_lat, v_lon,
          (p ->> 'parent_visit_id')::uuid, a.id, a.id)
  returning * into v;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, to_status, occurred_at, source, metadata)
  values (a.organization_id, v.id, a.id, 'assigned', 'assigned', now(), 'server', jsonb_build_object('staff_id', s.id));
  perform private.notify(a.organization_id, s.id, 'visit_assigned', v.id, 'New visit assigned', 'You have a new field visit. Open KisanRoute for details.', 'assigned:' || v.id || ':' || s.id);
  return jsonb_build_object('visit', private.visit_json(v.id), 'warnings', v_warn);
end $$;

create or replace function public.admin_update_visit(p_visit uuid, p_version integer, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v public.visits := private.lock_org_visit(p_visit, a.organization_id, p_version);
begin
  if v.status in ('completed', 'cancelled') then perform private.raise_err('invalid_transition'); end if;
  update public.visits set
    instructions = case when p_patch ? 'instructions' then nullif(trim(p_patch ->> 'instructions'), '') else instructions end,
    priority = coalesce((p_patch ->> 'priority')::public.priority, priority),
    type = coalesce((p_patch ->> 'type')::public.task_type, type),
    due_at = case when p_patch ? 'due_at' then (p_patch ->> 'due_at')::timestamptz else due_at end,
    target_lat = case when p_patch ? 'target_lat' then (p_patch ->> 'target_lat')::double precision else target_lat end,
    target_lon = case when p_patch ? 'target_lon' then (p_patch ->> 'target_lon')::double precision else target_lon end,
    version = version + 1
  where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, occurred_at, metadata)
  values (a.organization_id, v.id, a.id, 'updated', now(), p_patch - 'target_lat' - 'target_lon');
  perform private.notify(a.organization_id, v.staff_id, 'visit_updated', v.id, 'Visit updated', 'One of your visits was updated.', 'updated:' || v.id || ':' || (v.version + 1));
  return private.visit_json(v.id);
end $$;

create or replace function public.admin_reassign_visit(p_visit uuid, p_new_staff uuid, p_reason text, p_version integer default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v public.visits := private.lock_org_visit(p_visit, a.organization_id, p_version);
  s public.profiles; v_old uuid := v.staff_id;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'reason')); end if;
  if v.status in ('completed', 'cancelled') then perform private.raise_err('invalid_transition'); end if;
  select * into s from public.profiles where id = p_new_staff and organization_id = a.organization_id and status = 'active';
  if s.id is null then perform private.raise_err('validation', jsonb_build_object('field', 'staff_id')); end if;
  if s.id = v_old then perform private.raise_err('validation', jsonb_build_object('field', 'staff_id', 'message', 'Already assigned to this staff member')); end if;
  update public.trips set status = 'abandoned', ended_at = now() where visit_id = v.id and status = 'active';
  update public.visits set staff_id = s.id, status = 'assigned', started_at = null, arrived_at = null,
         status_reason = trim(p_reason), version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, reason, metadata)
  values (a.organization_id, v.id, a.id, 'reassigned', v.status, 'assigned', now(), trim(p_reason), jsonb_build_object('from_staff', v_old, 'to_staff', s.id));
  perform private.notify(a.organization_id, v_old, 'visit_reassigned_away', null, 'Visit reassigned', 'A visit was moved to another team member.', 'reassign-away:' || v.id || ':' || (v.version + 1));
  perform private.notify(a.organization_id, s.id, 'visit_assigned', v.id, 'New visit assigned', 'You have a new field visit. Open KisanRoute for details.', 'assigned:' || v.id || ':' || s.id || ':' || (v.version + 1));
  return private.visit_json(v.id);
end $$;

create or replace function public.admin_cancel_visit(p_visit uuid, p_reason text, p_version integer default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v public.visits := private.lock_org_visit(p_visit, a.organization_id, p_version);
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'reason')); end if;
  if not private.visit_transition_allowed(v.status, 'cancelled') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'cancelled')); end if;
  update public.trips set status = 'abandoned', ended_at = now() where visit_id = v.id and status = 'active';
  update public.visits set status = 'cancelled', cancelled_at = now(), status_reason = trim(p_reason), version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, reason)
  values (a.organization_id, v.id, a.id, 'cancelled', v.status, 'cancelled', now(), trim(p_reason));
  perform private.notify(a.organization_id, v.staff_id, 'visit_cancelled', v.id, 'Visit cancelled', 'One of your visits was cancelled.', 'cancel:' || v.id);
  return private.visit_json(v.id);
end $$;

create or replace function public.admin_reschedule_visit(p_visit uuid, p_scheduled_at timestamptz, p_reason text, p_version integer default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v public.visits := private.lock_org_visit(p_visit, a.organization_id, p_version);
begin
  if p_reason is null or length(trim(p_reason)) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'reason')); end if;
  if p_scheduled_at is null then perform private.raise_err('validation', jsonb_build_object('field', 'scheduled_at')); end if;
  if not private.visit_transition_allowed(v.status, 'rescheduled') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'rescheduled')); end if;
  update public.trips set status = 'abandoned', ended_at = now() where visit_id = v.id and status = 'active';
  update public.visits set status = 'rescheduled', scheduled_at = p_scheduled_at,
         due_at = case when due_at is not null and due_at < p_scheduled_at then null else due_at end,
         started_at = null, arrived_at = null, status_reason = trim(p_reason), version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, reason, metadata)
  values (a.organization_id, v.id, a.id, 'rescheduled', v.status, 'rescheduled', now(), trim(p_reason),
          jsonb_build_object('from', v.scheduled_at, 'to', p_scheduled_at));
  perform private.notify(a.organization_id, v.staff_id, 'visit_rescheduled', v.id, 'Visit rescheduled', 'A visit time has changed.', 'resched:' || v.id || ':' || (v.version + 1));
  return private.visit_json(v.id);
end $$;

-- ================================================================ duty (staff)
create or replace function public.start_duty(p_mode public.duty_mode default 'tracking')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); d public.duty_sessions;
begin
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null;
  if d.id is not null then
    if d.mode <> p_mode then update public.duty_sessions set mode = p_mode where id = d.id returning * into d; end if;
    return to_jsonb(d);
  end if;
  insert into public.duty_sessions (organization_id, staff_id, mode) values (s.organization_id, s.id, p_mode) returning * into d;
  update public.profiles set last_seen_at = now() where id = s.id;
  return to_jsonb(d);
end $$;

create or replace function public.end_duty()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); d public.duty_sessions; t public.trips;
begin
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null for update;
  if d.id is null then return null; end if;
  -- An open return leg is closed at duty end; an open outbound leg is left for review (visit not reached).
  for t in select * from public.trips where staff_id = s.id and status = 'active' loop
    update public.trips set status = 'ended', ended_at = now() where id = t.id;
    insert into public.visit_events (organization_id, visit_id, actor_id, event_type, occurred_at, source, reason)
    values (s.organization_id, t.visit_id, s.id, case when t.leg = 'return' then 'return_ended' else 'trip_ended_by_duty' end, now(), 'server', 'Duty ended');
  end loop;
  update public.duty_sessions set ended_at = now(), end_reason = 'staff_ended' where id = d.id returning * into d;
  return to_jsonb(d);
end $$;

-- ================================================================ visit transitions (staff)
create or replace function public.staff_start_visit(
  p_visit uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; d public.duty_sessions; t public.trips;
  v_at timestamptz := private.bounded_time(p_device_time);
begin
  v := private.lock_my_visit(p_visit);
  if private.replayed(v.id, p_idempotency_key) then return private.visit_json(v.id) || jsonb_build_object('replayed', true); end if;
  if not private.visit_transition_allowed(v.status, 'in_progress') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'in_progress')); end if;
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null;
  if d.id is null then perform private.raise_err('duty_not_started'); end if;
  if exists (select 1 from public.trips where staff_id = s.id and status = 'active') then perform private.raise_err('active_trip_exists'); end if;
  insert into public.trips (organization_id, visit_id, staff_id, duty_id, leg, started_at, start_lat, start_lon)
  values (s.organization_id, v.id, s.id, d.id, 'outbound', v_at, p_lat, p_lon) returning * into t;
  update public.visits set status = 'in_progress', started_at = v_at, version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, lat, lon, accuracy_m, source, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'trip_started', v.status, 'in_progress', v_at, p_lat, p_lon, p_accuracy_m,
          case when p_lat is null then 'manual' else 'device' end, p_idempotency_key, jsonb_build_object('trip_id', t.id, 'device_time', p_device_time));
  return private.visit_json(v.id) || jsonb_build_object('trip', to_jsonb(t), 'replayed', false);
end $$;

create or replace function public.staff_arrive_visit(
  p_visit uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; cfg jsonb;
  v_at timestamptz := private.bounded_time(p_device_time); v_dist double precision; v_kind text; v_flag boolean := false;
begin
  v := private.lock_my_visit(p_visit);
  if private.replayed(v.id, p_idempotency_key) then return private.visit_json(v.id) || jsonb_build_object('replayed', true); end if;
  if not private.visit_transition_allowed(v.status, 'arrived') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'arrived')); end if;
  cfg := private.org_settings(s.organization_id);
  if v.target_lat is null then v_kind := 'no_target_pin';
  elsif p_lat is null or p_lon is null then v_kind := 'no_device_fix';
  else
    if p_lat not between -90 and 90 or p_lon not between -180 and 180 then perform private.raise_err('validation', jsonb_build_object('field', 'lat/lon')); end if;
    v_dist := private.distance_m(p_lat, p_lon, v.target_lat, v.target_lon);
    if coalesce(p_accuracy_m, 9999) > (cfg ->> 'low_accuracy_m')::numeric then v_kind := 'low_accuracy';
    elsif v_dist <= (cfg ->> 'arrival_radius_m')::numeric then v_kind := 'inside';
    else v_kind := 'outside'; end if;
  end if;
  if v_kind <> 'inside' then
    if p_override_reason is null or length(trim(p_override_reason)) < 3 then
      perform private.raise_err('reason_required', jsonb_build_object('geofence', v_kind, 'distance_m', round(v_dist::numeric), 'radius_m', cfg ->> 'arrival_radius_m'));
    end if;
    v_flag := true;
  end if;
  update public.trips set status = 'ended', ended_at = v_at, end_lat = p_lat, end_lon = p_lon
   where visit_id = v.id and leg = 'outbound' and status = 'active';
  update public.visits set status = 'arrived', arrived_at = v_at, version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, lat, lon, accuracy_m, distance_m,
                                   source, reason, flagged, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'arrived', v.status, 'arrived', v_at, p_lat, p_lon, p_accuracy_m, v_dist,
          case when v_kind = 'inside' then 'device' else 'manual' end, nullif(trim(p_override_reason), ''), v_flag, p_idempotency_key,
          jsonb_build_object('geofence', v_kind, 'radius_m', cfg -> 'arrival_radius_m', 'device_time', p_device_time));
  return private.visit_json(v.id) || jsonb_build_object('geofence', v_kind, 'distance_m', v_dist, 'flagged', v_flag, 'replayed', false);
end $$;

create or replace function public.staff_complete_visit(p_visit uuid, p_idempotency_key text, p_outcome jsonb, p_device_time timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; cfg jsonb; v_text text;
  v_at timestamptz := private.bounded_time(p_device_time); v_next timestamptz; v_follow uuid; v_discussed uuid[] := '{}';
begin
  v := private.lock_my_visit(p_visit);
  -- A completed visit can never be completed again (offline retries / double taps return current state).
  if v.status = 'completed' then return private.visit_json(v.id) || jsonb_build_object('replayed', true); end if;
  if not private.visit_transition_allowed(v.status, 'completed') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'completed')); end if;
  cfg := private.org_settings(s.organization_id);
  v_text := trim(p_outcome ->> 'outcome_text');
  if v_text is null or length(v_text) < 3 then perform private.raise_err('validation', jsonb_build_object('field', 'outcome_text', 'message', 'Outcome is required')); end if;
  if v.type = 'delivery' and (cfg ->> 'require_delivery_ack')::boolean and coalesce((p_outcome ->> 'delivery_confirmation')::boolean, false) = false then
    perform private.raise_err('validation', jsonb_build_object('field', 'delivery_confirmation', 'message', 'Delivery acknowledgement required'));
  end if;
  if (cfg ->> 'require_photo_on_complete')::boolean and not exists (select 1 from public.attachments where visit_id = v.id) then
    perform private.raise_err('validation', jsonb_build_object('field', 'photo', 'message', 'Proof photo required'));
  end if;
  if jsonb_typeof(p_outcome -> 'products_discussed') = 'array' then
    select coalesce(array_agg(pr.id), '{}') into v_discussed from public.products pr
     where pr.organization_id = s.organization_id and pr.id in (select (x #>> '{}')::uuid from jsonb_array_elements(p_outcome -> 'products_discussed') x);
  end if;
  v_next := (p_outcome ->> 'next_followup_at')::timestamptz;
  insert into public.visit_outcomes (visit_id, organization_id, outcome_text, products_discussed, products_delivered, next_action, next_followup_at,
                                     delivery_confirmation, completed_by, device_recorded_at)
  values (v.id, s.organization_id, v_text, v_discussed, coalesce(p_outcome -> 'products_delivered', '[]'::jsonb),
          nullif(trim(p_outcome ->> 'next_action'), ''), v_next, (p_outcome ->> 'delivery_confirmation')::boolean, s.id, p_device_time);
  update public.visits set status = 'completed', completed_at = v_at, version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, source, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'completed', v.status, 'completed', v_at, 'device', p_idempotency_key,
          jsonb_build_object('device_time', p_device_time, 'next_followup_at', v_next));
  if v_next is not null and v_next > now() then
    insert into public.visits (organization_id, farmer_id, staff_id, type, instructions, scheduled_at, timezone, priority, target_lat, target_lon, parent_visit_id, created_by)
    values (v.organization_id, v.farmer_id, s.id, 'follow_up', nullif(trim(p_outcome ->> 'next_action'), ''), v_next, v.timezone, 'normal', v.target_lat, v.target_lon, v.id, s.id)
    on conflict (parent_visit_id) where parent_visit_id is not null do nothing
    returning id into v_follow;
    if v_follow is not null then
      insert into public.visit_events (organization_id, visit_id, actor_id, event_type, to_status, occurred_at, metadata)
      values (v.organization_id, v_follow, s.id, 'assigned', 'assigned', now(), jsonb_build_object('follow_up_of', v.id));
      perform private.notify(v.organization_id, s.id, 'visit_assigned', v_follow, 'Follow-up scheduled', 'A follow-up visit was added to your list.', 'assigned:' || v_follow || ':' || s.id);
    end if;
  end if;
  return private.visit_json(v.id) || jsonb_build_object('follow_up_visit_id', v_follow, 'replayed', false);
end $$;

create or replace function public.staff_start_return(
  p_visit uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; d public.duty_sessions; t public.trips;
  v_at timestamptz := private.bounded_time(p_device_time);
begin
  v := private.lock_my_visit(p_visit);
  if private.replayed(v.id, p_idempotency_key) then
    select * into t from public.trips where visit_id = v.id and leg = 'return' and status <> 'abandoned';
    return jsonb_build_object('trip', to_jsonb(t), 'replayed', true);
  end if;
  if v.status <> 'completed' then perform private.raise_err('invalid_transition', jsonb_build_object('message', 'Complete the meeting before starting the return leg')); end if;
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null;
  if d.id is null then perform private.raise_err('duty_not_started'); end if;
  if exists (select 1 from public.trips where staff_id = s.id and status = 'active') then perform private.raise_err('active_trip_exists'); end if;
  if exists (select 1 from public.trips where visit_id = v.id and leg = 'return' and status <> 'abandoned') then perform private.raise_err('invalid_transition', jsonb_build_object('message', 'Return already recorded')); end if;
  insert into public.trips (organization_id, visit_id, staff_id, duty_id, leg, started_at, start_lat, start_lon)
  values (s.organization_id, v.id, s.id, d.id, 'return', v_at, p_lat, p_lon) returning * into t;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, occurred_at, lat, lon, accuracy_m, source, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'return_started', v_at, p_lat, p_lon, p_accuracy_m, case when p_lat is null then 'manual' else 'device' end,
          p_idempotency_key, jsonb_build_object('trip_id', t.id));
  return jsonb_build_object('trip', to_jsonb(t), 'replayed', false);
end $$;

create or replace function public.staff_end_trip(
  p_trip uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); t public.trips; v_at timestamptz := private.bounded_time(p_device_time);
begin
  select * into t from public.trips where id = p_trip and staff_id = s.id for update;
  if t.id is null then perform private.raise_err('not_found'); end if;
  if private.replayed(t.visit_id, p_idempotency_key) or t.status <> 'active' then return jsonb_build_object('trip', to_jsonb(t), 'replayed', true); end if;
  if t.leg = 'outbound' then perform private.raise_err('invalid_transition', jsonb_build_object('message', 'Outbound leg ends when you mark arrival')); end if;
  update public.trips set status = 'ended', ended_at = greatest(v_at, t.started_at), end_lat = p_lat, end_lon = p_lon where id = t.id returning * into t;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, occurred_at, lat, lon, accuracy_m, source, idempotency_key, metadata)
  values (s.organization_id, t.visit_id, s.id, 'return_ended', t.ended_at, p_lat, p_lon, p_accuracy_m, case when p_lat is null then 'manual' else 'device' end,
          p_idempotency_key, jsonb_build_object('trip_id', t.id));
  return jsonb_build_object('trip', to_jsonb(t), 'replayed', false);
end $$;

-- ================================================================ location ingestion (staff app)
create or replace function public.ingest_location_batch(p_points jsonb, p_trip uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); d public.duty_sessions; t public.trips; cfg jsonb;
  pt jsonb; v_prev_lat double precision; v_prev_lon double precision; v_prev_time timestamptz; v_quality public.location_quality; v_time timestamptz; v_lat double precision; v_lon double precision;
  v_acc real; v_seq integer; v_cid uuid; v_speed double precision; v_dt double precision;
  v_accepted jsonb := '[]'::jsonb; v_rejected jsonb := '[]'::jsonb; v_inserted integer; v_best record;
begin
  if jsonb_typeof(p_points) <> 'array' then perform private.raise_err('validation', jsonb_build_object('field', 'points')); end if;
  if jsonb_array_length(p_points) > 200 then perform private.raise_err('validation', jsonb_build_object('field', 'points', 'message', 'max 200 per batch')); end if;
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null;
  if d.id is null then perform private.raise_err('duty_not_started'); end if;
  if d.mode = 'limited' then perform private.raise_err('tracking_disabled'); end if;
  if p_trip is not null then
    select * into t from public.trips where id = p_trip and staff_id = s.id;
    if t.id is null then perform private.raise_err('not_found'); end if;
  end if;
  cfg := private.org_settings(s.organization_id);
  select lat, lon, device_time into v_prev_lat, v_prev_lon, v_prev_time from public.location_points where staff_id = s.id and quality = 'ok' order by device_time desc limit 1;

  for pt in select * from jsonb_array_elements(p_points) order by (value ->> 'sequence')::int nulls last loop
    begin
      v_cid := (pt ->> 'client_event_id')::uuid;
      v_seq := (pt ->> 'sequence')::int;
      v_time := (pt ->> 'device_time')::timestamptz;
      v_lat := (pt ->> 'lat')::double precision;
      v_lon := (pt ->> 'lon')::double precision;
      v_acc := (pt ->> 'accuracy_m')::real;
    exception when others then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('client_event_id', pt ->> 'client_event_id', 'reason', 'malformed'));
      continue;
    end;
    if v_cid is null or v_seq is null or v_seq < 0 or v_time is null or v_acc is null or v_acc < 0
       or v_lat is null or v_lon is null or v_lat not between -90 and 90 or v_lon not between -180 and 180 then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('client_event_id', v_cid, 'reason', 'invalid_values'));
      continue;
    end if;
    if v_time < d.started_at - interval '2 minutes' then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('client_event_id', v_cid, 'reason', 'outside_duty'));
      continue;
    end if;
    v_quality := 'ok';
    if v_time > now() + interval '5 minutes' then v_quality := 'clock_drift';
    elsif v_time < now() - make_interval(secs => greatest((cfg ->> 'stale_after_s')::numeric, 3600) * 24) then v_quality := 'stale';
    elsif v_prev_time is not null then
      v_dt := extract(epoch from (v_time - v_prev_time));
      if v_dt > 0 then
        v_speed := private.distance_m(v_prev_lat, v_prev_lon, v_lat, v_lon) / v_dt;
        if v_speed > 70 then v_quality := 'teleport'; end if;
      end if;
    end if;
    if v_quality = 'ok' and v_acc > (cfg ->> 'low_accuracy_m')::numeric then v_quality := 'low_accuracy'; end if;

    insert into public.location_points (organization_id, staff_id, duty_id, trip_id, client_event_id, sequence, device_time, lat, lon, accuracy_m, speed_ms, quality)
    values (s.organization_id, s.id, d.id, t.id, v_cid, v_seq, v_time, v_lat, v_lon, v_acc, (pt ->> 'speed_ms')::real, v_quality)
    on conflict (staff_id, client_event_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      v_accepted := v_accepted || jsonb_build_array(jsonb_build_object('client_event_id', v_cid, 'duplicate', true));
      continue;
    end if;
    v_accepted := v_accepted || jsonb_build_array(jsonb_build_object('client_event_id', v_cid, 'quality', v_quality));
    if v_quality = 'ok' then v_prev_lat := v_lat; v_prev_lon := v_lon; v_prev_time := v_time; end if;
  end loop;

  if t.id is not null then
    update public.trips set last_sequence = greatest(last_sequence, coalesce((select max((x ->> 'sequence')::int) from jsonb_array_elements(p_points) x), 0)) where id = t.id;
  end if;

  -- Latest position: newest accepted point by device time (ok or low_accuracy), never older than what we have.
  select lp.lat, lp.lon, lp.accuracy_m, lp.device_time, lp.quality, lp.trip_id into v_best
    from public.location_points lp
   where lp.staff_id = s.id and lp.duty_id = d.id and lp.quality in ('ok', 'low_accuracy')
   order by lp.device_time desc limit 1;
  if v_best.device_time is not null then
    insert into public.latest_staff_position (staff_id, organization_id, duty_id, trip_id, lat, lon, accuracy_m, device_time, received_at, source, quality)
    values (s.id, s.organization_id, d.id, v_best.trip_id, v_best.lat, v_best.lon, v_best.accuracy_m, v_best.device_time, now(), 'device', v_best.quality)
    on conflict (staff_id) do update set duty_id = excluded.duty_id, trip_id = excluded.trip_id, lat = excluded.lat, lon = excluded.lon,
      accuracy_m = excluded.accuracy_m, device_time = excluded.device_time, received_at = excluded.received_at, quality = excluded.quality
      where public.latest_staff_position.device_time <= excluded.device_time;
  end if;
  update public.profiles set last_seen_at = now() where id = s.id;

  return jsonb_build_object('accepted', v_accepted, 'rejected', v_rejected, 'server_time', now(),
    'duty', jsonb_build_object('id', d.id, 'active', true, 'mode', d.mode),
    'trip', case when t.id is null then null else (select jsonb_build_object('id', x.id, 'status', x.status, 'leg', x.leg) from public.trips x where x.id = t.id) end);
end $$;

-- ================================================================ staff read models
create or replace function public.my_visits(p_from timestamptz default null, p_to timestamptz default null, p_scope text default 'open')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member();
begin
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.scheduled_at) from (
      select v.id, v.type, v.status, v.priority, v.scheduled_at, v.timezone, v.due_at, v.instructions, v.version,
             v.started_at, v.arrived_at, v.completed_at, v.target_lat, v.target_lon,
             f.name as farmer_name, f.village, f.district, f.location_verified,
             (select tr.id from public.trips tr where tr.visit_id = v.id and tr.status = 'active') as active_trip_id,
             exists (select 1 from public.trips tr where tr.visit_id = v.id and tr.leg = 'return' and tr.status <> 'abandoned') as return_recorded
        from public.visits v join public.farmers f on f.id = v.farmer_id
       where v.staff_id = s.id
         and (p_from is null or v.scheduled_at >= p_from)
         and (p_to is null or v.scheduled_at < p_to)
         and case p_scope
               when 'open' then v.status in ('assigned', 'rescheduled', 'in_progress', 'arrived', 'blocked')
               when 'history' then v.status in ('completed', 'cancelled')
               else true end
       order by v.scheduled_at
       limit 500) x), '[]'::jsonb);
end $$;

create or replace function public.my_visit_detail(p_visit uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; f public.farmers;
begin
  select * into v from public.visits where id = p_visit and staff_id = s.id;
  if v.id is null then perform private.raise_err('not_found'); end if;
  select * into f from public.farmers where id = v.farmer_id;
  return jsonb_build_object(
    'visit', to_jsonb(v) - 'organization_id',
    'farmer', jsonb_build_object('id', f.id, 'name', f.name, 'phone', f.phone, 'alt_contact', f.alt_contact, 'village', f.village,
      'district', f.district, 'state', f.state, 'postcode', f.postcode, 'address', f.address, 'crops', f.crops,
      'lat', f.lat, 'lon', f.lon, 'location_verified', f.location_verified),
    'recent_purchases', coalesce((select jsonb_agg(jsonb_build_object('purchased_at', p.purchased_at, 'items',
        (select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity, 'unit', i.unit)) from public.purchase_items i where i.purchase_id = p.id))
        order by p.purchased_at desc)
      from (select * from public.purchases where farmer_id = f.id and status = 'confirmed' order by purchased_at desc limit 5) p), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name, 'sku', pr.sku)) from public.products pr where pr.id = any (v.product_ids)), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'occurred_at', e.occurred_at, 'received_at', e.received_at,
        'reason', e.reason, 'flagged', e.flagged, 'distance_m', e.distance_m, 'accuracy_m', e.accuracy_m) order by e.occurred_at)
      from public.visit_events e where e.visit_id = v.id and (e.actor_id = s.id or e.event_type in ('assigned', 'rescheduled', 'updated'))), '[]'::jsonb),
    'outcome', (select to_jsonb(o) - 'organization_id' from public.visit_outcomes o where o.visit_id = v.id),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) - 'organization_id' order by t.started_at) from public.trips t where t.visit_id = v.id and t.staff_id = s.id), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'mime_type', a.mime_type, 'kind', a.kind, 'created_at', a.created_at))
      from public.attachments a where a.visit_id = v.id), '[]'::jsonb)
  );
end $$;

create or replace function public.staff_product_options()
returns table (id uuid, name text, sku text, unit text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member();
begin
  return query select p.id, p.name, p.sku, p.unit from public.products p
   where p.organization_id = s.organization_id and p.active order by p.name limit 1000;
end $$;

-- ================================================================ notifications & devices
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; s public.profiles := private.require_staff_member();
begin
  update public.user_notifications set read_at = now()
   where recipient_id = s.id and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.register_push_token(p_token text, p_platform text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member();
begin
  if p_token is null or length(p_token) not between 10 and 300 then perform private.raise_err('validation', jsonb_build_object('field', 'token')); end if;
  if p_platform not in ('android', 'ios', 'web') then perform private.raise_err('validation', jsonb_build_object('field', 'platform')); end if;
  -- A token moves with the device: re-registering under a new user rebinds it.
  insert into public.device_tokens (organization_id, user_id, platform, token)
  values (s.organization_id, s.id, p_platform, p_token)
  on conflict (token) do update set organization_id = excluded.organization_id, user_id = excluded.user_id,
     platform = excluded.platform, active = true, last_seen_at = now();
end $$;

create or replace function public.revoke_push_token(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.device_tokens set active = false where token = p_token and user_id = auth.uid();
end $$;

-- ================================================================ attachments
create or replace function public.register_attachment(p_visit uuid, p_storage_path text, p_mime text, p_size integer, p_kind text default 'photo')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; a public.attachments; cfg jsonb;
begin
  select * into v from public.visits where id = p_visit and organization_id = s.organization_id
     and (staff_id = s.id or private.is_admin());
  if v.id is null then perform private.raise_err('not_found'); end if;
  if p_storage_path is null or p_storage_path not like (v.organization_id::text || '/' || v.id::text || '/%') or p_storage_path like '%..%' then
    perform private.raise_err('validation', jsonb_build_object('field', 'storage_path'));
  end if;
  cfg := private.org_settings(s.organization_id);
  insert into public.attachments (organization_id, visit_id, storage_path, mime_type, size_bytes, kind, uploaded_by, retention_until)
  values (v.organization_id, v.id, p_storage_path, p_mime, p_size, coalesce(p_kind, 'photo'), s.id, now() + interval '2 years')
  returning * into a;
  return to_jsonb(a) - 'organization_id';
end $$;

-- ================================================================ admin read models & reports
create or replace function public.admin_overview(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); o uuid := a.organization_id;
begin
  return jsonb_build_object(
    'active_products', (select count(*) from public.products where organization_id = o and active),
    'active_farmers', (select count(*) from public.farmers where organization_id = o and active),
    'active_staff', (select count(*) from public.profiles where organization_id = o and role = 'staff' and status = 'active'),
    'on_duty', (select count(*) from public.duty_sessions where organization_id = o and ended_at is null),
    'visits_in_range', (select count(*) from public.visits where organization_id = o and scheduled_at >= p_from and scheduled_at < p_to),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.visits
        where organization_id = o and scheduled_at >= p_from and scheduled_at < p_to group by status) x), '{}'::jsonb),
    'overdue', (select count(*) from public.visits where organization_id = o and status in ('assigned', 'rescheduled', 'in_progress', 'arrived', 'blocked')
        and coalesce(due_at, scheduled_at + interval '2 hours') < now()),
    'in_progress_now', (select count(*) from public.visits where organization_id = o and status in ('in_progress', 'arrived')),
    'flagged_arrivals', (select count(*) from public.visit_events where organization_id = o and flagged and occurred_at >= p_from and occurred_at < p_to),
    'server_time', now()
  );
end $$;

create or replace function public.admin_staff_board()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return coalesce((select jsonb_agg(row_to_json(x) order by x.display_name) from (
    select p.id, p.display_name, p.status, p.coverage_area, p.last_seen_at,
           d.id as duty_id, d.started_at as duty_started_at, d.mode as duty_mode,
           l.lat, l.lon, l.accuracy_m, l.device_time, l.received_at, l.quality, l.trip_id,
           t.visit_id as active_visit_id, t.leg as active_leg,
           (select f.name from public.visits v join public.farmers f on f.id = v.farmer_id where v.id = t.visit_id) as active_farmer,
           (select count(*) from public.visits v where v.staff_id = p.id and v.status in ('assigned', 'rescheduled', 'in_progress', 'arrived', 'blocked')) as open_visits,
           (select count(*) from public.visits v where v.staff_id = p.id and v.status in ('assigned', 'rescheduled', 'in_progress', 'arrived', 'blocked')
               and coalesce(v.due_at, v.scheduled_at + interval '2 hours') < now()) as overdue_visits
      from public.profiles p
      left join public.duty_sessions d on d.staff_id = p.id and d.ended_at is null
      left join public.latest_staff_position l on l.staff_id = p.id
      left join public.trips t on t.staff_id = p.id and t.status = 'active'
     where p.organization_id = a.organization_id and p.role = 'staff' and p.status <> 'invited') x), '[]'::jsonb);
end $$;

create or replace function public.admin_activity_feed(p_from timestamptz, p_to timestamptz, p_staff uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return coalesce((select jsonb_agg(row_to_json(x) order by x.occurred_at desc) from (
    select e.id, e.visit_id, e.event_type, e.occurred_at, e.received_at, e.reason, e.flagged, e.distance_m, e.accuracy_m, e.source,
           pr.display_name as actor_name, f.name as farmer_name, f.village
      from public.visit_events e
      join public.visits v on v.id = e.visit_id
      join public.farmers f on f.id = v.farmer_id
      left join public.profiles pr on pr.id = e.actor_id
     where e.organization_id = a.organization_id and e.occurred_at >= p_from and e.occurred_at < p_to
       and (p_staff is null or v.staff_id = p_staff)
     order by e.occurred_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

create or replace function public.admin_visit_detail(p_visit uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); v public.visits;
begin
  select * into v from public.visits where id = p_visit and organization_id = a.organization_id;
  if v.id is null then perform private.raise_err('not_found'); end if;
  return jsonb_build_object(
    'visit', to_jsonb(v),
    'farmer', (select to_jsonb(f) from public.farmers f where f.id = v.farmer_id),
    'staff', (select jsonb_build_object('id', p.id, 'display_name', p.display_name, 'status', p.status) from public.profiles p where p.id = v.staff_id),
    'events', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('actor_name', pr.display_name) order by e.occurred_at, e.received_at)
       from public.visit_events e left join public.profiles pr on pr.id = e.actor_id where e.visit_id = v.id), '[]'::jsonb),
    'outcome', (select to_jsonb(o) from public.visit_outcomes o where o.visit_id = v.id),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at) from public.trips t where t.visit_id = v.id), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name, 'sku', pr.sku)) from public.products pr where pr.id = any (v.product_ids)), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(to_jsonb(at)) from public.attachments at where at.visit_id = v.id), '[]'::jsonb)
  );
end $$;

-- Route points for one staff member: admin of the org, or the staff member themself.
create or replace function public.staff_route(p_staff uuid, p_from timestamptz, p_to timestamptz, p_trip uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.profiles := private.require_staff_member(); v_org uuid;
begin
  select organization_id into v_org from public.profiles where id = p_staff;
  if v_org is null or v_org <> me.organization_id then perform private.raise_err('not_found'); end if;
  if p_staff <> me.id and not private.is_admin() then perform private.raise_err('not_found'); end if;
  if p_to - p_from > interval '31 days' then perform private.raise_err('validation', jsonb_build_object('field', 'range', 'message', 'max 31 days')); end if;
  return jsonb_build_object(
    'points', coalesce((select jsonb_agg(jsonb_build_array(lp.lat, lp.lon, lp.accuracy_m, lp.device_time, lp.trip_id, lp.quality) order by lp.device_time)
       from public.location_points lp where lp.staff_id = p_staff and lp.device_time >= p_from and lp.device_time < p_to
         and lp.quality in ('ok', 'low_accuracy') and (p_trip is null or lp.trip_id = p_trip)), '[]'::jsonb),
    'flagged_count', (select count(*) from public.location_points lp where lp.staff_id = p_staff and lp.device_time >= p_from and lp.device_time < p_to
         and lp.quality not in ('ok', 'low_accuracy')),
    'trips', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'visit_id', t.visit_id, 'leg', t.leg, 'status', t.status, 'started_at', t.started_at,
         'ended_at', t.ended_at, 'farmer_name', f.name) order by t.started_at)
       from public.trips t join public.visits v on v.id = t.visit_id join public.farmers f on f.id = v.farmer_id
       where t.staff_id = p_staff and t.started_at < p_to and coalesce(t.ended_at, now()) >= p_from), '[]'::jsonb),
    'duty', coalesce((select jsonb_agg(jsonb_build_object('started_at', d.started_at, 'ended_at', d.ended_at, 'mode', d.mode) order by d.started_at)
       from public.duty_sessions d where d.staff_id = p_staff and d.started_at < p_to and coalesce(d.ended_at, now()) >= p_from), '[]'::jsonb)
  );
end $$;

create or replace function public.report_visit_timeline(p_from timestamptz, p_to timestamptz, p_staff uuid default null, p_village text default null)
returns table (visit_id uuid, scheduled_at timestamptz, status public.visit_status, type public.task_type, staff_name text, farmer_name text, village text,
               departed_at timestamptz, arrived_at timestamptz, completed_at timestamptz, return_started_at timestamptz, return_ended_at timestamptz,
               arrival_distance_m real, arrival_flagged boolean, arrival_reason text, outcome text, next_followup_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return query
  select v.id, v.scheduled_at, v.status, v.type, p.display_name, f.name, f.village,
         v.started_at, v.arrived_at, v.completed_at,
         (select t.started_at from public.trips t where t.visit_id = v.id and t.leg = 'return' and t.status <> 'abandoned' limit 1),
         (select t.ended_at from public.trips t where t.visit_id = v.id and t.leg = 'return' and t.status <> 'abandoned' limit 1),
         ae.distance_m, coalesce(ae.flagged, false), ae.reason, o.outcome_text, o.next_followup_at
    from public.visits v
    join public.profiles p on p.id = v.staff_id
    join public.farmers f on f.id = v.farmer_id
    left join lateral (select e.distance_m, e.flagged, e.reason from public.visit_events e where e.visit_id = v.id and e.event_type = 'arrived' order by e.occurred_at desc limit 1) ae on true
    left join public.visit_outcomes o on o.visit_id = v.id
   where v.organization_id = a.organization_id and v.scheduled_at >= p_from and v.scheduled_at < p_to
     and (p_staff is null or v.staff_id = p_staff)
     and (p_village is null or lower(f.village) = lower(p_village))
   order by v.scheduled_at
   limit 5000;
end $$;

create or replace function public.report_staff_summary(p_from timestamptz, p_to timestamptz)
returns table (staff_id uuid, staff_name text, assigned bigint, completed bigint, cancelled bigint, overdue bigint, flagged_arrivals bigint,
               avg_travel_min numeric, avg_meeting_min numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return query
  select p.id, p.display_name,
         count(v.id), count(v.id) filter (where v.status = 'completed'), count(v.id) filter (where v.status = 'cancelled'),
         count(v.id) filter (where v.status in ('assigned', 'rescheduled', 'in_progress', 'arrived', 'blocked') and coalesce(v.due_at, v.scheduled_at + interval '2 hours') < now()),
         (select count(*) from public.visit_events e join public.visits v2 on v2.id = e.visit_id
           where v2.staff_id = p.id and e.flagged and e.occurred_at >= p_from and e.occurred_at < p_to),
         round(avg(extract(epoch from (v.arrived_at - v.started_at)) / 60) filter (where v.arrived_at is not null and v.started_at is not null), 1),
         round(avg(extract(epoch from (v.completed_at - v.arrived_at)) / 60) filter (where v.completed_at is not null and v.arrived_at is not null), 1)
    from public.profiles p
    left join public.visits v on v.staff_id = p.id and v.scheduled_at >= p_from and v.scheduled_at < p_to
   where p.organization_id = a.organization_id and p.role = 'staff'
   group by p.id, p.display_name
   order by p.display_name;
end $$;

create or replace function public.report_product_sales(p_from timestamptz, p_to timestamptz)
returns table (product_id uuid, sku text, name text, purchases bigint, quantity numeric, amount numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return query
  select i.product_id, max(i.product_sku), max(i.product_name), count(distinct pu.id), sum(i.quantity), sum(i.line_total)
    from public.purchase_items i join public.purchases pu on pu.id = i.purchase_id
   where pu.organization_id = a.organization_id and pu.status = 'confirmed' and pu.purchased_at >= p_from and pu.purchased_at < p_to
   group by i.product_id order by sum(i.line_total) desc nulls last;
end $$;

create or replace function public.report_exceptions(p_from timestamptz, p_to timestamptz)
returns table (kind text, occurred_at timestamptz, staff_name text, farmer_name text, visit_id uuid, detail text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  return query
  select ('arrival_' || coalesce(e.metadata ->> 'geofence', 'manual'))::text, e.occurred_at, p.display_name, f.name, v.id,
         concat_ws(' · ', case when e.distance_m is not null then round(e.distance_m::numeric) || ' m from pin' end,
                   case when e.accuracy_m is not null then '±' || round(e.accuracy_m::numeric) || ' m' end, e.reason)
    from public.visit_events e join public.visits v on v.id = e.visit_id join public.profiles p on p.id = e.actor_id join public.farmers f on f.id = v.farmer_id
   where e.organization_id = a.organization_id and e.flagged and e.occurred_at >= p_from and e.occurred_at < p_to
  union all
  select 'gps_' || lp.quality::text, min(lp.device_time), p.display_name, null::text, null::uuid, count(*) || ' point(s)'
    from public.location_points lp join public.profiles p on p.id = lp.staff_id
   where lp.organization_id = a.organization_id and lp.quality not in ('ok') and lp.device_time >= p_from and lp.device_time < p_to
   group by lp.quality, p.display_name, date_trunc('day', lp.device_time)
  union all
  -- Offline gaps: > 15 min between consecutive points within one trip.
  select 'offline_gap', g.prev_time, p.display_name, null::text, null::uuid, round(extract(epoch from g.device_time - g.prev_time) / 60) || ' min without location'
    from (select lp.staff_id, lp.device_time, lag(lp.device_time) over (partition by lp.trip_id order by lp.device_time) as prev_time
            from public.location_points lp where lp.organization_id = a.organization_id and lp.trip_id is not null
             and lp.device_time >= p_from and lp.device_time < p_to) g
    join public.profiles p on p.id = g.staff_id
   where g.prev_time is not null and g.device_time - g.prev_time > interval '15 minutes'
  order by 2 desc
  limit 2000;
end $$;

create or replace function public.log_export(p_kind text, p_filters jsonb default '{}'::jsonb, p_rows integer default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin();
begin
  insert into public.audit_log (organization_id, actor_id, action, entity, entity_id, diff)
  values (a.organization_id, a.id, 'export', left(p_kind, 60), null, jsonb_build_object('filters', p_filters, 'rows', p_rows));
end $$;

-- ================================================================ backend-only (service_role) jobs
create or replace function public.claim_outbox_batch(p_limit integer default 50)
returns table (id uuid, recipient_id uuid, payload jsonb, attempts integer, tokens text[])
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with c as (
    select o.id from public.notification_outbox o
     where o.status in ('pending', 'failed') and o.next_attempt_at <= now()
     order by o.next_attempt_at limit least(p_limit, 200) for update skip locked)
  update public.notification_outbox o set status = 'sending', attempts = o.attempts + 1
    from c where o.id = c.id
  returning o.id, o.recipient_id, o.payload, o.attempts,
    array(select dt.token from public.device_tokens dt join public.profiles p on p.id = dt.user_id
           where dt.user_id = o.recipient_id and dt.active and p.status = 'active');
end $$;

create or replace function public.record_outbox_result(p_id uuid, p_ok boolean, p_tickets jsonb, p_error text, p_invalid_tokens text[] default '{}')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.notification_outbox;
begin
  select * into o from public.notification_outbox where id = p_id for update;
  if o.id is null then return; end if;
  if array_length(p_invalid_tokens, 1) > 0 then
    update public.device_tokens set active = false where token = any (p_invalid_tokens);
  end if;
  if p_ok then
    update public.notification_outbox set status = 'sent', sent_at = now(), provider_tickets = p_tickets, last_error = null where id = p_id;
  elsif p_error = 'no_active_device' then
    update public.notification_outbox set status = 'skipped', last_error = p_error where id = p_id;
  elsif o.attempts >= 6 then
    update public.notification_outbox set status = 'dead', last_error = left(p_error, 500), provider_tickets = p_tickets where id = p_id;
  else
    update public.notification_outbox set status = 'failed', last_error = left(p_error, 500), provider_tickets = p_tickets,
           next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, o.attempts))) where id = p_id;
  end if;
end $$;

create or replace function public.record_outbox_receipts(p_id uuid, p_receipts jsonb, p_invalid_tokens text[] default '{}')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.notification_outbox set provider_receipts = p_receipts where id = p_id;
  if array_length(p_invalid_tokens, 1) > 0 then update public.device_tokens set active = false where token = any (p_invalid_tokens); end if;
end $$;

create or replace function public.enqueue_due_reminders()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in
    select v.id, v.organization_id, v.staff_id, v.scheduled_at
      from public.visits v join public.organizations o on o.id = v.organization_id
     where v.status in ('assigned', 'rescheduled')
       and v.scheduled_at > now()
       and v.scheduled_at <= now() + make_interval(mins => coalesce((private.org_settings(o.id) ->> 'reminder_offset_min')::int, 60))
  loop
    perform private.notify(r.organization_id, r.staff_id, 'visit_reminder', r.id, 'Upcoming visit', 'You have a visit starting soon.',
                           'reminder:' || r.id || ':' || r.staff_id || ':' || extract(epoch from r.scheduled_at)::bigint);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.purge_expired_data()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; v_points bigint := 0; v_tokens bigint := 0; n bigint;
begin
  for o in select id, (private.org_settings(id) ->> 'route_retention_days')::int as days from public.organizations loop
    delete from public.location_points where organization_id = o.id and device_time < now() - make_interval(days => greatest(o.days, 7));
    get diagnostics n = row_count; v_points := v_points + n;
  end loop;
  delete from public.device_tokens where active = false and last_seen_at < now() - interval '90 days';
  get diagnostics v_tokens = row_count;
  update public.invitations set status = 'expired' where status = 'pending' and expires_at < now();
  return jsonb_build_object('location_points_deleted', v_points, 'tokens_deleted', v_tokens);
end $$;

-- ================================================================ grants for RPC
do $$
declare fn text;
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach fn in array array[
      'me()', 'log_session_event(text,text)', 'accept_invitation()', 'update_org_settings(jsonb)',
      'admin_update_staff(uuid,jsonb)', 'admin_set_staff_status(uuid,public.profile_status,text)',
      'verify_farmer_location(uuid,double precision,double precision,text)', 'find_farmer_duplicates(text,text,uuid)',
      'admin_create_purchase(uuid,timestamptz,jsonb,text,text,text)', 'admin_void_purchase(uuid,text)',
      'admin_create_visit(jsonb)', 'admin_update_visit(uuid,integer,jsonb)', 'admin_reassign_visit(uuid,uuid,text,integer)',
      'admin_cancel_visit(uuid,text,integer)', 'admin_reschedule_visit(uuid,timestamptz,text,integer)',
      'start_duty(public.duty_mode)', 'end_duty()',
      'staff_start_visit(uuid,text,double precision,double precision,real,timestamptz)',
      'staff_arrive_visit(uuid,text,double precision,double precision,real,timestamptz,text)',
      'staff_complete_visit(uuid,text,jsonb,timestamptz)',
      'staff_start_return(uuid,text,double precision,double precision,real,timestamptz)',
      'staff_end_trip(uuid,text,double precision,double precision,real,timestamptz)',
      'ingest_location_batch(jsonb,uuid)', 'my_visits(timestamptz,timestamptz,text)', 'my_visit_detail(uuid)', 'staff_product_options()',
      'mark_notifications_read(uuid[])', 'register_push_token(text,text)', 'revoke_push_token(text)',
      'register_attachment(uuid,text,text,integer,text)',
      'admin_overview(timestamptz,timestamptz)', 'admin_staff_board()', 'admin_activity_feed(timestamptz,timestamptz,uuid,integer)',
      'admin_visit_detail(uuid)', 'staff_route(uuid,timestamptz,timestamptz,uuid)',
      'report_visit_timeline(timestamptz,timestamptz,uuid,text)', 'report_staff_summary(timestamptz,timestamptz)',
      'report_product_sales(timestamptz,timestamptz)', 'report_exceptions(timestamptz,timestamptz)', 'log_export(text,jsonb,integer)'
    ] loop
      execute format('revoke all on function public.%s from public, anon', fn);
      execute format('grant execute on function public.%s to authenticated', fn);
    end loop;
    foreach fn in array array[
      'claim_outbox_batch(integer)', 'record_outbox_result(uuid,boolean,jsonb,text,text[])', 'record_outbox_receipts(uuid,jsonb,text[])',
      'enqueue_due_reminders()', 'purge_expired_data()'
    ] loop
      execute format('revoke all on function public.%s from public, anon, authenticated', fn);
      execute format('grant execute on function public.%s to service_role', fn);
    end loop;
    -- internal helpers called from RPCs run as definer; nothing else needs them
    execute 'grant execute on function private.bounded_time(timestamptz), private.visit_transition_allowed(public.visit_status, public.visit_status) to authenticated';
  end if;
end $$;
