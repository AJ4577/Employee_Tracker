# Architecture

```mermaid
flowchart LR
  subgraph Clients
    W[Web app<br/>React/Vite<br/>admin + staff]
    M[Staff app<br/>Expo RN<br/>bg GPS + offline queue]
  end
  subgraph Supabase
    A[Auth<br/>invite-only, TOTP MFA]
    R[PostgREST<br/>tables under RLS + RPC functions]
    RT[Realtime<br/>RLS-filtered changes]
    S[Storage<br/>private visit-proof bucket]
    F[Edge Functions<br/>invite-user · admin-staff<br/>push-dispatch · places]
    DB[(Postgres<br/>RLS on every table<br/>append-only events/audit)]
    C[pg_cron<br/>reminders · retention]
  end
  EX[Expo Push → FCM / APNs]
  G[Geocoder provider<br/>operator-configured]
  T[Map tiles<br/>operator-configured]
  GM[Google Maps app/URL<br/>directions only]

  W -- JWT --> R & RT & S & F
  M -- JWT (keystore) --> R & S & F
  W & M --> A
  R --> DB
  RT --> DB
  F -- service role --> DB
  F --> EX
  F --> G
  C --> DB
  W & M --> T
  W & M --> GM
```

## Why business logic lives in Postgres functions

Status transitions, location ingestion, purchases and reports are `SECURITY DEFINER` SQL functions exposed
as PostgREST RPC. Each derives the caller, role and organization from the verified JWT (`auth.uid()`), validates
input, writes the state change **and** its append-only event (and notification outbox row) in one transaction.
This gives server- and database-enforced authorization with no always-on server, and lets CI test the real
logic on PGlite. Edge Functions exist only where a service-role credential or third-party call is required
(Auth admin API, Expo push, geocoding).

## Visit state machine

```mermaid
stateDiagram-v2
  [*] --> assigned: admin_create_visit
  assigned --> in_progress: staff_start_visit (outbound trip starts)
  rescheduled --> in_progress
  in_progress --> arrived: staff_arrive_visit (geofence or reason)
  arrived --> completed: staff_complete_visit (outcome required)
  assigned --> rescheduled: admin_reschedule_visit
  in_progress --> rescheduled
  rescheduled --> rescheduled
  assigned --> cancelled: admin_cancel_visit
  in_progress --> cancelled
  arrived --> cancelled
  rescheduled --> cancelled
  assigned --> blocked
  blocked --> assigned
  completed --> [*]
  cancelled --> [*]
```

Return leg (`staff_start_return` → `staff_end_trip`) happens after `completed` and is reported separately.
Reassignment keeps the status at `assigned`, abandons any active trip and moves access to the new staff member.

## Location data flow

1. Staff taps **Start duty** → permission education → OS permission → `start_duty('tracking'|'limited')`.
2. Background task (`expo-location` + foreground service on Android) writes fixes to the local SQLite queue
   (configurable interval/distance from Settings).
3. `sync.flush()` uploads ≤200 points per call to `ingest_location_batch` with `client_event_id` + `sequence`.
   The server validates ranges, flags `low_accuracy` / `teleport` (>70 m/s) / `clock_drift` / `stale`, de-duplicates,
   stores raw points in `location_points`, and updates one `latest_staff_position` row (never with an older fix).
4. Admin map subscribes to Realtime only while open; RLS restricts rows to the admin's organization.
5. **End duty** stops the task; the server refuses points outside an active tracking duty.

Route display draws polylines only between consecutive accepted points of the same trip and splits at gaps
> 5 minutes. Planned directions are never drawn — they open in Google Maps.

## Offline

Mobile actions (start/arrive/complete/return/end/duty) carry an idempotency key and are tried immediately; on
network failure they are queued and replayed **in order** with exponential backoff. Server rejections during
replay are kept and shown to the staff member ("Couldn't sync …"). Admin data only changes after server
acknowledgement. Visit details and lists are cached for offline viewing and cleared on logout.

## Data model

See `supabase/migrations/20261120000100_schema.sql`. Core tables: organizations, profiles, invitations, products,
farmers, purchases, purchase_items (immutable price snapshots), visits (+version for optimistic concurrency),
visit_events (append-only), visit_outcomes, duty_sessions, trips, location_points, latest_staff_position,
user_notifications, notification_outbox, device_tokens, attachments, audit_log (append-only), session_events,
geocode_cache, rate_limits.
