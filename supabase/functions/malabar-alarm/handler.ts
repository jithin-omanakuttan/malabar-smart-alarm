/**
 * Orchestration. `handleRequest` is the HTTP entry point; `runAlarm` is the
 * testable core.
 *
 *   POST  (pg_cron via pg_net, or curl)  -> check train, email the wake-up time
 *   GET   (iPhone Shortcut backup)        -> latest emailed wake-up for today, e.g.
 *         {"wakeup":"04:36","status":"LIVE",...}   (add ?format=text for "04:36")
 */

import { type AlarmResult, buildFallback, calculateFromSnapshot } from "./alarm.ts";
import { ConfigError, type Env, loadConfig, parseBool, type Settings } from "./config.ts";
import type { FetchFn, SleepFn } from "./http.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { buildEmail, NotificationError, ResendEmailClient, shouldSend } from "./notify.ts";
import { RailRadarClient, RailRadarError } from "./railradar.ts";
import { PostgrestStore, type RunStore, StoreError } from "./store.ts";
import { addDays, formatTime24, localDate, zonedParts } from "./time.ts";
import { extractSnapshot, TrainDataError } from "./train.ts";

export interface RunOptions {
  force: boolean;
  skipDedupe: boolean;
  dryRun: boolean;
  now: Date;
}

export interface Deps {
  railradar: RailRadarClient | null;
  email: ResendEmailClient | null;
  store: RunStore | null;
  log: Logger;
}

export type RunOutcome = "sent" | "skipped" | "not_monitoring_day" | "dry_run" | "delivery_failed";

export interface RunReport {
  outcome: RunOutcome;
  journeyDate: string;
  status?: string;
  arrival?: string;
  wakeup?: string;
  delayMinutes?: number | null;
  reason?: string | null;
  detail: string;
  messageId?: string;
  email?: { subject: string; text: string };
}

export function isMonitoringDay(now: Date, settings: Settings): boolean {
  return settings.monitoringWeekdays.has(zonedParts(now, settings.timezone).weekday);
}

/**
 * The journey date to check. Scheduled runs happen before dawn, so this is
 * normally today. A run after midday looks at tomorrow morning's arrival
 * (tonight's train) instead of returning a stale FALLBACK.
 */
export function journeyDateFor(now: Date, settings: Settings): string {
  const today = localDate(now, settings.timezone);
  return zonedParts(now, settings.timezone).hour >= 12 ? addDays(today, 1) : today;
}

export async function resolveAlarm(
  settings: Settings,
  railradar: RailRadarClient | null,
  journeyDate: string,
  log: Logger,
): Promise<AlarmResult> {
  if (!railradar) return buildFallback(settings, journeyDate, "RailRadar API key is not configured");
  let payload: unknown;
  try {
    payload = await railradar.fetchLive(settings.trainNumber);
  } catch (err) {
    if (err instanceof RailRadarError) return buildFallback(settings, journeyDate, `RailRadar API unavailable: ${err.message}`);
    throw err;
  }
  try {
    const snapshot = extractSnapshot(payload, settings.trainNumber, settings.boardingStationCode, settings.timezone, log);
    return calculateFromSnapshot(snapshot, settings, journeyDate);
  } catch (err) {
    if (err instanceof TrainDataError) return buildFallback(settings, journeyDate, `Unusable API response: ${err.message}`);
    throw err;
  }
}

