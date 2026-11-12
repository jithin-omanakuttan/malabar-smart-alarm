/**
 * Email notifications via the Resend HTTPS API (https://resend.com).
 *
 * The email is designed to be read by an iPhone Shortcuts automation:
 *   Subject: "Malabar Alarm 04:36 | LIVE | Thu 12 Nov 2026"
 *   Body line 1: "WAKEUP=04:36"   (24-hour, IST)
 * The automation triggers on "Subject Contains: Malabar Alarm", extracts the
 * first HH:MM and creates the alarm.
 *
 * The Resend API key is never logged or placed in error messages.
 */

import type { AlarmResult, Status } from "./alarm.ts";
import type { Settings } from "./config.ts";
import { fetchWithTimeout, type FetchFn, HttpFailure, isRetryableStatus, realSleep, type SleepFn, USER_AGENT } from "./http.ts";
import type { Logger } from "./log.ts";
import { formatDateLong, formatTime12, formatTime24, offsetMinutes, zonedParts } from "./time.ts";

export class NotificationError extends Error {
  override name = "NotificationError";
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

export interface EmailMessage {
  subject: string;
  text: string;
  /** Resend idempotency key: identical keys within 24h are delivered once. */
  idempotencyKey: string;
}

export function formatDelay(minutes: number | null): string {
  if (minutes === null) return "not available";
  if (minutes === 0) return "on time";
  const unit = Math.abs(minutes) === 1 ? "minute" : "minutes";
  return minutes > 0 ? `${minutes} ${unit}` : `running ${Math.abs(minutes)} ${unit} early`;
}

/** Human-readable lines (also the second half of the email body). */
export function buildDetails(result: AlarmResult, settings: Settings, now: Date, manual = false): string[] {
  const tz = settings.timezone;
  const arrival = formatTime12(result.arrival, tz);
  const lines = [
    `Train: ${settings.trainName} (${settings.trainNumber})`,
    `Boarding: ${settings.boardingStationName} (${settings.boardingStationCode})`,
    `Date: ${formatDateLong(result.journeyDate)}`,
  ];
  if (result.status === "LIVE") lines.push(`Predicted arrival: ${arrival}`);
  else if (result.status === "SCHEDULED") lines.push(`Scheduled arrival: ${arrival} (no live prediction)`);
  else lines.push(`Fallback arrival: ${arrival} (timetable, NOT live)`);
  lines.push(`Recommended wake-up: ${formatTime12(result.wakeup, tz)}`);
  lines.push(`Buffer: ${result.bufferMinutes} minutes`);
  if (result.status !== "FALLBACK") lines.push(`Delay: ${formatDelay(result.delayMinutes)}`);
  lines.push(`Status: ${result.status}`);
  if (result.status === "LIVE" && result.provenance) lines.push(`Source: RailRadar (${result.provenance})`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (now.getTime() >= result.wakeup.getTime()) {
    lines.push("Note: The recommended wake-up time has already passed - get up now.");
  }
  if (manual) lines.push("(Manual test run)");
  return lines;
}

export function buildEmail(result: AlarmResult, settings: Settings, now: Date, manual = false): EmailMessage {
  const tz = settings.timezone;
  const wake24 = formatTime24(result.wakeup, tz);
  const subject = `${settings.emailSubjectPrefix} ${wake24} | ${result.status} | ${formatDateLong(result.journeyDate)}` +
    (manual ? " | TEST" : "");
  const text = [
    `WAKEUP=${wake24}`,
    `WAKEUP_ISO=${isoInZone(result.wakeup, tz)}`,
    `STATUS=${result.status}`,
    "",
    ...buildDetails(result, settings, now, manual),
  ].join("\n");
  const idempotencyKey = manual
    ? `malabar-manual-${crypto.randomUUID()}`
    : `malabar-${settings.trainNumber}-${result.journeyDate}-${result.status}`;
  return { subject, text, idempotencyKey };
}

/** "2026-11-12T04:36:00+05:30" */
export function isoInZone(instant: Date, tz: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = zonedParts(instant, tz);
  const off = offsetMinutes(instant, tz);
  const abs = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00` +
    `${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Decide whether to send, given the statuses already sent for this journey
 * date by scheduled (non-manual) runs. A LIVE result may replace an earlier
 * SCHEDULED/FALLBACK email; everything else is sent once.
 */
export function shouldSend(alreadySent: ReadonlySet<string>, status: Status): { send: boolean; why: string } {
  const list = [...alreadySent].sort().join("/");
  if (alreadySent.size === 0) return { send: true, why: "no email sent yet for this date" };
  if (status === "LIVE" && !alreadySent.has("LIVE")) return { send: true, why: `upgrading earlier ${list} email to LIVE` };
  return { send: false, why: `already sent (${list}) for this date` };
}

export const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface EmailOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  log?: Logger;
}

export class ResendEmailClient {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #to: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #fetch: FetchFn;
  readonly #sleep: SleepFn;
  readonly #log?: Logger;

  constructor(apiKey: string, from: string, to: string, opts: EmailOptions = {}) {
    if (!apiKey) throw new NotificationError("RESEND_API_KEY is not configured");
    if (!to || !EMAIL_PATTERN.test(to)) throw new NotificationError("ALARM_EMAIL_TO is missing or not an email address");
    if (!from) throw new NotificationError("ALARM_EMAIL_FROM is empty");
    const endpoint = opts.endpoint ?? "https://api.resend.com/emails";
    if (!/^https:\/\//i.test(endpoint)) throw new NotificationError("Email API endpoint must use HTTPS");
    this.#apiKey = apiKey;
    this.#from = from;
    this.#to = to;
    this.#endpoint = endpoint;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.#retryDelayMs = opts.retryDelayMs ?? 2_000;
    this.#fetch = opts.fetchFn ?? fetch;
    this.#sleep = opts.sleep ?? realSleep;
    this.#log = opts.log;
  }

  toString(): string {
    return `ResendEmailClient(apiKey=***)`;
  }

  /** Send and return Resend's email id. Throws NotificationError on failure. */
  async send(message: EmailMessage): Promise<string> {
    let last: NotificationError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        return await this.#sendOnce(message);
      } catch (err) {
        last = err instanceof NotificationError ? err : new NotificationError("email send failed unexpectedly", true);
        this.#log?.warn(`Email attempt ${attempt}/${this.#maxAttempts} failed: ${last.message}`);
        if (!last.retryable || attempt === this.#maxAttempts) break;
        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
    throw last!;
  }

  async #sendOnce(message: EmailMessage): Promise<string> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.#fetch, this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({ from: this.#from, to: [this.#to], subject: message.subject, text: message.text }),
      }, this.#timeoutMs, "Email send");
    } catch (err) {
      if (err instanceof HttpFailure) throw new NotificationError(err.message, err.retryable);
      throw err;
    }

    const raw = await response.text().catch(() => "");
    let reply: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") reply = parsed as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }

    if (!response.ok) {
      let why = typeof reply.message === "string" ? reply.message : raw.split("\n")[0] ?? "";
      why = why.split(this.#apiKey).join("***").replace(/[^\x20-\x7e]/g, "").slice(0, 200);
      throw new NotificationError(
        `Email send failed (HTTP ${response.status}${why ? `: ${why}` : ""})`,
        isRetryableStatus(response.status),
      );
    }
    if (typeof reply.id !== "string" || !reply.id) {
      throw new NotificationError("Email API response did not confirm the email");
    }
    return reply.id;
  }
}
