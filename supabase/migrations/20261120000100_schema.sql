-- KisanRoute schema: tables, constraints, indexes.
-- All timestamps are timestamptz (UTC). Tenant-owned rows carry organization_id.
-- Business records are soft-archived (archived_at / active) rather than deleted.

create schema if not exists private;

-- ---------------------------------------------------------------- enums
create type public.app_role as enum ('owner', 'admin', 'staff');
create type public.profile_status as enum ('invited', 'pending', 'active', 'suspended');
create type public.visit_status as enum ('assigned', 'in_progress', 'arrived', 'completed', 'rescheduled', 'cancelled', 'blocked');
create type public.task_type as enum ('meeting', 'follow_up', 'delivery', 'demo', 'other');
create type public.priority as enum ('low', 'normal', 'high', 'urgent');
create type public.trip_leg as enum ('outbound', 'return');
create type public.trip_status as enum ('active', 'ended', 'abandoned');
create type public.location_quality as enum ('ok', 'low_accuracy', 'teleport', 'clock_drift', 'stale', 'duplicate');
create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
create type public.outbox_status as enum ('pending', 'sending', 'sent', 'failed', 'dead', 'skipped');
create type public.purchase_status as enum ('confirmed', 'void');
create type public.duty_mode as enum ('tracking', 'limited');

-- ---------------------------------------------------------------- organizations
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  timezone text not null default 'Asia/Kolkata',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- profiles (1:1 with auth.users)
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id),
  role public.app_role not null default 'staff',
  status public.profile_status not null default 'invited',
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  email text not null,
  phone text,
  coverage_area text,
  manager_id uuid references public.profiles (id),
  last_seen_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_org_email_uq on public.profiles (organization_id, lower(email));
create index profiles_org_role_idx on public.profiles (organization_id, role, status);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  email text not null,
  role public.app_role not null,
  auth_user_id uuid references auth.users (id) on delete set null,
  status public.invitation_status not null default 'pending',
  invited_by uuid references public.profiles (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_org_idx on public.invitations (organization_id, status);
create unique index invitations_pending_email_uq on public.invitations (organization_id, lower(email)) where status = 'pending';

-- ---------------------------------------------------------------- products
create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  sku text not null check (length(trim(sku)) between 1 and 60),
  name text not null check (length(trim(name)) between 1 and 160),
  category text,
  unit text not null default 'unit',
  description text check (description is null or length(description) <= 4000),
  price numeric(12, 2) check (price is null or price >= 0),
  tax_rate numeric(5, 2) check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100)),
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_org_sku_uq on public.products (organization_id, lower(sku));
create index products_org_active_idx on public.products (organization_id, active, name);

-- ---------------------------------------------------------------- farmers
create table public.farmers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null check (length(trim(name)) between 1 and 160),
  phone text,
  normalized_phone text,
  alt_contact text,
  village text,
  district text,
  state text,
  postcode text check (postcode is null or postcode ~ '^[0-9A-Za-z -]{3,10}$'),
  address text check (address is null or length(address) <= 1000),
  crops text[] not null default '{}',
  notes text check (notes is null or length(notes) <= 4000),
  lat double precision check (lat is null or (lat between -90 and 90)),
  lon double precision check (lon is null or (lon between -180 and 180)),
  location_verified boolean not null default false,
  geocode_source text,
  geocode_confidence numeric(4, 3),
  location_confirmed_by uuid,
  location_confirmed_at timestamptz,
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint farmers_latlon_pair check ((lat is null) = (lon is null)),
  constraint farmers_verified_needs_pin check (not location_verified or lat is not null)
);
create index farmers_org_name_idx on public.farmers (organization_id, lower(name));
create index farmers_org_phone_idx on public.farmers (organization_id, normalized_phone);
create index farmers_org_village_idx on public.farmers (organization_id, lower(village));

