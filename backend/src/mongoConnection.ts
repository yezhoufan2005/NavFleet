/**
 * MongoDB connectivity supervision.
 *
 * Two jobs, both of which used to be missing from `Persistence`:
 *  - track *real* connectivity from the driver's topology events, so health and
 *    metrics stop reporting "connected" after the pool drops;
 *  - keep retrying a failed connection with bounded exponential backoff, so a
 *    MongoDB that appears a minute after startup is picked up instead of the
 *    process staying on the in-memory fallback forever.
 *
 * The module intentionally imports nothing from `mongodb`: the connection is
 * reached only through the small `MongoSession` seam and timers only through
 * `RetryScheduler`, which makes the state machine and the backoff schedule
 * unit-testable without a live server (see `test/mongo-connection.test.ts`).
 * `Persistence` supplies the real adapter.
 */

/** Topology events that mean "the server is reachable". */
export const MONGO_UP_EVENTS = ["serverHeartbeatSucceeded"] as const;

/** Topology events that mean "the server is not reachable (any more)". */
export const MONGO_DOWN_EVENTS = [
  "serverHeartbeatFailed",
  "serverClosed",
  "topologyClosed",
] as const;

export type MongoTopologyEvent =
  (typeof MONGO_UP_EVENTS)[number] | (typeof MONGO_DOWN_EVENTS)[number];

/** A live connection as seen by the supervisor (a `MongoClient` in production). */
export interface MongoSession {
  /** Subscribe to a topology event on the underlying client. */
  onEvent(event: MongoTopologyEvent, listener: () => void): void;
  /** Tear the connection down (shutdown, or a topology that closed on us). */
  close(): Promise<void>;
}

/** Minimal logger surface used here; a pino logger satisfies it. */
export interface SupervisorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
}

/** Start at 2s, double, cap at 30s — retried indefinitely until cancelled. */
export const DEFAULT_MONGO_BACKOFF: BackoffOptions = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 2,
};

/**
 * Delay before retry number `attempt` (1-based): `initialMs * factor^(attempt-1)`,
 * clamped to `[initialMs, maxMs]`. Deterministic (no jitter): this is a
 * single-instance deployment, so there is no herd to spread out.
 */
export const backoffDelayMs = (
  attempt: number,
  options: BackoffOptions = DEFAULT_MONGO_BACKOFF,
): number => {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = options.initialMs * Math.pow(options.factor, exponent);
  return Math.min(Math.max(options.initialMs, raw), options.maxMs);
};

/** Cancels a scheduled retry. */
export type CancelRetry = () => void;

/** Schedules `run` after `delayMs`; the returned function cancels it. */
export type RetryScheduler = (run: () => void, delayMs: number) => CancelRetry;

/** Default scheduler: an `unref()`d timer, so retries never hold the process open. */
export const unrefTimerScheduler: RetryScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};

export interface MongoConnectionSupervisorOptions {
  /**
   * Opens a fresh connection and resolves with its session. Must reject (and
   * clean up after itself) when the server is unreachable.
   */
  open: () => Promise<MongoSession>;
  logger: SupervisorLogger;
  /** Extra fields attached to every log line (e.g. db name, redacted URI). */
  logContext?: object;
  backoff?: BackoffOptions;
  schedule?: RetryScheduler;
}

/**
 * Owns the connect/retry lifecycle and the authoritative connectivity flag.
 *
 * State transitions:
 *  - `open()` resolves            → connected, listeners bound
 *  - `open()` rejects             → disconnected, retry scheduled (backoff)
 *  - up event                     → connected (driver recovered the pool itself)
 *  - down event                   → disconnected
 *  - `topologyClosed`             → disconnected, dead session dropped, reopen scheduled
 *  - `stop()`                     → disconnected, pending retry cancelled, loop ends
 */
export class MongoConnectionSupervisor {
  private readonly open: () => Promise<MongoSession>;
  private readonly logger: SupervisorLogger;
  private readonly logContext: object;
  private readonly backoff: BackoffOptions;
  private readonly schedule: RetryScheduler;

  private session: MongoSession | null = null;
  private connected = false;
  private cancelRetry: CancelRetry | null = null;
  private opening = false;
  private stopped = false;
  private everConnected = false;
  private failedAttempts = 0;

