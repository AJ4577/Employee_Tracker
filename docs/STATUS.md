# Implementation status (2026-11-20)

**Implemented** = code complete in this repo. **Tested** = what was actually executed. **Blocked** = needs an
external account/credential or physical device before it can be verified. Nothing below has been verified
against a live Supabase project or on a physical phone yet.

| Requirement | Implemented | Tested | Blocked on |
|---|---|---|---|
| Register (name, email, phone, role) → email OTP → saved; first user = owner; others pending until approved | ✅ `register_profile`, `admin_review_registration`, Register/Pending pages, Staff approvals | ✅ 6 DB tests; register form validation checked in browser; ⛔ live OTP email not run | Supabase project (+ SMTP for volume) |
| Passwordless sign-in by email OTP or mobile OTP; unknown users told to register | ✅ web + mobile | ✅ typecheck/UI render; ⛔ live | Email: Supabase project. Phone: paid SMS provider |
| Admin invitations (optional path) | ✅ `invite-user`, `accept_invitation` | ✅ DB logic | Supabase project + SMTP |
| Admin MFA (TOTP) enforced in DB (aal2) | ✅ `private.is_admin()`, MFA page | ✅ DB tests (aal1 denied, org-off allowed) | Supabase Auth live test |
| Password reset, logout, session events | ✅ | ⛔ live | Supabase project |
| Suspension revokes access + sessions | ✅ RPC + `admin-staff` ban | ✅ DB tests (data/RPC denied); ⛔ ban live | Supabase project |
| Shared DB, no localStorage source of truth, no demo role switch | ✅ | ✅ code review + build | – |
| RLS on every table, two-org isolation, forged IDs ignored | ✅ | ✅ 18 RLS tests | Storage/Realtime policies need live check |
| Products CRUD, unique SKU per org, active count | ✅ | ✅ typecheck/build; DB constraints | live UI check |
| Purchases with line items, price snapshot, numeric money, idempotency, void with audit | ✅ | ✅ DB tests | live UI check |
| Farmers CRUD, normalized phone, duplicate detection (no auto-merge), archive | ✅ | ✅ DB tests | live UI check |
| Map pin set/confirm, approximate vs verified, search never moves pin | ✅ | ✅ DB tests for verification rules | live UI check |
| Staff invite/edit/coverage/manager/suspend, counts | ✅ | ✅ typecheck | live |
| Visits create/reassign/cancel/reschedule with reason, version, notifications in one txn | ✅ | ✅ DB tests | live |
| Status machine + append-only events, completion requires outcome, no replay | ✅ | ✅ DB tests (TS ↔ SQL table synced) | – |
| Staff sees only own tasks with minimal farmer context | ✅ | ✅ DB tests | – |
| Google Maps directions (no key) | ✅ `googleDirectionsUrl` | ✅ unit test | device check |
| Map zoom/pan/full screen/search (web Leaflet; mobile Leaflet WebView) | ✅ | ⚠️ web login page rendered at 375/desktop; map screens not rendered without backend | backend + device |
| Address search via configurable provider proxy (no public demo dependency) | ✅ `places` | ✅ Deno typecheck | geocoder account |
| Duty/trip semantics, separate gaya/pahuncha/meeting/wapas timestamps, "Not recorded" | ✅ | ✅ DB lifecycle test + report | – |
| Geofence with manual override + flag | ✅ server + client pre-check | ✅ unit + DB tests | – |
| Location batch ingestion: validation, dedupe, quality flags, latest position | ✅ | ✅ DB tests | – |
| Native background GPS during duty only, visible indicator, stop on end | ✅ expo-location task + foreground service | ✅ typecheck + Android JS bundle | ⛔ EAS build + physical Android/iOS |
| Offline queue with ordered replay, idempotency, rejected-item review | ✅ mobile `sync.ts` | ✅ typecheck; server idempotency tested | device test |
| Route display: real points only, segmented, labelled | ✅ | ✅ typecheck | live data |
| Realtime admin map (RLS) | ✅ | ⛔ | Supabase project |
| Push via outbox → Expo → FCM/APNs; retries, dead-letter, token invalidation, receipts; generic lock-screen text | ✅ | ✅ DB outbox tests; Deno typecheck | EAS project, FCM, APNs |
| Reminders (cron) | ✅ | ✅ dedupe test | pg_cron on project |
| Private photo proof (storage policies, signed URLs) | ✅ | ⛔ | Supabase Storage |
| Reports (timeline, staff, product, exceptions) + audited CSV export with injection guard | ✅ | ✅ timeline in DB test; CSV unit test | – |
| Settings with validation + audit | ✅ | ✅ DB test | – |
| Responsive web 320–1440 px | ✅ CSS + card tables + bottom nav | ⚠️ login page only (no overflow at 375 px) | backend for other screens; Playwright E2E ready |
| Retention purge | ✅ `purge_expired_data` | ⚠️ not exercised by tests | – |
| CI (typecheck, tests, build, audit, mobile bundle, Deno, gitleaks) | ✅ `.github/workflows/ci.yml` | ⚠️ commands run locally; workflow not run on GitHub | GitHub repo |
| Docs: architecture, API, security/RLS, deployment, backup/rollback, testing, decisions | ✅ `docs/` | – | – |

## Not done / honest limits

* No production or staging deployment exists; no URLs to share yet.
* Mobile app has not been built into an APK/IPA or run on a device (needs Expo/EAS account).
* The migration from the earlier ChatGPT-hosted prototype was not possible — its source was not on this machine.
  This is a fresh implementation with the same screens and green visual direction; the old prototype is untouched.
* Failed-login events are recorded by Supabase Auth's own audit log, not in `session_events` (client can't log them reliably).
* Malware scanning of uploads is not implemented (MIME/size/path checks only).
