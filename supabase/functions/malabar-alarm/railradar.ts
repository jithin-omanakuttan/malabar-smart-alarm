/**
 * RailRadar client. The API key only ever appears in the Authorization header
 * of the outgoing request; it is never logged or put in error messages.
 */

import { fetchWithTimeout, type FetchFn, HttpFailure, isRetryableStatus, realSleep, type SleepFn, USER_AGENT } from "./http.ts";
import type { Logger } from "./log.ts";

export class RailRadarError extends Error {
  override name = "RailRadarError";
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

export interface RailRadarOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  log?: Logger;
}

export class RailRadarClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #fetch: FetchFn;
  readonly #sleep: SleepFn;
  readonly #log?: Logger;

  constructor(apiKey: string, opts: RailRadarOptions = {}) {
    if (!apiKey) throw new RailRadarError("RAILRADAR_API_KEY is not configured");
    const baseUrl = opts.baseUrl ?? "https://api.railradar.in/v1";
    if (!/^https:\/\//i.test(baseUrl)) throw new RailRadarError("RailRadar base URL must use HTTPS");
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
    this.#retryDelayMs = opts.retryDelayMs ?? 3_000;
    this.#fetch = opts.fetchFn ?? fetch;
    this.#sleep = opts.sleep ?? realSleep;
    this.#log = opts.log;
  }

  toString(): string {
    return `RailRadarClient(${this.#baseUrl}, apiKey=***)`;
  }

  liveUrl(trainNumber: string): string {
    if (!/^\d+$/.test(trainNumber)) throw new RailRadarError("Train number must be digits only");
    return `${this.#baseUrl}/trains/${trainNumber}/live`;
  }

  async fetchLive(trainNumber: string): Promise<Record<string, unknown>> {
    const url = this.liveUrl(trainNumber);
    let last: RailRadarError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        const payload = await this.#requestOnce(url);
        this.#log?.info(`RailRadar responded on attempt ${attempt}`);
        return payload;
      } catch (err) {
        last = err instanceof RailRadarError ? err : new RailRadarError("Unexpected error contacting RailRadar", true);
        this.#log?.warn(`RailRadar attempt ${attempt}/${this.#maxAttempts} failed: ${last.message}`);
        if (!last.retryable || attempt === this.#maxAttempts) break;
        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
    throw last!;
  }

  async #requestOnce(url: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.#fetch, url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      }, this.#timeoutMs, "RailRadar request");
    } catch (err) {
      if (err instanceof HttpFailure) throw new RailRadarError(err.message, err.retryable);
      throw err;
    }

    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status;
      if (code === 401 || code === 403) throw new RailRadarError(`RailRadar rejected the API key (HTTP ${code})`);
      if (code === 404) throw new RailRadarError("RailRadar has no live data for this train (HTTP 404)");
      throw new RailRadarError(`RailRadar returned HTTP ${code}`, isRetryableStatus(code));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new RailRadarError("RailRadar returned invalid JSON");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new RailRadarError("RailRadar returned an unexpected JSON structure (not an object)");
    }
    return payload as Record<string, unknown>;
  }
}
