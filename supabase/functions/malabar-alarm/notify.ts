/**
 * ntfy notifications: message formatting, the duplicate-send rule and delivery.
 * The topic acts like a password on public ntfy servers, so it is never logged
 * and never placed in error messages.
 */

import type { AlarmResult, Status } from "./alarm.ts";
import { NTFY_TOPIC_PATTERN, type Settings } from "./config.ts";
import { fetchWithTimeout, type FetchFn, HttpFailure, isRetryableStatus, realSleep, type SleepFn, USER_AGENT } from "./http.ts";
import type { Logger } from "./log.ts";
import { formatDateLong, formatTime12 } from "./time.ts";

export class NotificationError extends Error {
  override name = "NotificationError";
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

export interface NtfyMessage {
  title: string;
  body: string;
  priority: number;
  tags: string[];
}

export function formatDelay(minutes: number | null): string {
  if (minutes === null) return "not available";
  if (minutes === 0) return "on time";
  const unit = Math.abs(minutes) === 1 ? "minute" : "minutes";
  return minutes > 0 ? `${minutes} ${unit}` : `running ${Math.abs(minutes)} ${unit} early`;
}

export function buildMessage(result: AlarmResult, settings: Settings, now: Date, manual = false): NtfyMessage {
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

  const live = result.status === "LIVE";
  return {
    title: live ? settings.notificationTitle : `${settings.notificationTitle} - ${result.status}`,
    body: lines.join("\n"),
    priority: settings.ntfyPriority,
    tags: live ? ["steam_locomotive", "alarm_clock"] : ["warning", "alarm_clock"],
  };
}

/**
 * Decide whether to send, given the statuses already sent for this journey
 * date by scheduled (non-manual) runs. A LIVE result may replace an earlier
 * SCHEDULED/FALLBACK notification; everything else is sent once.
 */
export function shouldSend(alreadySent: ReadonlySet<string>, status: Status): { send: boolean; why: string } {
  const list = [...alreadySent].sort().join("/");
  if (alreadySent.size === 0) return { send: true, why: "no notification sent yet for this date" };
  if (status === "LIVE" && !alreadySent.has("LIVE")) return { send: true, why: `upgrading earlier ${list} notification to LIVE` };
  return { send: false, why: `already sent (${list}) for this date` };
}

/** HTTP headers must be latin-1; ntfy accepts RFC 2047 encoded words. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export interface NtfyOptions {
  token?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  log?: Logger;
}

export class NtfyClient {
  readonly #server: string;
  readonly #topic: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #fetch: FetchFn;
  readonly #sleep: SleepFn;
  readonly #log?: Logger;

  constructor(server: string, topic: string, opts: NtfyOptions = {}) {
    if (!/^https:\/\//i.test(server)) throw new NotificationError("ntfy server must use HTTPS");
    if (!topic || !NTFY_TOPIC_PATTERN.test(topic)) throw new NotificationError("NTFY_TOPIC is missing or invalid");
    this.#server = server.replace(/\/+$/, "");
    this.#topic = topic;
    this.#token = opts.token ?? "";
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.#retryDelayMs = opts.retryDelayMs ?? 2_000;
    this.#fetch = opts.fetchFn ?? fetch;
    this.#sleep = opts.sleep ?? realSleep;
    this.#log = opts.log;
  }

  toString(): string {
    return `NtfyClient(${this.#server}, topic=***)`;
  }

  /** Publish and return ntfy's message id. Throws NotificationError on failure. */
  async publish(message: NtfyMessage): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Title: encodeHeader(message.title),
      Priority: String(message.priority),
      Tags: message.tags.join(","),
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;

    let last: NotificationError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        return await this.#publishOnce(headers, message.body);
      } catch (err) {
        last = err instanceof NotificationError ? err : new NotificationError("ntfy publish failed unexpectedly", true);
        this.#log?.warn(`ntfy publish attempt ${attempt}/${this.#maxAttempts} failed: ${last.message}`);
        if (!last.retryable || attempt === this.#maxAttempts) break;
        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
    throw last!;
  }

  async #publishOnce(headers: Record<string, string>, body: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.#fetch,
        `${this.#server}/${this.#topic}`,
        { method: "POST", headers, body },
        this.#timeoutMs,
        "ntfy publish",
      );
    } catch (err) {
      if (err instanceof HttpFailure) throw new NotificationError(err.message, err.retryable);
      throw err;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotificationError(`ntfy publish failed (HTTP ${response.status})`, isRetryableStatus(response.status));
    }
    let reply: unknown;
    try {
      reply = JSON.parse(await response.text());
    } catch {
      throw new NotificationError("ntfy publish returned an unreadable response");
    }
    const r = reply as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || r.event !== "message" || !r.id) {
      throw new NotificationError("ntfy publish response did not confirm the message");
    }
    return String(r.id);
  }
}
