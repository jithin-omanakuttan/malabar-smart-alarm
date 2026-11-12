/**
 * Configuration: defaults below, overridable through Edge Function secrets
 * (environment variables). Secrets are kept in a separate object so that
 * `Settings` can be logged safely.
 */

import { isValidTimeZone } from "./time.ts";

export const WEEKDAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Settings {
  trainName: string;
  trainNumber: string;
  boardingStationName: string;
  boardingStationCode: string;
  destinationName: string;
  destinationCode: string;
  bufferMinutes: number;
  timezone: string;
  /** Monday = 0 ... Sunday = 6 */
  monitoringWeekdays: ReadonlySet<number>;
  /** Timetable arrival at the boarding station, used for FALLBACK (04:51 - 40 = 04:11). */
  fallbackScheduledArrival: { hour: number; minute: number };
  /** A prediction further than this from the timetable is treated as bad data. */
  maxPlausibleDelayMinutes: number;
  apiBaseUrl: string;
  apiTimeoutMs: number;
  apiMaxAttempts: number;
  /** Sender shown in the email. onboarding@resend.dev works without a verified domain. */
  emailFrom: string;
  /** Subject starts with this; the iPhone automation triggers on it. */
  emailSubjectPrefix: string;
  emailTimeoutMs: number;
  emailMaxAttempts: number;
}

export interface Secrets {
  railradarApiKey: string;
  resendApiKey: string;
  /** Recipient. On Resend's free plan without a domain: your Resend sign-up address. */
  emailTo: string;
}

export const DEFAULT_SETTINGS: Settings = {
  trainName: "Malabar Express",
  trainNumber: "16630",
  boardingStationName: "Chengannur",
  boardingStationCode: "CNGR",
  destinationName: "Kazhakuttam",
  destinationCode: "KZK",
  bufferMinutes: 40,
  timezone: "Asia/Kolkata",
  monitoringWeekdays: new Set([0, 1, 2, 3, 4]),
  fallbackScheduledArrival: { hour: 4, minute: 51 },
  maxPlausibleDelayMinutes: 720,
  apiBaseUrl: "https://api.railradar.in/v1",
  apiTimeoutMs: 15_000,
  apiMaxAttempts: 2,
  emailFrom: "Malabar Smart Alarm <onboarding@resend.dev>",
  emailSubjectPrefix: "Malabar Alarm",
  emailTimeoutMs: 10_000,
  emailMaxAttempts: 3,
};

export type Env = Record<string, string | undefined>;

/** Empty strings count as "not set". */
function get(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function parseIntIn(name: string, text: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(text)) throw new ConfigError(`${name} must be a whole number, got "${text}"`);
  const n = Number(text);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

export function parseHHMM(name: string, text: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new ConfigError(`${name} must be in 24-hour HH:MM format, got "${text}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new ConfigError(`${name} is not a valid time: "${text}"`);
  return { hour, minute };
}

/** "MON-FRI", "MON,WED,FRI", "MON-FRI,SUN" */
export function parseWeekdays(text: string): Set<number> {
  const days = new Set<number>();
  const names = WEEKDAY_NAMES as readonly string[];
  for (const part of text.toUpperCase().replace(/\s/g, "").split(",")) {
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-", 2);
      const i = names.indexOf(a);
      const j = names.indexOf(b);
      if (i < 0 || j < 0) throw new ConfigError(`MONITORING_DAYS has an unknown day in "${part}"`);
      if (i > j) throw new ConfigError(`MONITORING_DAYS range "${part}" must go forwards (e.g. MON-FRI)`);
      for (let k = i; k <= j; k++) days.add(k);
    } else {
      const i = names.indexOf(part);
      if (i < 0) throw new ConfigError(`MONITORING_DAYS has an unknown day "${part}"`);
      days.add(i);
    }
  }
  if (days.size === 0) throw new ConfigError("MONITORING_DAYS must contain at least one day");
  return days;
}

function requireHttps(name: string, url: string): string {
  if (!/^https:\/\//i.test(url)) throw new ConfigError(`${name} must use HTTPS`);
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: Env): { settings: Settings; secrets: Secrets } {
  const s: Settings = { ...DEFAULT_SETTINGS };

  const text = (name: string, key: "trainName" | "boardingStationName" | "destinationName" | "emailFrom") => {
    const v = get(env, name);
    if (v) s[key] = v;
  };
  text("TRAIN_NAME", "trainName");
  text("BOARDING_STATION_NAME", "boardingStationName");
  text("DESTINATION_NAME", "destinationName");
  text("ALARM_EMAIL_FROM", "emailFrom");

  const prefix = get(env, "EMAIL_SUBJECT_PREFIX");
  if (prefix) {
    if (/\d{1,2}:\d{2}/.test(prefix) || prefix.length > 60) {
      throw new ConfigError("EMAIL_SUBJECT_PREFIX must not contain a time (HH:MM) and must be at most 60 characters");
    }
    s.emailSubjectPrefix = prefix;
  }

  const trainNumber = get(env, "TRAIN_NUMBER");
  if (trainNumber) {
    if (!/^\d{4,6}$/.test(trainNumber)) throw new ConfigError(`TRAIN_NUMBER must be 4-6 digits, got "${trainNumber}"`);
    s.trainNumber = trainNumber;
  }

  for (const [name, key] of [["BOARDING_STATION_CODE", "boardingStationCode"], ["DESTINATION_CODE", "destinationCode"]] as const) {
    const code = get(env, name)?.toUpperCase();
    if (code) {
      if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new ConfigError(`${name} must be letters/digits only, got "${code}"`);
      s[key] = code;
    }
  }

  const tz = get(env, "TIMEZONE");
  if (tz) {
    if (!isValidTimeZone(tz)) throw new ConfigError(`TIMEZONE "${tz}" is not a valid IANA timezone`);
    s.timezone = tz;
  }

  const buffer = get(env, "BUFFER_MINUTES");
  if (buffer) s.bufferMinutes = parseIntIn("BUFFER_MINUTES", buffer, 0, 240);

  const days = get(env, "MONITORING_DAYS");
  if (days) s.monitoringWeekdays = parseWeekdays(days);

  const fallback = get(env, "FALLBACK_SCHEDULED_ARRIVAL");
  if (fallback) s.fallbackScheduledArrival = parseHHMM("FALLBACK_SCHEDULED_ARRIVAL", fallback);

  const apiBase = get(env, "RAILRADAR_API_BASE_URL");
  if (apiBase) s.apiBaseUrl = requireHttps("RAILRADAR_API_BASE_URL", apiBase);

  return {
    settings: s,
    secrets: {
      railradarApiKey: get(env, "RAILRADAR_API_KEY") ?? "",
      resendApiKey: get(env, "RESEND_API_KEY") ?? "",
      emailTo: get(env, "ALARM_EMAIL_TO") ?? "",
    },
  };
}
