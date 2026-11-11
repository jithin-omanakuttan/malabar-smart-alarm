/**
 * Timezone helpers using only the built-in Intl API (no libraries).
 *
 * Instants are plain `Date` objects (UTC internally). Calendar dates are
 * "YYYY-MM-DD" strings interpreted in the configured IANA timezone.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Monday = 0 ... Sunday = 6 */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday],
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar date ("YYYY-MM-DD") of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset of `tz` from UTC at `instant`, in minutes (IST = +330). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The instant at wall-clock `hour:minute:second` on `date` in `tz`. */
export function zonedTimeToDate(date: string, hour: number, minute: number, tz: string, second = 0): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, second);
  let result = guess - offsetMinutes(new Date(guess), tz) * 60000;
  // Re-check once in case the offset differs at the corrected instant (DST zones).
  const corrected = guess - offsetMinutes(new Date(result), tz) * 60000;
  if (corrected !== result) result = corrected;
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** "05:14 AM" (built manually: newer ICU inserts a narrow no-break space). */
export function formatTime12(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${pad(h12)}:${pad(p.minute)} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** "05:14" (24-hour). */
export function formatTime24(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Thu 12 Nov 2026" for a "YYYY-MM-DD" date. */
export function formatDateLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${DAY_NAMES[weekday]} ${pad(d)} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** "12 Nov 2026" for a "YYYY-MM-DD" date. */
export function formatDateShort(date: string): string {
  return formatDateLong(date).slice(4);
}
