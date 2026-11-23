-- Every new visit without its own target uses the farmer's current pin (covers admin-created visits,
-- follow-ups created on completion, and any future path). Then fill open visits that are missing one.
create or replace function private.fill_visit_target()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.target_lat is null then
    select f.lat, f.lon into new.target_lat, new.target_lon from public.farmers f where f.id = new.farmer_id and f.lat is not null;
  end if;
  return new;
end $$;

drop trigger if exists visits_fill_target on public.visits;
create trigger visits_fill_target before insert on public.visits for each row execute function private.fill_visit_target();

update public.visits v
   set target_lat = f.lat, target_lon = f.lon, version = v.version + 1
  from public.farmers f
 where f.id = v.farmer_id and v.target_lat is null and f.lat is not null
   and v.status in ('assigned', 'rescheduled', 'blocked', 'in_progress');
