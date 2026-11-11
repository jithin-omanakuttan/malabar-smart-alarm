/** Shared test utilities. No network access, no real credentials. */

import { DEFAULT_SETTINGS, type Settings } from "../malabar-alarm/config.ts";
import type { FetchFn } from "../malabar-alarm/http.ts";
import type { RunRecord, RunStore } from "../malabar-alarm/store.ts";
import { zonedTimeToDate } from "../malabar-alarm/time.ts";

export const TZ = "Asia/Kolkata";
export const FAKE_API_KEY = "test-key-not-real";
export const FAKE_TOPIC = "test-topic-not-real";
export const FAKE_TRIGGER = "test-trigger-secret";

const FIXTURE_TEXT = await Deno.readTextFile(new URL("./fixtures/railradar_live_16630.json", import.meta.url));

// deno-lint-ignore no-explicit-any
export function loadFixture(): any {
  return JSON.parse(FIXTURE_TEXT);
}

// deno-lint-ignore no-explicit-any
export function cngr(payload: any): any {
  // deno-lint-ignore no-explicit-any
  return payload.data.route.find((r: any) => r.stationCode === "CNGR");
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Instant at the given IST wall-clock time. */
export function ist(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return zonedTimeToDate(date, h, mi, TZ);
}

export function utc(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Outcome = Response | Error | (() => Response) | unknown;

/**
 * A fetch replacement. `routes` maps a URL substring to a queue of outcomes:
 * a Response, an Error (thrown), or any other value (returned as JSON 200).
 */
export class FakeFetch {
  readonly calls: Call[] = [];
  constructor(readonly routes: Record<string, Outcome[]>) {}

  readonly fn: FetchFn = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const key = Object.keys(this.routes).find((k) => url.includes(k));
    if (!key) return Promise.reject(new Error(`FakeFetch: no route for ${url}`));
    const queue = this.routes[key];
    if (queue.length === 0) return Promise.reject(new Error(`FakeFetch: route ${key} exhausted`));
    const outcome = queue.shift();
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome instanceof Response) return Promise.resolve(outcome);
    if (typeof outcome === "function") return Promise.resolve((outcome as () => Response)());
    return Promise.resolve(new Response(JSON.stringify(outcome), { status: 200 }));
  };

  callsTo(fragment: string): Call[] {
    return this.calls.filter((c) => c.url.includes(fragment));
  }
}

export const status = (code: number, body = "") => new Response(body, { status: code });
export const raw = (body: string) => new Response(body, { status: 200 });
export function timeoutError(): Error {
  const e = new Error("signal timed out");
  e.name = "TimeoutError";
  return e;
}

export const noSleep = () => Promise.resolve();

export class MemoryStore implements RunStore {
  readonly records: RunRecord[] = [];
  constructor(readonly sent: Set<string> = new Set(), readonly failLookup = false) {}
  sentStatuses(): Promise<Set<string>> {
    return this.failLookup ? Promise.reject(new Error("lookup down")) : Promise.resolve(new Set(this.sent));
  }
  record(run: RunRecord): Promise<void> {
    this.records.push(run);
    return Promise.resolve();
  }
}

export const PUBLISHED = { id: "m1", event: "message" };
