# API contract

All calls use the Supabase project URL with the user's JWT (`Authorization: Bearer <access_token>`, `apikey: <anon key>`).
Timestamps are ISO-8601 UTC from the server. A machine-readable OpenAPI document for tables and RPCs is served by
PostgREST at `GET {SUPABASE_URL}/rest/v1/` (with the anon key) and reflects these exact signatures.

**Errors.** RPCs raise Postgres errors whose `message` is a stable code and `details` is JSON:
`forbidden`, `not_found` (also used for cross-tenant access, so existence is never leaked), `validation`
(`{field, message}`), `invalid_transition` (`{from, to}`), `version_conflict` (`{current_version}`),
`reason_required` (`{geofence, distance_m, radius_m}`), `duty_not_started`, `active_trip_exists`,
`tracking_disabled`, `invitation_expired`, `invitation_not_found`. Edge Functions return
`{ data, request_id }` or `{ error: { code, message, request_id } }` with an HTTP status.

## RPC — `POST /rest/v1/rpc/<name>`

| Name (args) | Caller | Behaviour |
|---|---|---|
| `me()` | any signed-in | profile, effective settings, aal, is_admin, active duty/trip, unread count |
| `log_session_event(p_event, p_device)` | any | login / logout / mfa_verified / password_reset |
| `accept_invitation()` | invited user | activates account if invitation pending and unexpired |
| `update_org_settings(p_patch)` | admin (MFA owner-only) | whitelisted, validated keys; audited |
| `admin_update_staff(p_staff, p_patch)` | admin; role change owner-only | name/phone/coverage/manager/role |
| `admin_set_staff_status(p_staff, p_status, p_reason)` | admin | suspend/activate; deactivates tokens, closes duty/trips (use `admin-staff` function to also revoke sessions) |
| `verify_farmer_location(p_farmer, p_lat, p_lon, p_source)` | admin | confirms pin with provenance; updates open visits' target |
| `find_farmer_duplicates(p_phone, p_name, p_exclude)` | admin | same normalized phone or exact name; never merges |
| `admin_create_purchase(p_farmer, p_purchased_at, p_items, p_idempotency_key, p_external_reference, p_notes)` | admin | atomic header+items, server totals, price snapshot, idempotent |
| `admin_void_purchase(p_purchase, p_reason)` | admin | soft void with reason (audited) |
| `admin_create_visit(p)` | admin | validates same-org active staff/farmer; event + notification in one transaction; returns `{visit, warnings[]}` (overlap, no pin, unconfirmed pin) |
| `admin_update_visit(p_visit, p_version, p_patch)` | admin | optimistic concurrency |
| `admin_reassign_visit / admin_cancel_visit / admin_reschedule_visit` | admin | reason required; notifies affected staff; abandons active trip |
| `start_duty(p_mode)` / `end_duty()` | staff | explicit tracking window (`tracking` or `limited`) |
| `staff_start_visit(p_visit, p_idempotency_key, p_lat, p_lon, p_accuracy_m, p_device_time)` | assigned staff | requires duty; one active trip per staff |
| `staff_arrive_visit(..., p_override_reason)` | assigned staff | geofence vs confirmed pin; outside/low-accuracy/no-fix needs reason → flagged |
| `staff_complete_visit(p_visit, p_idempotency_key, p_outcome, p_device_time)` | assigned staff | outcome required; optional follow-up visit (once); repeat completion is a no-op |
| `staff_start_return(...)` / `staff_end_trip(p_trip, ...)` | assigned staff | return leg timestamps |
| `ingest_location_batch(p_points, p_trip)` | staff app | ≤200 points `{client_event_id, sequence, device_time, lat, lon, accuracy_m, speed_ms?}`; returns `{accepted[], rejected[], server_time, duty, trip}` |
| `my_visits(p_from, p_to, p_scope)` / `my_visit_detail(p_visit)` | staff | own currently-assigned visits only, minimal farmer context |
| `staff_product_options()` | staff | id/name/sku/unit of active products |
| `mark_notifications_read(p_ids)` | recipient | own only |
| `register_push_token(p_token, p_platform)` / `revoke_push_token(p_token)` | signed-in | own device |
| `register_attachment(p_visit, p_storage_path, p_mime, p_size, p_kind)` | assigned staff/admin | path must be `{org}/{visit}/…` |
| `admin_overview(p_from, p_to)` / `admin_staff_board()` / `admin_activity_feed(...)` / `admin_visit_detail(p_visit)` | admin | dashboard read models |
| `staff_route(p_staff, p_from, p_to, p_trip)` | admin, or self | accepted points (max 31 days), trips, duty periods |
| `report_visit_timeline / report_staff_summary / report_product_sales / report_exceptions` | admin | date-range reports |
| `log_export(p_kind, p_filters, p_rows)` | admin | audit entry before CSV download |
| `claim_outbox_batch`, `record_outbox_result`, `record_outbox_receipts`, `enqueue_due_reminders`, `purge_expired_data`, `hit_rate_limit` | **service_role only** | jobs |

## Direct table access (RLS-enforced)

Admins `select/insert/update` `products` and `farmers` in their organization (no delete; archive via `active`).
`organization_id`/`created_by` are overwritten server-side by trigger. All other tables are read-only to clients
and filtered by RLS (see [SECURITY.md](SECURITY.md)).

## Edge Functions — `POST /functions/v1/<name>`

| Function | Caller | Body | Result |
|---|---|---|---|
| `invite-user` | admin (admins invite staff; owner invites admins) | `{email, display_name, role, phone?, coverage_area?, resend?}` | `{user_id, email, role, expires_in_hours}`; rate-limited 30/h per admin |
| `admin-staff` | admin | `{staff_id, action: "suspend"\|"activate", reason?}` | profile + `sessions_revoked` |
| `places` | signed-in | `{q}` or `{lat, lon}` | `{provider, cached, results[{lat, lon, label, confidence, approximate:true}]}`; 60/h per user, 2000/day per org; `503 provider_not_configured` if unset |
| `push-dispatch` | scheduler (`x-cron-secret`) | – | `{claimed, sent, failed, skipped, receipts_checked}` |
