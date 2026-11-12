-- Malabar Smart Alarm: delivery moved from ntfy to email (Resend).
-- The provider-specific column name no longer fits.
alter table public.alarm_runs rename column ntfy_message_id to message_id;

comment on column public.alarm_runs.message_id is 'Id returned by the email provider (Resend) for a sent email.';
