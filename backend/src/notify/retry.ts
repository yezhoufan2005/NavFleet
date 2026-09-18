/**
 * A single-purpose retry+timeout wrapper for outbound sends (Phase 16D-1).
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

const summarize = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * POST `body` (as JSON) to `url`, with per-attempt timeout and bounded retry. Never throws —
 * every failure mode is folded into the returned {@link AttemptOutcome}, because the dispatcher
 * runs fire-and-forget and an escaping rejection would land on `unhandledRejection`.
 */
export const postWithRetry = async (
  url: string,
  body: unknown,
  options: RetryOptions,
): Promise<AttemptOutcome> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts);

  let attempts = 0;
  let httpStatus: number | null = null;
  let error: string | null = null;
  let latencyMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      latencyMs = Date.now() - startedAt;
      httpStatus = response.status;
      if (response.ok) {
        return { ok: true, httpStatus, attempts, latencyMs, error: null };
      }
      error = `HTTP ${response.status}`;
      if (!isRetryableStatus(response.status)) {
        return { ok: false, httpStatus, attempts, latencyMs, error };
      }
    } catch (thrown) {
      latencyMs = Date.now() - startedAt;
      httpStatus = null;
      error = summarize(thrown);
    }

    // Linear backoff between attempts; none after the last.
    if (attempt < maxAttempts) {
      await sleep(attempt * 200);
    }
  }

  return { ok: false, httpStatus, attempts, latencyMs, error };
};
