/**
 * A single-purpose retry+timeout wrapper for outbound sends.
 *
 * The backend carries no HTTP client and no general retry util (the only retry logic is
 * MongoDB reconnection, which is bespoke). Rather than pull in a dependency for three
 * `fetch` POSTs, this is the smallest thing that does the job: bound each attempt with
 * `AbortSignal.timeout`, retry a *retryable* failure up to `maxAttempts` with linear backoff,
 * and hand back the last attempt's outcome either way.
 *
 * "Retryable" is deliberately narrow: a timeout or network error (the fetch threw), or a 5xx /
 * 429 response. A 4xx other than 429 means the request itself is wrong (bad URL, bad body,
 * revoked bot) — retrying only wastes time and hammers the endpoint — so it is returned at
 * once. The caller records the final outcome as one send record.
 */

export interface AttemptOutcome {
  /** True on a 2xx response. */
  ok: boolean;
  /** The HTTP status of the last attempt, or null if no response was received (network/timeout). */
  httpStatus: number | null;
  /** How many attempts were actually made (1 = succeeded or failed-unretryable first try). */
  attempts: number;
  /** Wall-clock duration of the last attempt, in milliseconds. */
  latencyMs: number;
  /** A short failure summary, or null on success. */
  error: string | null;
}

export interface RetryOptions {
  maxAttempts: number;
  timeoutMs: number;
  /** Injectable for tests; production omits it and uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable delay (ms → Promise); production omits it. Tests pass a no-op to skip real waits. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean => status >= 500 || status === 429;

/** A short, safe failure summary from a thrown value — shared by every channel's attempt body. */
export const summarize = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * One attempt's result. `done` stops the loop — either a success or an unretryable failure — and
 * its `ok` becomes the outcome's; otherwise the loop backs off and tries again. `latencyMs` is this
 * attempt's own wall-clock, so the final outcome carries the last attempt's timing.
 */
export type AttemptResult =
  | { done: true; ok: boolean; httpStatus: number | null; latencyMs: number; error: string | null }
  | { done: false; httpStatus: number | null; latencyMs: number; error: string };

export interface WithRetryOptions {
  maxAttempts: number;
  /** Injectable delay (ms → Promise); production omits it. Tests pass a no-op to skip real waits. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The retry skeleton every channel shares: run `attempt` up to `maxAttempts` times, stop as soon as
 * one reports `done`, linear-backoff between tries (none after the last), and fold the last
 * attempt's status/latency/error into one {@link AttemptOutcome}. Never throws — the attempt body
 * owns its own try/catch and reports failures as data, because the dispatcher runs fire-and-forget.
 * Only the per-attempt body (an HTTP POST, an SMTP send) differs between channels; it used to be
 * copy-pasted around this loop in `postWithRetry` and `sendEmail`.
 */
export const withRetry = async (
  attempt: (attemptNumber: number) => Promise<AttemptResult>,
  options: WithRetryOptions,
): Promise<AttemptOutcome> => {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts);

  let attempts = 0;
  let httpStatus: number | null = null;
  let latencyMs = 0;
  let error: string | null = null;

  for (let n = 1; n <= maxAttempts; n += 1) {
    attempts = n;
    const result = await attempt(n);
    httpStatus = result.httpStatus;
    latencyMs = result.latencyMs;
    error = result.error;
    if (result.done) {
      return { ok: result.ok, httpStatus, attempts, latencyMs, error };
    }
    if (n < maxAttempts) {
      await sleep(n * 200);
    }
  }

  return { ok: false, httpStatus, attempts, latencyMs, error };
};

/**
 * POST `body` (as JSON) to `url`, with per-attempt timeout and bounded retry. Never throws —
 * every failure mode is folded into the returned {@link AttemptOutcome}, because the dispatcher
 * runs fire-and-forget and an escaping rejection would land on `unhandledRejection`.
 */
export const postWithRetry = (
  url: string,
  body: unknown,
  options: RetryOptions,
): Promise<AttemptOutcome> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  return withRetry(
    async () => {
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const latencyMs = Date.now() - startedAt;
        if (response.ok) {
          return { done: true, ok: true, httpStatus: response.status, latencyMs, error: null };
        }
        const error = `HTTP ${response.status}`;
        // A 4xx other than 429 is the request's own fault (bad URL/body/revoked bot) — stop at once
        // rather than hammer the endpoint; a 5xx/429 is transient, so retry.
        return isRetryableStatus(response.status)
          ? { done: false, httpStatus: response.status, latencyMs, error }
          : { done: true, ok: false, httpStatus: response.status, latencyMs, error };
      } catch (thrown) {
        return {
          done: false,
          httpStatus: null,
          latencyMs: Date.now() - startedAt,
          error: summarize(thrown),
        };
      }
    },
    { maxAttempts: options.maxAttempts, sleep: options.sleep },
  );
};
