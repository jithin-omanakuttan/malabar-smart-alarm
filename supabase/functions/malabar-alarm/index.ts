/**
 * Malabar Smart Alarm - Supabase Edge Function entry point.
 *
 * Invoked by pg_cron (see supabase/migrations) at 03:47, 03:53 and 04:00 IST,
 * Monday-Friday, or manually:
 *
 *   curl -X POST https://<project-ref>.supabase.co/functions/v1/malabar-alarm \
 *     -H "x-alarm-secret: <ALARM_TRIGGER_SECRET>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"force": true, "dry_run": true}'
 */

import { handleRequest } from "./handler.ts";

Deno.serve((req) => handleRequest(req, Deno.env.toObject()));
