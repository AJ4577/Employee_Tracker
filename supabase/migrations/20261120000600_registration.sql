-- Self-registration with approval.
-- A signed-in user (email verified by OTP) calls register_profile(name, phone, role).
--   * No organization yet  -> creates the organization; caller becomes the active OWNER.
--   * Otherwise            -> joins the (oldest) organization with status 'pending'.
--     Admins/owner approve or reject; only the owner may approve an admin.
-- Pending users can authenticate but every RLS policy/RPC treats them as inactive.

-- One phone number per account (needed for phone OTP login).
create unique index profiles_phone_uq on public.profiles (phone) where phone is not null;

create or replace function public.register_profile(p_display_name text, p_phone text, p_role public.app_role default 'staff')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(nullif(auth.jwt() ->> 'email', ''));
  v_name text := trim(p_display_name);
  v_phone text := private.normalize_phone(p_phone);
  v_org uuid;
  v_status public.profile_status;
  v_role public.app_role;
  r record;
begin
  if v_uid is null then perform private.raise_err('unauthenticated'); end if;
  if exists (select 1 from public.profiles where id = v_uid) then perform private.raise_err('already_registered'); end if;
  if v_email is null then perform private.raise_err('validation', jsonb_build_object('field', 'email', 'message', 'Verify your email first')); end if;
  if v_name is null or length(v_name) not between 2 and 120 then
    perform private.raise_err('validation', jsonb_build_object('field', 'display_name', 'message', 'Enter your full name'));
  end if;
  if v_phone is null then perform private.raise_err('validation', jsonb_build_object('field', 'phone', 'message', 'Enter a valid 10-digit mobile number')); end if;
  if p_role not in ('staff', 'admin') then perform private.raise_err('validation', jsonb_build_object('field', 'role')); end if;
  if exists (select 1 from public.profiles where phone = v_phone) then
    perform private.raise_err('validation', jsonb_build_object('field', 'phone', 'message', 'This mobile number is already registered'));
  end if;

  -- Serialize so two simultaneous "first" registrations can't both become owner.
  perform pg_advisory_xact_lock(hashtext('kisanroute.register'));
  select id into v_org from public.organizations order by created_at limit 1;
  if v_org is null then
    insert into public.organizations (name) values ('Greenfield Agro') returning id into v_org;
    v_role := 'owner';
    v_status := 'active';
  else
    if exists (select 1 from public.profiles where organization_id = v_org and lower(email) = v_email) then
      perform private.raise_err('validation', jsonb_build_object('field', 'email', 'message', 'This email is already registered'));
    end if;
    v_role := p_role;
    v_status := 'pending';
  end if;

  insert into public.profiles (id, organization_id, role, status, display_name, email, phone, created_by)
  values (v_uid, v_org, v_role, v_status, v_name, v_email, v_phone, v_uid);

  if v_status = 'pending' then
    for r in select id from public.profiles
              where organization_id = v_org and status = 'active'
                and (role = 'owner' or (role = 'admin' and p_role = 'staff')) loop
      perform private.notify(v_org, r.id, 'registration_pending', null, 'New registration to review',
                             'Someone registered as ' || p_role || '. Open Staff to approve or reject.', 'reg:' || v_uid || ':' || r.id);
    end loop;
  end if;
  return jsonb_build_object('status', v_status, 'role', v_role, 'organization_id', v_org);
end $$;

-- Approve (activate, optionally changing the requested role) or reject (suspend) a pending registration.
create or replace function public.admin_review_registration(p_profile uuid, p_approve boolean, p_role public.app_role default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); s public.profiles; v_role public.app_role;
begin
  select * into s from public.profiles where id = p_profile and organization_id = a.organization_id for update;
  if s.id is null then perform private.raise_err('not_found'); end if;
  if s.status <> 'pending' then perform private.raise_err('invalid_transition', jsonb_build_object('message', 'Not a pending registration')); end if;
  v_role := coalesce(p_role, s.role);
  if v_role not in ('staff', 'admin') then perform private.raise_err('validation', jsonb_build_object('field', 'role')); end if;
  if v_role = 'admin' and a.role <> 'owner' then perform private.raise_err('forbidden', jsonb_build_object('message', 'Only the owner can approve admins')); end if;
  if p_approve then
    update public.profiles set status = 'active', role = v_role where id = s.id returning * into s;
    perform private.notify(s.organization_id, s.id, 'registration_approved', null, 'Account approved', 'You can now use KisanRoute.', 'reg-ok:' || s.id);
  else
    update public.profiles set status = 'suspended' where id = s.id returning * into s;
    insert into public.session_events (organization_id, user_id, event, failure_reason)
    values (s.organization_id, s.id, 'token_revoked', left(coalesce(p_reason, 'registration rejected'), 300));
  end if;
  return to_jsonb(s);
end $$;

-- Status changes for existing members may not move anyone into/out of the registration states.
create or replace function public.admin_set_staff_status(p_staff uuid, p_status public.profile_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := private.require_admin(); s public.profiles;
begin
  select * into s from public.profiles where id = p_staff and organization_id = a.organization_id for update;
  if s.id is null then perform private.raise_err('not_found'); end if;
  if s.id = a.id or (s.role = 'owner' and a.role <> 'owner') then perform private.raise_err('forbidden'); end if;
  if p_status in ('invited', 'pending') or s.status = 'pending' then
    perform private.raise_err('validation', jsonb_build_object('field', 'status', 'message', 'Use approve/reject for pending registrations'));
  end if;
  if s.role = 'admin' and p_status = 'active' and a.role <> 'owner' then perform private.raise_err('forbidden'); end if;
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

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.register_profile(text, text, public.app_role) from public, anon;
    grant execute on function public.register_profile(text, text, public.app_role) to authenticated;
    revoke all on function public.admin_review_registration(uuid, boolean, public.app_role, text) from public, anon;
    grant execute on function public.admin_review_registration(uuid, boolean, public.app_role, text) to authenticated;
  end if;
end $$;