-- ---------------------------------------------------------------- purchases
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  farmer_id uuid not null references public.farmers (id),
  purchased_at timestamptz not null,
  external_reference text,
  status public.purchase_status not null default 'confirmed',
  total numeric(14, 2) not null default 0 check (total >= 0),
  notes text,
  void_reason text,
  idempotency_key text not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchases_void_reason check (status <> 'void' or void_reason is not null)
);
create unique index purchases_idem_uq on public.purchases (organization_id, idempotency_key);
create index purchases_org_farmer_idx on public.purchases (organization_id, farmer_id, purchased_at desc);
create index purchases_org_date_idx on public.purchases (organization_id, purchased_at desc);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_id uuid not null references public.purchases (id) on delete cascade,
  product_id uuid not null references public.products (id),
  product_name text not null,
  product_sku text not null,
  unit text not null,
  quantity numeric(12, 3) not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(14, 2) not null check (line_total >= 0)
);
create index purchase_items_purchase_idx on public.purchase_items (purchase_id);
create index purchase_items_product_idx on public.purchase_items (organization_id, product_id);

-- ---------------------------------------------------------------- visits
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  farmer_id uuid not null references public.farmers (id),
  staff_id uuid not null references public.profiles (id),
  type public.task_type not null default 'meeting',
  instructions text check (instructions is null or length(instructions) <= 4000),
  scheduled_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',
  due_at timestamptz,
  priority public.priority not null default 'normal',
  status public.visit_status not null default 'assigned',
  product_ids uuid[] not null default '{}',
  target_lat double precision check (target_lat is null or (target_lat between -90 and 90)),
  target_lon double precision check (target_lon is null or (target_lon between -180 and 180)),
  started_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  status_reason text,
  parent_visit_id uuid references public.visits (id),
  version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visits_due_after_schedule check (due_at is null or due_at >= scheduled_at),
  constraint visits_target_pair check ((target_lat is null) = (target_lon is null)),
  constraint visits_completed_has_time check (status <> 'completed' or completed_at is not null)
);
create index visits_org_staff_sched_idx on public.visits (organization_id, staff_id, scheduled_at);
create index visits_org_status_sched_idx on public.visits (organization_id, status, scheduled_at);
create index visits_org_farmer_idx on public.visits (organization_id, farmer_id);
create unique index visits_one_followup_per_parent on public.visits (parent_visit_id) where parent_visit_id is not null;

create table public.visit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  visit_id uuid not null references public.visits (id),
  actor_id uuid references public.profiles (id),
  event_type text not null,
  from_status public.visit_status,
  to_status public.visit_status,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  lat double precision check (lat is null or (lat between -90 and 90)),
  lon double precision check (lon is null or (lon between -180 and 180)),
  accuracy_m real check (accuracy_m is null or accuracy_m >= 0),
  distance_m real,
  source text not null default 'server' check (source in ('device', 'manual', 'server')),
  reason text,
  flagged boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text
);
create unique index visit_events_idem_uq on public.visit_events (visit_id, idempotency_key) where idempotency_key is not null;
create index visit_events_visit_idx on public.visit_events (visit_id, occurred_at);
create index visit_events_org_time_idx on public.visit_events (organization_id, received_at desc);

create table public.visit_outcomes (
  visit_id uuid primary key references public.visits (id),
  organization_id uuid not null references public.organizations (id),
  outcome_text text not null check (length(trim(outcome_text)) between 1 and 4000),
  products_discussed uuid[] not null default '{}',
  products_delivered jsonb not null default '[]'::jsonb,
  next_action text,
  next_followup_at timestamptz,
  delivery_confirmation boolean,
  completed_by uuid not null references public.profiles (id),
  recorded_at timestamptz not null default now(),
  device_recorded_at timestamptz
);

