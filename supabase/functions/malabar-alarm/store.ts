/**
 * Run log in Postgres (table public.alarm_runs), accessed through the
 * project's REST API with the service key that Supabase injects into every
 * Edge Function. Used for duplicate protection and as an audit trail.
 *
 * Every run reads and writes this table, which is also real database
 * activity for the Free plan's inactivity check.
 */

import type { AlarmResult } from "./alarm.ts";
import { fetchWithTimeout, type FetchFn, HttpFailure } from "./http.ts";

export class StoreError extends Error {
  override name = "StoreError";
}

export type Outcome = "sent" | "skipped" | "delivery_failed" | "dry_run";

export interface RunRecord {
  outcome: Outcome;
  manual: boolean;
  trainNumber: string;
  result: AlarmResult;
  detail: string;
  messageId?: string | null;
}

export interface RunStore {
  /** Statuses already successfully sent by scheduled (non-manual) runs. */
  sentStatuses(trainNumber: string, journeyDate: string): Promise<Set<string>>;
  record(run: RunRecord): Promise<void>;
  /** Most recent successfully sent run for a journey date (manual runs included), or null. */
  latestSent(trainNumber: string, journeyDate: string): Promise<LatestSent | null>;
}

export interface LatestSent {
  status: string;
  wakeup: string;
  arrival: string;
  manual: boolean;
  createdAt: string;
}

export class PostgrestStore implements RunStore {
  readonly #baseUrl: string;
  readonly #key: string;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;

  constructor(supabaseUrl: string, serviceKey: string, fetchFn: FetchFn = fetch, timeoutMs = 8_000) {
    if (!supabaseUrl || !serviceKey) throw new StoreError("SUPABASE_URL / service key not available");
    this.#baseUrl = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/alarm_runs`;
    this.#key = serviceKey;
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { apikey: this.#key, "Content-Type": "application/json" };
    // Legacy JWT service_role keys also go in Authorization; new sb_secret_ keys must not.
    if (!this.#key.startsWith("sb_")) headers.Authorization = `Bearer ${this.#key}`;
    return headers;
  }

  async #call(url: string, init: RequestInit, label: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.#fetch, url, init, this.#timeoutMs, label);
    } catch (err) {
      throw new StoreError(err instanceof HttpFailure ? err.message : `${label} failed`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StoreError(`${label} failed (HTTP ${response.status})`);
    }
    return response;
  }

  async sentStatuses(trainNumber: string, journeyDate: string): Promise<Set<string>> {
    const params = new URLSearchParams({
      select: "status",
      train_number: `eq.${trainNumber}`,
      journey_date: `eq.${journeyDate}`,
      outcome: "eq.sent",
      manual: "is.false",
    });
    const response = await this.#call(`${this.#baseUrl}?${params}`, { method: "GET", headers: this.#headers() }, "run-log lookup");
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new StoreError("run-log lookup returned invalid JSON");
    }
    if (!Array.isArray(rows)) throw new StoreError("run-log lookup returned an unexpected structure");
    return new Set(rows.map((r) => String((r as Record<string, unknown>).status)));
  }

  async latestSent(trainNumber: string, journeyDate: string): Promise<LatestSent | null> {
    const params = new URLSearchParams({
      select: "status,wakeup,arrival,manual,created_at",
      train_number: `eq.${trainNumber}`,
      journey_date: `eq.${journeyDate}`,
      outcome: "eq.sent",
      order: "created_at.desc",
      limit: "1",
    });
    const response = await this.#call(`${this.#baseUrl}?${params}`, { method: "GET", headers: this.#headers() }, "latest lookup");
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new StoreError("latest lookup returned invalid JSON");
    }
    if (!Array.isArray(rows)) throw new StoreError("latest lookup returned an unexpected structure");
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      status: String(r.status),
      wakeup: String(r.wakeup),
      arrival: String(r.arrival),
      manual: r.manual === true,
      createdAt: String(r.created_at),
    };
  }

  async record(run: RunRecord): Promise<void> {
    const r = run.result;
    const row = {
      journey_date: r.journeyDate,
      train_number: run.trainNumber,
      status: r.status,
      outcome: run.outcome,
      manual: run.manual,
      arrival: r.arrival.toISOString(),
      wakeup: r.wakeup.toISOString(),
      delay_minutes: r.delayMinutes,
      reason: r.reason,
      detail: run.detail,
      message_id: run.messageId ?? null,
    };
    await this.#call(
      this.#baseUrl,
      { method: "POST", headers: { ...this.#headers(), Prefer: "return=minimal" }, body: JSON.stringify(row) },
      "run-log insert",
    );
  }
}
