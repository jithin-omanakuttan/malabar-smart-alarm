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
  ntfyMessageId?: string | null;
}

export interface RunStore {
  /** Statuses already successfully sent by scheduled (non-manual) runs. */
  sentStatuses(trainNumber: string, journeyDate: string): Promise<Set<string>>;
  record(run: RunRecord): Promise<void>;
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
      ntfy_message_id: run.ntfyMessageId ?? null,
    };
    await this.#call(
      this.#baseUrl,
      { method: "POST", headers: { ...this.#headers(), Prefer: "return=minimal" }, body: JSON.stringify(row) },
      "run-log insert",
    );
  }
}