-- ---------------------------------------------------------------- duty, trips, location
create table public.duty_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  staff_id uuid not null references public.profiles (id),
  mode public.duty_mode not null default 'tracking',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  constraint duty_end_after_start check (ended_at is null or ended_at >= started_at)
);
create unique index duty_one_active_per_staff on public.duty_sessions (staff_id) where ended_at is null;
create index duty_org_staff_idx on public.duty_sessions (organization_id, staff_id, started_at desc);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  visit_id uuid not null references public.visits (id),
  staff_id uuid not null references public.profiles (id),
  duty_id uuid references public.duty_sessions (id),
  leg public.trip_leg not null,
  status public.trip_status not null default 'active',
  started_at timestamptz not null,
  ended_at timestamptz,
  start_lat double precision,
  start_lon double precision,
  end_lat double precision,
  end_lon double precision,
  last_sequence integer not null default 0,
  constraint trips_end_after_start check (ended_at is null or ended_at >= started_at)
);
create unique index trips_one_active_per_staff on public.trips (staff_id) where status = 'active';
create unique index trips_one_leg_per_visit on public.trips (visit_id, leg) where status <> 'abandoned';
create index trips_org_staff_idx on public.trips (organization_id, staff_id, started_at desc);

create table public.location_points (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id),
  staff_id uuid not null references public.profiles (id),
  duty_id uuid references public.duty_sessions (id),
  trip_id uuid references public.trips (id),
  client_event_id uuid not null,
  sequence integer not null check (sequence >= 0),
  device_time timestamptz not null,
  received_at timestamptz not null default now(),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  accuracy_m real not null check (accuracy_m >= 0),
  speed_ms real,
  quality public.location_quality not null default 'ok'
);
create unique index location_points_client_uq on public.location_points (staff_id, client_event_id);
create index location_points_trip_idx on public.location_points (trip_id, device_time);
create index location_points_org_staff_time_idx on public.location_points (organization_id, staff_id, device_time);

create table public.latest_staff_position (
  staff_id uuid primary key references public.profiles (id),
  organization_id uuid not null references public.organizations (id),
  duty_id uuid references public.duty_sessions (id),
  trip_id uuid references public.trips (id),
  lat double precision not null,
  lon double precision not null,
  accuracy_m real not null,
  device_time timestamptz not null,
  received_at timestamptz not null default now(),
  source text not null default 'device',
  quality public.location_quality not null default 'ok'
);
create index latest_position_org_idx on public.latest_staff_position (organization_id);

-- ---------------------------------------------------------------- notifications
create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  recipient_id uuid not null references public.profiles (id),
  type text not null,
  visit_id uuid references public.visits (id),
  title text not null,
  body text,
  read_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index user_notifications_recipient_idx on public.user_notifications (recipient_id, created_at desc);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  recipient_id uuid not null references public.profiles (id),
  notification_id uuid references public.user_notifications (id),
  type text not null,
  visit_id uuid references public.visits (id),
  payload jsonb not null default '{}'::jsonb,
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_tickets jsonb,
  provider_receipts jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index outbox_due_idx on public.notification_outbox (status, next_attempt_at);

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  user_id uuid not null references public.profiles (id),
  platform text not null check (platform in ('android', 'ios', 'web')),
  token text not null unique,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index device_tokens_user_idx on public.device_tokens (user_id) where active;

-- ---------------------------------------------------------------- attachments
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  visit_id uuid not null references public.visits (id),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  kind text not null default 'photo' check (kind in ('photo', 'signature', 'document')),
  uploaded_by uuid not null references public.profiles (id),
  retention_until timestamptz,
  created_at timestamptz not null default now()
);
create index attachments_visit_idx on public.attachments (visit_id);

-- ---------------------------------------------------------------- audit & sessions
create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  diff jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_log_org_time_idx on public.audit_log (organization_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);

create table public.session_events (
  id bigint generated always as identity primary key,
  organization_id uuid,
  user_id uuid,
  event text not null check (event in ('login', 'logout', 'token_revoked', 'login_failed', 'mfa_verified', 'password_reset', 'invite_accepted')),
  device text,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index session_events_user_idx on public.session_events (user_id, created_at desc);
create index session_events_org_idx on public.session_events (organization_id, created_at desc);
