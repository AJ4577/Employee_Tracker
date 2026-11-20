# KisanRoute — field operations for agri-input businesses

Admin web (desktop/tablet/phone), staff web, and a native **staff mobile app** (Android first, iOS from the
same code) for background GPS during duty. Backend: Supabase (Postgres + RLS, Auth, Edge Functions,
Realtime, private Storage). Organization label and app name are configurable (default *Greenfield Agro* / *KisanRoute*).

```
apps/web            Vite + React + TypeScript — admin & staff browser UI
apps/staff-mobile   Expo (React Native) — staff app: duty/trip tracking, offline queue, push
packages/shared     Zod schemas, status transitions, geo/geofence, money, time, CSV, error codes
supabase/migrations SQL schema, RLS policies, business RPCs, platform setup (realtime, storage, cron)
supabase/functions  Edge Functions: invite-user, admin-staff, push-dispatch, places
tests/db            Migration + RLS + workflow tests on an in-process Postgres (PGlite)
docs/               Architecture, API, security, deployment, testing, status, owner decisions
```

## Quick start (local)

Requirements: Node 20+. For a full local Supabase stack you also need Docker + Supabase CLI; without Docker,
point the apps at a Supabase **staging** project.

```bash
npm install
npm test                      # 15 unit + 31 database tests (migrations, RLS, workflows)
npm run typecheck && npm run build
```

### Option A — local Supabase (Docker)

```bash
npx supabase start            # applies migrations + supabase/seed.sql (synthetic dev data)
cp apps/web/.env.example apps/web/.env.local   # paste the local API URL + anon key printed above
npm run dev                   # http://localhost:5173
```

Dev logins (synthetic, local only): `owner@example.test`, `amit.staff@example.test`, `neha.staff@example.test`, password `KisanRoute-dev-1`.

### Option B — Supabase staging project

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): link the project, `supabase db push`, deploy functions, set secrets,
bootstrap the first organization with `scripts/bootstrap-org.mjs`.

### Staff mobile app

```bash
cd apps/staff-mobile
npm install
cp .env.example .env          # EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY
npx eas build --profile development --platform android   # development build (needs an Expo account)
npx expo start --dev-client
```

Background location and push **do not work in Expo Go**; use a development or production build on a physical device.

## What is real and what needs your accounts

Everything in the code paths is wired to the real database and APIs — there is no demo role switch, no
`localStorage` data, no simulated GPS or notification success. What cannot be verified until you provide accounts:
Supabase project, Expo/EAS (push + builds), FCM/APNs credentials, a production map tile and geocoding provider,
a domain/hosting. See [docs/STATUS.md](docs/STATUS.md) for the requirement-by-requirement table and
[docs/OWNER_DECISIONS.md](docs/OWNER_DECISIONS.md) for the decisions needed before rollout.
