/**
 * Turn a boarding-station reading into a recommended wake-up time.
 *
 * Arrival priority:
 *   1. actualArrival    -> LIVE      (RailRadar's predicted/actual arrival)
 *   2. scheduledArrival -> SCHEDULED (timetable, no live prediction)
 *   3. configured time  -> FALLBACK  (API unusable)
 *
 * If the station's arrival date is not the journey date being monitored
 * (e.g. the API still shows yesterday's run) the result is FALLBACK - stale
 * data is never presented as live.
 */

import type { Settings } from "./config.ts";
import { formatDateShort, localDate, zonedTimeToDate } from "./time.ts";
import type { TrainSnapshot } from "./train.ts";

export const MAX_BUFFER_MINUTES = 240;

export type Status = "LIVE" | "SCHEDULED" | "FALLBACK";
export const STATUSES: readonly Status[] = ["LIVE", "SCHEDULED", "FALLBACK"];

export interface AlarmResult {
  status: Status;
  /** "YYYY-MM-DD" journey date in the configured timezone */
  journeyDate: string;
  arrival: Date;
  wakeup: Date;
  bufferMinutes: number;
  delayMinutes: number | null;
  provenance: string | null;
  reason: string | null;
}

export function calculateWakeup(arrival: Date, bufferMinutes: number): Date {
  if (!(arrival instanceof Date) || Number.isNaN(arrival.getTime())) throw new RangeError("arrival must be a valid Date");
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > MAX_BUFFER_MINUTES) {
    throw new RangeError(`bufferMinutes must be an integer between 0 and ${MAX_BUFFER_MINUTES}`);
  }
  return new Date(arrival.getTime() - bufferMinutes * 60000);
}

export function buildFallback(settings: Settings, journeyDate: string, reason: string): AlarmResult {
  const { hour, minute } = settings.fallbackScheduledArrival;
  const arrival = zonedTimeToDate(journeyDate, hour, minute, settings.timezone);
  return {
    status: "FALLBACK",
    journeyDate,
    arrival,
    wakeup: calculateWakeup(arrival, settings.bufferMinutes),
    bufferMinutes: settings.bufferMinutes,
    delayMinutes: null,
    provenance: null,
    reason,
  };
}

const minutesBetween = (later: Date, earlier: Date) => Math.round((later.getTime() - earlier.getTime()) / 60000);

export function calculateFromSnapshot(snapshot: TrainSnapshot, settings: Settings, journeyDate: string): AlarmResult {
  const st = snapshot.station;
  const scheduled = st.scheduledArrival;
  const actual = st.actualArrival;
  const code = st.stationCode;

  const reference = scheduled ?? actual;
  if (!reference) {
    const detail = st.invalidFields.length ? ` (invalid: ${st.invalidFields.join(", ")})` : "";
    return buildFallback(settings, journeyDate, `No arrival time for ${code} in API response${detail}`);
  }

  const referenceDate = localDate(reference, settings.timezone);
  if (referenceDate !== journeyDate) {
    return buildFallback(
      settings,
      journeyDate,
      `API data is for the journey reaching ${code} on ${formatDateShort(referenceDate)}, not ${formatDateShort(journeyDate)}`,
    );
  }

  let scheduledReason = st.invalidFields.includes("actualArrival")
    ? "actualArrival was not a valid timestamp; using timetable"
    : "No live prediction (actualArrival empty); using timetable";

  if (actual) {
    if (scheduled && Math.abs(minutesBetween(actual, scheduled)) > settings.maxPlausibleDelayMinutes) {
      scheduledReason = "Predicted arrival is implausibly far from the timetable; ignored";
    } else {
      return {
        status: "LIVE",
        journeyDate,
        arrival: actual,
        wakeup: calculateWakeup(actual, settings.bufferMinutes),
        bufferMinutes: settings.bufferMinutes,
        delayMinutes: scheduled ? minutesBetween(actual, scheduled) : snapshot.delayMinutes,
        provenance: st.provenance,
        reason: null,
      };
    }
  }

  if (!scheduled) return buildFallback(settings, journeyDate, scheduledReason); // defensive

  return {
    status: "SCHEDULED",
    journeyDate,
    arrival: scheduled,
    wakeup: calculateWakeup(scheduled, settings.bufferMinutes),
    bufferMinutes: settings.bufferMinutes,
    delayMinutes: snapshot.delayMinutes,
    provenance: st.provenance,
    reason: scheduledReason,
  };
}
