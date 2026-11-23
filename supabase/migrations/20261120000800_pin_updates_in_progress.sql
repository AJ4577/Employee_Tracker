-- A confirmed farmer pin also reaches visits already on the way (in_progress), so staff who started
-- the trip before the pin existed can still navigate and the arrival geofence uses the real farm.
-- Arrived/completed visits keep the target they were checked against.
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
  update public.visits set target_lat = p_lat, target_lon = p_lon, version = version + 1
   where farmer_id = f.id and status in ('assigned', 'rescheduled', 'blocked', 'in_progress');
  return to_jsonb(f);
end $$;
