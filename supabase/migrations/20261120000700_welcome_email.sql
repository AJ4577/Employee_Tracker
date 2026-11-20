-- Track the one-time "thank you for registering" email (sent by the send-welcome Edge Function).
alter table public.profiles add column if not exists welcome_sent_at timestamptz;

-- Atomically claim the welcome email for the calling user. Returns the recipient details only once.
create or replace function public.claim_welcome_email(p_user uuid)
returns table (email text, display_name text, status public.profile_status, role public.app_role)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update public.profiles p set welcome_sent_at = now()
   where p.id = p_user and p.welcome_sent_at is null
  returning p.email, p.display_name, p.status, p.role;
end $$;

-- Let the function release the claim if sending failed, so a retry can send it.
create or replace function public.release_welcome_email(p_user uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.profiles set welcome_sent_at = null where id = p_user
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.claim_welcome_email(uuid) from public, anon, authenticated;
    revoke all on function public.release_welcome_email(uuid) from public, anon, authenticated;
    grant execute on function public.claim_welcome_email(uuid), public.release_welcome_email(uuid) to service_role;
  end if;
end $$;
