# Testing

## Automated (run in CI on every push)

| Suite | Command | Covers |
|---|---|---|
| Shared unit (15) | `npm test -w packages/shared` | haversine, geofence, point quality, freshness, transitions, money in paise, IST day ranges, phone normalisation, schemas, CSV injection, error mapping |
| Database (31) | `npm run test:db` | all migrations from a clean DB; RLS enabled on every table; anon denied; two-org isolation (read, write, assign, visit detail); forged `organization_id` ignored; admin MFA (aal2) enforcement; staff can't browse farmers/products/purchases/peers; staff peer gets `not_found`; location insert forgery denied; reassignment revokes access + notifies; suspension blocks data + RPCs; append-only tables; no phone in audit; full duty→trip→arrive (geofence/reason)→complete (follow-up once)→return→end lifecycle with separate timestamps; location dedupe/teleport/invalid; one active trip; limited mode; invalid transitions; version conflicts; purchase totals/snapshots/idempotency/cross-org product; farmer duplicate detection and pin verification; outbox claim/backoff/dead-letter/token invalidation; service-only functions; reminder dedupe; settings validation |
| Web typecheck + build | `npm run typecheck && npm run build` | |
| Mobile typecheck + Android bundle | `cd apps/staff-mobile && npx tsc --noEmit && npx expo export --platform android` | |
| Edge Functions | `deno check supabase/functions/*/index.ts` | |
| Web E2E (staging) | `npm run test:e2e -w apps/web` | anonymous redirect at 5 widths; admin creates product/farmer/pin/visit; staff opens it; second staff denied; no horizontal overflow (see `apps/web/e2e/README.md`) |

The database tests run the real migrations on PGlite with a minimal stand-in for Supabase's `auth` schema.
They do not exercise Supabase Storage, Realtime or GoTrue itself — those are covered by the staging checks below.

## Staging verification (requires accounts)

Run all 11 manual acceptance scenarios from the brief on staging and record results here.

| # | Scenario | Result | Date / tester |
|---|---|---|---|
| 1 | Invite → accept → login; anonymous sees nothing | | |
| 2 | Product + farmer + confirmed pin + purchase history | | |
| 3 | Assign visit → in-app + push; other staff can't see | | |
| 4 | Farmer map, full screen, search, Google directions (phone/tablet/desktop) | | |
| 5 | Duty + trip with phone locked; arrive; outcome; return; admin sees points + timestamps | | |
| 6 | Permission denied / no GPS → limited mode, no fake live dot | | |
| 7 | Offline queue syncs once, no duplicates | | |
| 8 | Reassign → old staff loses access, new staff notified | | |
| 9 | Suspend → session and APIs stop | | |
| 10 | Two organizations isolated (DB, API, Realtime, storage, exports) | | |
| 11 | 320/390/768/1024/1440 px: no overflow, controls usable | | |

## Physical device matrix (fill in during staging)

| Device | OS | Build | Locked-phone tracking | Battery saver | Force-close | Denied permission | Offline → sync | Push open → deep link | Notes |
|---|---|---|---|---|---|---|---|---|---|
| e.g. Redmi / Samsung A-series | Android 13/14 | dev build | | | | | | | OEM battery optimisation may stop tracking — whitelist app |
| e.g. iPhone 12 | iOS 17/18 | dev build | | | | | | | iOS may pause updates if app is force-quit |

Known platform limits (documented to users): force-quitting the app stops tracking on iOS and some Android
OEMs; aggressive battery savers delay or drop fixes; no fixes are recorded without GPS signal — the admin map
then shows *Stale* / *Last known*, never *Live*.
