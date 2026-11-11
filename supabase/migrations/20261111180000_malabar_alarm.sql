-- Malabar Smart Alarm: run log + schedule.
--
-- Secrets are NOT stored in this file. Before the schedule can work, create
-- two Vault secrets once in the SQL editor (see README "Step 6"):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'malabar_project_url');
--   select vault.create_secret('<ALARM_TRIGGER_SECRET>', 'malabar_trigger_secret');

-- ---------------------------------------------------------------------------
-- 1. Run log (duplicate protection + audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.alarm_runs (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  journey_date     date        not null,
  train_number     text        not null,
  status           text        not null check (status in ('LIVE', 'SCHEDULED', 'FALLBACK')),
  outcome          text        not null check (outcome in ('sent', 'skipped', 'delivery_failed', 'dry_run')),
  manual           boolean     not null default false,
  arrival          timestamptz,
  wakeup           timestamptz,
  delay_minutes    integer,
  reason           text,
  detail           text,
  ntfy_message_id  text
);

create index if not exists alarm_runs_lookup_idx
  on public.alarm_runs (train_number, journey_date, outcome);

comment on table public.alarm_runs is
  'Malabar Smart Alarm: one row per Edge Function run. Written only by the function (service key).';

-- Row Level Security on with no policies: the public anon/authenticated keys
-- cannot read or write this table. The Edge Function uses the service key,
-- which bypasses RLS.
alter table public.alarm_runs enable row level security;
revoke all on table public.alarm_runs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Schedule: pg_cron + pg_net call the Edge Function
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- pg_cron runs in UTC (GMT). IST = UTC+5:30, so:
--   03:47 / 03:53 / 04:00 IST Mon-Fri  =  22:17 / 22:23 / 22:30 UTC Sun-Thu
-- Three runs give redundancy; the function sends once and later runs skip
-- (or upgrade a SCHEDULED/FALLBACK notification to LIVE).
-- cron.schedule() with an existing job name updates that job.
select cron.schedule(
  'malabar-alarm',
  '17,23,30 22 * * 0-4',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'malabar_project_url')
           || '/functions/v1/malabar-alarm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-alarm-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'malabar_trigger_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Keep the cron and pg_net history tables small (runs daily at 23:00 UTC).
select cron.schedule(
  'malabar-alarm-cleanup',
  '0 23 * * *',
  $$
  delete from cron.job_run_details where end_time < now() - interval '30 days';
  delete from public.alarm_runs where created_at < now() - interval '180 days';
  $$
);
