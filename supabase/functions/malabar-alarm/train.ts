/**
 * Validate a RailRadar live response and extract the boarding-station data.
 *
 * Only documented fields are read: success, data.train.number,
 * data.delayMinutes, data.route[] and per route item stationCode, stationName,
 * sequence, status, provenance, scheduledArrival, actualArrival,
 * scheduledDeparture, actualDeparture. No field is assumed to be present.
 */

import type { Logger } from "./log.ts";
import { zonedTimeToDate } from "./time.ts";

export class TrainDataError extends Error {
  override name = "TrainDataError";
}

export class InvalidTimestampError extends Error {
  override name = "InvalidTimestampError";
}

export interface StationReading {
  stationCode: string;
  stationName: string | null;
  sequence: number | null;
  status: string | null;
  provenance: string | null;
  scheduledArrival: Date | null;
  actualArrival: Date | null;
  scheduledDeparture: Date | null;
  actualDeparture: Date | null;
  invalidFields: string[];
}

export interface TrainSnapshot {
  trainNumber: string;
  delayMinutes: number | null;
  station: StationReading;
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parse an ISO-8601 timestamp. Returns null for null/empty values and throws
 * InvalidTimestampError for anything else that is not a valid timestamp.
 * Timestamps without an offset are taken to be in `tz`.
 */
export function parseTimestamp(value: unknown, tz: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InvalidTimestampError(`expected a string, got ${typeof value}`);
  const text = value.trim();
  if (!text) return null;
  const m = ISO_PATTERN.exec(text);
  if (!m) throw new InvalidTimestampError(`not an ISO-8601 timestamp: "${text}"`);
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] ? Number(m[6]) : 0;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 || month > 12 || check.getUTCDate() !== day || check.getUTCMonth() !== month - 1 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new InvalidTimestampError(`not a valid date/time: "${text}"`);
  }
  const offset = m[7];
  if (!offset) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return zonedTimeToDate(date, hour, minute, tz, second);
  }
  let offsetMin = 0;
  if (offset.toUpperCase() !== "Z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000);
}

function optionalStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractSnapshot(
  payload: unknown,
  expectedTrainNumber: string,
  stationCode: string,
  tz: string,
  log?: Logger,
): TrainSnapshot {
  if (!isObject(payload)) throw new TrainDataError("response is not a JSON object");
  if (payload.success !== true) throw new TrainDataError("API reported success=false or omitted 'success'");

  const data = payload.data;
  if (!isObject(data)) throw new TrainDataError("response has no 'data' object");

  const number = isObject(data.train) ? optionalStr(data.train.number) : null;
  if (number === null) throw new TrainDataError("response has no data.train.number");
  if (number !== expectedTrainNumber) {
    throw new TrainDataError(`response is for train ${number}, expected ${expectedTrainNumber}`);
  }

  const route = data.route;
  if (!Array.isArray(route) || route.length === 0) throw new TrainDataError("response has no data.route entries");

  const wanted = stationCode.trim().toUpperCase();
  const item = route.find((r) => isObject(r) && String(r.stationCode ?? "").trim().toUpperCase() === wanted);
  if (!isObject(item)) throw new TrainDataError(`station ${wanted} not found in route`);

  const invalidFields: string[] = [];
  const ts = (field: string): Date | null => {
    try {
      return parseTimestamp(item[field], tz);
    } catch (err) {
      log?.warn(`Ignoring ${wanted}.${field}: ${(err as Error).message}`);
      invalidFields.push(field);
      return null;
    }
  };

  return {
    trainNumber: number,
    delayMinutes: optionalInt(data.delayMinutes),
    station: {
      stationCode: wanted,
      stationName: optionalStr(item.stationName),
      sequence: optionalInt(item.sequence),
      status: optionalStr(item.status),
      provenance: optionalStr(item.provenance),
      scheduledArrival: ts("scheduledArrival"),
      actualArrival: ts("actualArrival"),
      scheduledDeparture: ts("scheduledDeparture"),
      actualDeparture: ts("actualDeparture"),
      invalidFields,
    },
  };
}
