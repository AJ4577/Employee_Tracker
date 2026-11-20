-- Support tables for Edge Functions: geocode cache and fixed-window rate limiting (service_role only).

create table public.geocode_cache (
  query_hash text primary key,
  provider text not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.geocode_cache enable row level security; -- no policies: service_role only

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security; -- no policies: service_role only

create or replace function public.hit_rate_limit(p_key text, p_limit integer, p_window_s integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s); v_hits integer;
begin
  insert into public.rate_limits (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  delete from public.rate_limits where window_start < now() - interval '1 day' and random() < 0.01;
  return v_hits <= p_limit;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.geocode_cache, public.rate_limits from anon, authenticated;
    revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
    grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
    grant all on public.geocode_cache, public.rate_limits to service_role;
  end if;
end $$;
