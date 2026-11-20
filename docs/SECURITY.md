# Security & privacy

## Authorization matrix (enforced by RLS + RPC checks; covered by `tests/db/rls.test.ts`)

| Resource | Owner / admin (own org, MFA aal2 when required) | Field staff | Suspended / invited | Anonymous |
|---|---|---|---|---|
| organizations | read; settings via `update_org_settings` | read own org | – | deny |
| profiles | read org; edit via RPC; role change owner-only | read self | read self (to show status) | deny |
| products | read/insert/update (no delete) | `staff_product_options()` only | deny | deny |
| farmers | read/insert/update; pin via `verify_farmer_location` | via `my_visit_detail` for **currently assigned** visits only | deny | deny |
| purchases / items | read; write via RPC | 5 recent purchases (names/qty) inside visit detail | deny | deny |
| visits / events / outcomes | read org; write via RPC | own assigned; transitions via RPC | deny | deny |
| duty / trips / location points / latest position | read org | own only; points via `ingest_location_batch` | deny | deny |
| notifications | outbox read (diagnostics) | own inbox; mark own read | deny | deny |
| device tokens | – | own | deactivated on suspend | deny |
| attachments + `visit-proof` storage | org; signed URL 60 s | own assigned visits | deny | deny |
| audit log / session events | read org | own session events | – | deny |
| geocode cache / rate limits / service jobs | service role only | – | – | – |

Notes:
* `organization_id`, `staff_id`, actor and role are **never** taken from request bodies. Inserts by clients have
  `organization_id` forced by trigger; cross-org updates raise `forbidden`; cross-org reads return `not_found`.
* Every `SECURITY DEFINER` function pins `search_path`; `CREATE` on `public` is revoked from client roles.
* Reassignment removes the previous staff member's access to that farmer immediately (policies check current assignment).
* Suspension: `status='suspended'` makes every policy/RPC deny at once; the `admin-staff` function also bans the auth
  user so refresh tokens stop working; device tokens are deactivated and duty/trips closed.
* `visit_events`, `audit_log`, `session_events`, `purchase_items` are append-only (update/delete raise `append_only`).
* Audit diffs strip phone, alternate contact and address.

## Threat model summary

| Threat | Control |
|---|---|
| Unauthenticated access | No anon grants on tables/RPC; public page is login only |
| Staff reading peers / other orgs | RLS by `auth.uid()` and org; tests with second staff + second org |
| Forged IDs / role in body | Server derives identity; `set_tenant` trigger; RPC scope checks |
| Stolen device / session | Supabase short-lived JWT + rotating refresh tokens; suspend bans user; mobile tokens in Keystore/Keychain; logout clears local queue |
| Replay / double submit | Idempotency keys on visit events, purchases, location `client_event_id`; completion is terminal |
| GPS spoofing / bad fixes | Quality flags (teleport, drift, low accuracy, stale); flagged arrivals need reason; exceptions report |
| Map/geocoder key leak | Geocoder key only in Edge Function secrets; tile URL configurable; restrict keys by domain/app |
| Scraping | Pagination caps (1000 rows API max, page size 25), report row limits, function rate limits |
| Malicious upload | Bucket MIME allow-list + 10 MB cap; path bound to org/visit; immutable objects; short signed URLs |
| XSS | React escaping; Leaflet popups use React nodes / text nodes; CSP in `apps/web/public/_headers` |
| CSV injection | `toCsv` prefixes `= + - @` cells |
| Lock-screen leakage | Push payload is generic ("New visit assigned"); details load after login |
| Compromised admin | MFA (TOTP) required for admins by default; audit log for changes and exports |
| Backups | Supabase-managed encrypted backups; enable PITR on paid plan; restore drill in DEPLOYMENT.md |

## Privacy

* Tracking only between Start duty and End duty; Android foreground-service notification and iOS blue-bar indicator.
* Staff-facing notice in the app before the permission prompt and on the Profile screen.
* Limited mode when permission is denied — work continues, nothing is fabricated.
* Raw GPS retention configurable (default 90 days), purged nightly by `purge_expired_data()`; visit timestamps kept.
* Only coordinates/search text are sent to map/geocoding providers — never farmer profiles.

> This is engineering guidance, not legal approval. Confirm employee-monitoring and data-protection obligations
> (e.g. India's DPDP Act 2023) with qualified counsel before real rollout.
