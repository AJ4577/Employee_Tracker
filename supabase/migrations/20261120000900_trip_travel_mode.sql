-- How the staff member travels on each trip leg (shown as walk / bike / car on maps and playback).
alter table public.trips add column if not exists travel_mode text
  check (travel_mode is null or travel_mode in ('walk', 'bike', 'car'));

-- Recreate the start functions with an optional p_travel_mode (dropping the old signatures avoids
-- ambiguous overloads for PostgREST named-argument calls).
drop function if exists public.staff_start_visit(uuid, text, double precision, double precision, real, timestamptz);
drop function if exists public.staff_start_return(uuid, text, double precision, double precision, real, timestamptz);

create or replace function public.staff_start_visit(
  p_visit uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null, p_travel_mode text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; d public.duty_sessions; t public.trips;
  v_at timestamptz := private.bounded_time(p_device_time);
begin
  if p_travel_mode is not null and p_travel_mode not in ('walk', 'bike', 'car') then
    perform private.raise_err('validation', jsonb_build_object('field', 'travel_mode'));
  end if;
  v := private.lock_my_visit(p_visit);
  if private.replayed(v.id, p_idempotency_key) then return private.visit_json(v.id) || jsonb_build_object('replayed', true); end if;
  if not private.visit_transition_allowed(v.status, 'in_progress') then perform private.raise_err('invalid_transition', jsonb_build_object('from', v.status, 'to', 'in_progress')); end if;
  select * into d from public.duty_sessions where staff_id = s.id and ended_at is null;
  if d.id is null then perform private.raise_err('duty_not_started'); end if;
  if exists (select 1 from public.trips where staff_id = s.id and status = 'active') then perform private.raise_err('active_trip_exists'); end if;
  insert into public.trips (organization_id, visit_id, staff_id, duty_id, leg, started_at, start_lat, start_lon, travel_mode)
  values (s.organization_id, v.id, s.id, d.id, 'outbound', v_at, p_lat, p_lon, p_travel_mode) returning * into t;
  update public.visits set status = 'in_progress', started_at = v_at, version = version + 1 where id = v.id;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, from_status, to_status, occurred_at, lat, lon, accuracy_m, source, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'trip_started', v.status, 'in_progress', v_at, p_lat, p_lon, p_accuracy_m,
          case when p_lat is null then 'manual' else 'device' end, p_idempotency_key,
          jsonb_build_object('trip_id', t.id, 'device_time', p_device_time, 'travel_mode', p_travel_mode));
  return private.visit_json(v.id) || jsonb_build_object('trip', to_jsonb(t), 'replayed', false);
end $$;

create or replace function public.staff_start_return(
  p_visit uuid, p_idempotency_key text, p_lat double precision default null, p_lon double precision default null,
  p_accuracy_m real default null, p_device_time timestamptz default null, p_travel_mode text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.profiles := private.require_staff_member(); v public.visits; d public.duty_sessions; t public.trips;
  v_at timestamptz := private.bounded_time(p_device_time);
begin
  if p_travel_mode is not null and p_travel_mode not in ('walk', 'bike', 'car') then
    perform private.raise_err('validation', jsonb_build_object('field', 'travel_mode'));
  end if;
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
  insert into public.trips (organization_id, visit_id, staff_id, duty_id, leg, started_at, start_lat, start_lon, travel_mode)
  values (s.organization_id, v.id, s.id, d.id, 'return', v_at, p_lat, p_lon, p_travel_mode) returning * into t;
  insert into public.visit_events (organization_id, visit_id, actor_id, event_type, occurred_at, lat, lon, accuracy_m, source, idempotency_key, metadata)
  values (s.organization_id, v.id, s.id, 'return_started', v_at, p_lat, p_lon, p_accuracy_m, case when p_lat is null then 'manual' else 'device' end,
          p_idempotency_key, jsonb_build_object('trip_id', t.id, 'travel_mode', p_travel_mode));
  return jsonb_build_object('trip', to_jsonb(t), 'replayed', false);
end $$;

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
         'ended_at', t.ended_at, 'farmer_name', f.name, 'travel_mode', t.travel_mode) order by t.started_at)
       from public.trips t join public.visits v on v.id = t.visit_id join public.farmers f on f.id = v.farmer_id
       where t.staff_id = p_staff and t.started_at < p_to and coalesce(t.ended_at, now()) >= p_from), '[]'::jsonb),
    'duty', coalesce((select jsonb_agg(jsonb_build_object('started_at', d.started_at, 'ended_at', d.ended_at, 'mode', d.mode) order by d.started_at)
       from public.duty_sessions d where d.staff_id = p_staff and d.started_at < p_to and coalesce(d.ended_at, now()) >= p_from), '[]'::jsonb)
  );
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.staff_start_visit(uuid, text, double precision, double precision, real, timestamptz, text) from public, anon;
    grant execute on function public.staff_start_visit(uuid, text, double precision, double precision, real, timestamptz, text) to authenticated;
    revoke all on function public.staff_start_return(uuid, text, double precision, double precision, real, timestamptz, text) from public, anon;
    grant execute on function public.staff_start_return(uuid, text, double precision, double precision, real, timestamptz, text) to authenticated;
  end if;
end $$;
