# Deployment

Use **separate** Supabase projects for staging and production, each with its own secrets.

## 1. Supabase project

1. Create a project (region close to users, e.g. Mumbai `ap-south-1`). For production choose a paid plan with
   daily backups (enable PITR if available) — the free tier is for development/pilot only.
2. Auth → Providers: Email on; **disable sign-ups**. Auth → URL configuration: Site URL = your web URL; add redirect
   URLs `https://<web>/accept-invite`, `https://<web>/reset-password`. Auth → MFA: enable TOTP.
   Password policy ≥10 chars with upper/lower/digit. Configure custom SMTP (sender domain) for invitations.
3. Link and push the schema:

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push          # applies supabase/migrations (does NOT run seed.sql)
```

4. Deploy functions and set secrets (never commit these):

```bash
npx supabase functions deploy invite-user admin-staff places
npx supabase functions deploy push-dispatch --no-verify-jwt
npx supabase secrets set APP_URL=https://app.example.com ALLOWED_ORIGINS=https://app.example.com \
  CRON_SECRET=$(openssl rand -hex 32) INVITE_TTL_HOURS=72 \
  EXPO_ACCESS_TOKEN=<expo access token, optional but recommended> \
  GEOCODER_NAME=<provider> GEOCODER_SEARCH_URL='<https template with {q} and {key}>' \
  GEOCODER_REVERSE_URL='<https template with {lat} {lon} {key}>' GEOCODER_KEY=<server key>
```

5. Schedule push dispatch every minute (SQL editor; uses Vault so the secret is not in plain SQL):

```sql
select vault.create_secret('<same CRON_SECRET>', 'kisanroute_cron_secret');
select cron.schedule('kisanroute-push', '* * * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kisanroute_cron_secret')),
    body := '{}'::jsonb)
$$);
```

   (Requires `pg_net` extension enabled.) Reminders and retention cron jobs are created by the migration when `pg_cron` exists.

6. Bootstrap the first organization and owner (from a trusted machine):

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> APP_URL=https://app.example.com \
  npm run bootstrap:org -- --org "Greenfield Agro" --email owner@company.com --name "Owner Name"
```

## 2. Web (static hosting, e.g. Cloudflare Pages)

* Build command `npm ci && npm run build`, output `apps/web/dist`.
* Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public values only).
* `apps/web/public/_headers` sets HSTS/CSP/etc. — **edit the CSP** `img-src`/`connect-src` for your tile and
  Supabase hosts. `_redirects` provides SPA fallback.
* Keep the site private (e.g. Cloudflare Access) until go-live if desired.

## 3. Mobile (EAS)

1. `npx eas login`, `npx eas init` (writes the EAS project ID into `app.json` → `extra.eas.projectId`).
2. Android push: create a Firebase project, add the Android app (`com.greenfieldagro.kisanroute.staff`), upload the
   FCM V1 service-account key to EAS (`npx eas credentials`). iOS: Apple Developer account; EAS manages APNs key.
3. Set `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` as EAS environment variables per profile.
4. From `apps/staff-mobile`: `npx eas build --profile development --platform android` (dev build) or
   `npx eas build --profile staging --platform android`; distribute internally;
   production via Play Console (declare background location use with a video per Google policy) / App Store.

## 4. Rollout checklist

- [ ] Staging project with synthetic org/users; run `apps/web` E2E and the device matrix in TESTING.md
- [ ] Production backup taken (`supabase db dump` + dashboard backup) before `db push`
- [ ] Smoke test: owner invite → MFA → add staff → assign visit → staff app push → start/arrive/complete
- [ ] Spend alerts set on Supabase, Expo, map/geocoder provider

## Backup, migration & rollback

* Migrations are additive and versioned. Before production `db push`: `npx supabase db dump -f backup-<date>.sql`
  (plus `--data-only` dump) and confirm a dashboard backup/PITR point exists.
* Rollback strategy: forward-fix migration preferred. For a failed release, restore from PITR/backup to a new
  project or roll back the web deploy (static hosting keeps previous builds) and the mobile release (Play staged rollout halt).
* Restore drill: quarterly restore a backup into a scratch project and run `npm run test:db`-equivalent smoke checks.

## Cost sizing to measure

30 staff × 8 h × 60 points/h × 26 days ≈ **374,400 location rows/month** at one per minute (≈ double at 30 s).
Watch: DB size (location_points + indexes), Realtime messages (admin map open only), Edge Function invocations
(push-dispatch every minute ≈ 43k/month), tile requests, geocoding requests (cached 30 days).