export async function runAlarm(settings: Settings, opts: RunOptions, deps: Deps): Promise<RunReport> {
  const { log } = deps;
  const tz = settings.timezone;
  const journeyDate = journeyDateFor(opts.now, settings);
  log.info(
    `Run started: train ${settings.trainNumber}, station ${settings.boardingStationCode}, ` +
      `now ${opts.now.toISOString()}, journey date ${journeyDate}, manual=${opts.force}`,
  );

  if (!opts.force && !isMonitoringDay(opts.now, settings)) {
    log.info("Not a monitoring day - nothing to do");
    return { outcome: "not_monitoring_day", journeyDate, detail: "not a monitoring day" };
  }

  const result = await resolveAlarm(settings, deps.railradar, journeyDate, log);
  const base: RunReport = {
    outcome: "dry_run",
    journeyDate,
    status: result.status,
    arrival: formatTime24(result.arrival, tz),
    wakeup: formatTime24(result.wakeup, tz),
    delayMinutes: result.delayMinutes,
    reason: result.reason,
    detail: "",
  };
  log.info(`Result: status=${base.status} arrival=${base.arrival} wakeup=${base.wakeup} delay=${base.delayMinutes} reason=${base.reason ?? "-"}`);

  const email = buildEmail(result, settings, opts.now, opts.force);
  const record = async (outcome: "sent" | "skipped" | "delivery_failed" | "dry_run", detail: string, id?: string) => {
    if (!deps.store) return;
    try {
      await deps.store.record({ outcome, manual: opts.force, trainNumber: settings.trainNumber, result, detail, messageId: id });
    } catch (err) {
      log.warn(`Could not write run log: ${(err as Error).message}`);
    }
  };

  if (opts.dryRun) {
    log.info("Dry run - email NOT sent");
    await record("dry_run", "dry run");
    return { ...base, outcome: "dry_run", detail: "dry run - email not sent", email: { subject: email.subject, text: email.text } };
  }
  if (!deps.email) throw new NotificationError("email client is not configured");

  // Manual runs never count for duplicate protection, so they always send.
  if (!opts.skipDedupe && !opts.force) {
    let already = new Set<string>();
    if (deps.store) {
      try {
        already = await deps.store.sentStatuses(settings.trainNumber, journeyDate);
      } catch (err) {
        // Better a possible duplicate than a missed alarm (Resend's idempotency key also guards repeats).
        log.warn(`Duplicate check unavailable (${(err as Error).message}); sending anyway`);
      }
    } else {
      log.warn("Run log not configured; duplicate check skipped");
    }
    const decision = shouldSend(already, result.status);
    if (!decision.send) {
      log.info(`Not sending: ${decision.why}`);
      await record("skipped", decision.why);
      return { ...base, outcome: "skipped", detail: decision.why };
    }
    log.info(`Sending: ${decision.why}`);
  }

  let messageId: string;
  try {
    messageId = await deps.email.send(email);
  } catch (err) {
    const why = err instanceof NotificationError ? err.message : "unexpected error";
    log.error(`Email NOT delivered: ${why}`);
    await record("delivery_failed", why);
    return { ...base, outcome: "delivery_failed", detail: `Email NOT delivered: ${why}` };
  }
  log.info(`Email accepted by provider (id=${messageId}, status=${result.status})`);
  await record("sent", "email accepted by provider", messageId);
  return { ...base, outcome: "sent", detail: "email accepted by provider", messageId };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Constant-time comparison (compares SHA-256 digests so lengths never leak). */
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Service key injected by Supabase: legacy JWT, or the newer sb_secret_ key set. */
export function serviceKeyFrom(env: Env): string {
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY;
  const raw = env.SUPABASE_SECRET_KEYS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const first = (parsed as Record<string, unknown>).default ?? Object.values(parsed)[0];
        if (typeof first === "string") return first;
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

export interface HandlerDeps {
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  log?: Logger;
  now?: () => Date;
  store?: RunStore | null;
}

function makeStore(env: Env, hd: HandlerDeps, log: Logger): RunStore | null {
  if (hd.store !== undefined) return hd.store;
  try {
    return new PostgrestStore(env.SUPABASE_URL ?? "", serviceKeyFrom(env), hd.fetchFn);
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    log.warn(`${err.message}; run log and duplicate protection disabled`);
    return null;
  }
}

/** GET: the latest emailed wake-up time for the current journey date. */
async function handleLatest(req: Request, settings: Settings, store: RunStore | null, now: Date): Promise<Response> {
  if (!store) return json(503, { error: "Run log not available" });
  const journeyDate = journeyDateFor(now, settings);
  let latest;
  try {
    latest = await store.latestSent(settings.trainNumber, journeyDate);
  } catch (err) {
    return json(503, { error: (err as Error).message });
  }
  const textFormat = new URL(req.url).searchParams.get("format") === "text";
  if (!latest) {
    return textFormat
      ? new Response("NONE", { status: 404, headers: { "Content-Type": "text/plain" } })
      : json(404, { journeyDate, error: "No wake-up time sent yet for this journey date" });
  }
  const wakeup = formatTime24(new Date(latest.wakeup), settings.timezone);
  if (textFormat) return new Response(wakeup, { status: 200, headers: { "Content-Type": "text/plain" } });
  return json(200, {
    journeyDate,
    wakeup,
    arrival: formatTime24(new Date(latest.arrival), settings.timezone),
    status: latest.status,
    manual: latest.manual,
    sentAt: latest.createdAt,
  });
}

export async function handleRequest(req: Request, env: Env, hd: HandlerDeps = {}): Promise<Response> {
  const log = hd.log ?? consoleLogger;

  if (req.method !== "POST" && req.method !== "GET") return json(405, { error: "Use POST (run) or GET (latest wake-up)" });

  const expected = env.ALARM_TRIGGER_SECRET?.trim();
  if (!expected) {
    log.error("ALARM_TRIGGER_SECRET is not configured");
    return json(500, { error: "Function is not configured (ALARM_TRIGGER_SECRET missing)" });
  }
  if (!(await secretsMatch(req.headers.get("x-alarm-secret") ?? "", expected))) {
    return json(401, { error: "Unauthorized" });
  }

  let settings: Settings;
  let secrets;
  try {
    ({ settings, secrets } = loadConfig(env));
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`Configuration error: ${err.message}`);
      return json(500, { error: `Configuration error: ${err.message}` });
    }
    throw err;
  }
  const now = hd.now ? hd.now() : new Date();

  if (req.method === "GET") return handleLatest(req, settings, makeStore(env, hd, log), now);

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    }
  } catch {
    return json(400, { error: "Body must be JSON, e.g. {\"force\": true, \"dry_run\": true}" });
  }
  const opts: RunOptions = {
    force: parseBool(body.force),
    skipDedupe: parseBool(body.skip_dedupe),
    dryRun: parseBool(body.dry_run),
    now,
  };

  let email: ResendEmailClient | null = null;
  if (!opts.dryRun) {
    try {
      email = new ResendEmailClient(secrets.resendApiKey, settings.emailFrom, secrets.emailTo, {
        timeoutMs: settings.emailTimeoutMs,
        maxAttempts: settings.emailMaxAttempts,
        fetchFn: hd.fetchFn,
        sleep: hd.sleep,
        log,
      });
    } catch (err) {
      log.error(`Configuration error: ${(err as Error).message}`);
      return json(500, { error: `Configuration error: ${(err as Error).message}` });
    }
  }

  let railradar: RailRadarClient | null = null;
  let warning: string | undefined;
  try {
    railradar = new RailRadarClient(secrets.railradarApiKey, {
      baseUrl: settings.apiBaseUrl,
      timeoutMs: settings.apiTimeoutMs,
      maxAttempts: settings.apiMaxAttempts,
      fetchFn: hd.fetchFn,
      sleep: hd.sleep,
      log,
    });
  } catch (err) {
    warning = (err as Error).message;
    log.error(`${warning} - a FALLBACK email will be sent`);
  }

  const report = await runAlarm(settings, opts, { railradar, email, store: makeStore(env, hd, log), log });
  const status = report.outcome === "delivery_failed" ? 502 : 200;
  return json(status, warning ? { ...report, warning } : report);
}