  constructor(options: MongoConnectionSupervisorOptions) {
    this.open = options.open;
    this.logger = options.logger;
    this.logContext = options.logContext ?? {};
    this.backoff = options.backoff ?? DEFAULT_MONGO_BACKOFF;
    this.schedule = options.schedule ?? unrefTimerScheduler;
  }

  /** True only while a session exists and the topology last reported healthy. */
  isConnected(): boolean {
    return this.session !== null && this.connected;
  }

  /**
   * Try to connect once; on failure the retry loop takes over in the background
   * so the caller (startup) is never blocked on an unavailable MongoDB.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.attemptOpen();
  }

  /** Cancel any pending retry, stop the loop, and close a live session. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearPendingRetry();
    const session = this.session;
    this.session = null;
    this.connected = false;
    if (!session) {
      return;
    }
    try {
      await session.close();
    } catch (error) {
      this.logger.warn(
        { ...this.logContext, err: error },
        "Failed to close MongoDB client cleanly",
      );
    }
  }

  private async attemptOpen(): Promise<void> {
    if (this.stopped || this.session || this.opening) {
      return;
    }
    this.opening = true;
    try {
      const session = await this.open();
      if (this.stopped) {
        // Shutdown raced with a slow connect: drop what we just opened.
        await session.close().catch(() => undefined);
        return;
      }
      const reconnected = this.everConnected;
      this.session = session;
      this.connected = true;
      this.everConnected = true;
      this.failedAttempts = 0;
      this.bindEvents(session);
      this.logger.info(
        { ...this.logContext },
        reconnected ? "MongoDB reconnected" : "MongoDB connected",
      );
    } catch (error) {
      this.connected = false;
      this.session = null;
      this.failedAttempts += 1;
      this.scheduleReopen({ err: error });
    } finally {
      this.opening = false;
    }
  }

  private bindEvents(session: MongoSession): void {
    for (const event of MONGO_UP_EVENTS) {
      session.onEvent(event, () => {
        this.handleUpEvent(session, event);
      });
    }
    for (const event of MONGO_DOWN_EVENTS) {
      session.onEvent(event, () => {
        this.handleDownEvent(session, event);
      });
    }
  }

  private handleUpEvent(session: MongoSession, event: MongoTopologyEvent): void {
    // Ignore events from an abandoned session, and stay quiet on the steady
    // stream of successful heartbeats once already up.
    if (this.stopped || this.session !== session || this.connected) {
      return;
    }
    this.connected = true;
    this.logger.info({ ...this.logContext, event }, "MongoDB connectivity restored");
  }

  private handleDownEvent(session: MongoSession, event: MongoTopologyEvent): void {
    if (this.stopped || this.session !== session) {
      return;
    }
    if (this.connected) {
      this.connected = false;
      this.logger.warn(
        { ...this.logContext, event },
        "MongoDB connectivity lost; in-memory fallback active until it returns",
      );
    }
    if (event === "topologyClosed") {
      // The driver will not revive a closed topology, so replace the client.
      this.recycleSession(session, event);
    }
  }

  private recycleSession(session: MongoSession, event: MongoTopologyEvent): void {
    this.session = null;
    this.connected = false;
    this.failedAttempts += 1;
    void session.close().catch(() => undefined);
    this.scheduleReopen({ event });
  }

  private scheduleReopen(context: { err?: unknown; event?: string }): void {
    if (this.stopped || this.cancelRetry) {
      return;
    }
    const attempt = Math.max(1, this.failedAttempts);
    const delayMs = backoffDelayMs(attempt, this.backoff);
    this.logger.warn(
      { ...this.logContext, ...context, attempt, delayMs },
      "MongoDB unavailable; retrying with in-memory fallback active",
    );
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      void this.attemptOpen();
    }, delayMs);
  }

  private clearPendingRetry(): void {
    if (!this.cancelRetry) {
      return;
    }
    const cancel = this.cancelRetry;
    this.cancelRetry = null;
    cancel();
  }
}

/**
 * Strip credentials from a Mongo connection string so it is safe to log.
 * Falls back to the scheme only when the URI cannot be parsed.
 */
export const redactMongoUri = (uri: string): string => {
  const match = /^([a-z+]+:\/\/)(?:[^@/]*@)?([^/?]*)(.*)$/i.exec(uri.trim());
  if (!match) {
    return "<redacted>";
  }
  const [, scheme, hostPart, rest] = match;
  const path = rest.split("?")[0] ?? "";
  return `${scheme}${hostPart}${path}`;
};
