/** Small shared HTTP helpers (fetch with timeout + retry classification). */

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const USER_AGENT = "malabar-smart-alarm/2.0";

export class HttpFailure extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

/**
 * fetch() with a timeout. Network errors and timeouts become HttpFailure
 * with a generic message (no URLs, so secrets in paths never leak).
 */
export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new HttpFailure(`${label} timed out after ${timeoutMs / 1000}s`, true);
    }
    throw new HttpFailure(`${label} network error (${name})`, true);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
