-- Supabase platform integration: Realtime publication, private Storage bucket + policies, scheduled jobs.
-- Each block is guarded so the migration also runs on plain Postgres (CI tests use PGlite).

-- ---------------------------------------------------------------- Realtime
-- postgres_changes respects RLS: admins receive org rows, staff only their own.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.latest_staff_position, public.visits, public.user_notifications;
  end if;
end $$;

-- ---------------------------------------------------------------- Storage (private bucket for visit proof)
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('visit-proof', 'visit-proof', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    -- Object path convention: {organization_id}/{visit_id}/{uuid}.{ext}
    execute $p$
      create policy visit_proof_read on storage.objects for select to authenticated using (
        bucket_id = 'visit-proof'
        and (storage.foldername(name))[1] = private.my_org()::text
        and (private.is_admin() or private.is_my_visit(((storage.foldername(name))[2])::uuid))
      )$p$;
    execute $p$
      create policy visit_proof_insert on storage.objects for insert to authenticated with check (
        bucket_id = 'visit-proof'
        and (storage.foldername(name))[1] = private.my_org()::text
        and (private.is_admin() or private.is_my_visit(((storage.foldername(name))[2])::uuid))
      )$p$;
    -- No update/delete policies: uploaded proof is immutable for clients.
  end if;
end $$;

-- ---------------------------------------------------------------- Scheduled jobs (pg_cron)
-- Reminders and retention run in the database. Push dispatch runs in the push-dispatch
-- Edge Function, scheduled per docs/DEPLOYMENT.md (needs the project URL + secret).
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('kisanroute-reminders', '*/5 * * * *', 'select public.enqueue_due_reminders()');
    perform cron.schedule('kisanroute-retention', '17 2 * * *', 'select public.purge_expired_data()');
  end if;
end $$;
