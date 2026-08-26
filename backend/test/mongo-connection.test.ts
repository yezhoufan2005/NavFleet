import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_MONGO_BACKOFF,
  MongoConnectionSupervisor,
  backoffDelayMs,
  redactMongoUri,
  unrefTimerScheduler,
  type MongoSession,
  type MongoTopologyEvent,
  type RetryScheduler,
} from "../src/mongoConnection";
import { Persistence } from "../src/persistence";

/** Fake session: records listeners so a test can fire topology events by hand. */
class FakeSession implements MongoSession {
  readonly listeners = new Map<MongoTopologyEvent, Array<() => void>>();
  closeCount = 0;

  onEvent(event: MongoTopologyEvent, listener: () => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  emit(event: MongoTopologyEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

/** Fake scheduler: captures delays and lets the test run retries on demand. */
const createFakeScheduler = () => {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  let cancelled = 0;
  const schedule: RetryScheduler = (run, delayMs) => {
    delays.push(delayMs);
    pending = run;
    return () => {
      cancelled += 1;
      pending = null;
    };
  };
  return {
    schedule,
    delays,
    get cancelled() {
      return cancelled;
    },
    get hasPending() {
      return pending !== null;
    },
    /** Fire the scheduled retry, mimicking the timer elapsing. */
    async fire(): Promise<void> {
      const run = pending;
      pending = null;
      expect(run).not.toBeNull();
      run?.();
      // Let the async attemptOpen() settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelayMs", () => {
  it("doubles from the initial delay and clamps at the cap", () => {
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    // 32s would exceed the 30s cap.
    expect(backoffDelayMs(5)).toBe(30_000);
    expect(backoffDelayMs(50)).toBe(DEFAULT_MONGO_BACKOFF.maxMs);
  });

  it("clamps non-positive attempts to the initial delay and honours custom options", () => {
    expect(backoffDelayMs(0)).toBe(2_000);
    expect(backoffDelayMs(-3)).toBe(2_000);
    expect(backoffDelayMs(3, { initialMs: 100, maxMs: 250, factor: 3 })).toBe(250);
    expect(backoffDelayMs(2, { initialMs: 100, maxMs: 250, factor: 3 })).toBe(250);
    expect(backoffDelayMs(1, { initialMs: 100, maxMs: 250, factor: 3 })).toBe(100);
  });
});

describe("redactMongoUri", () => {
  it("drops credentials and query options but keeps host and db", () => {
    expect(redactMongoUri("mongodb://alice:s3cr3t@db.internal:27017/fleet_monitor?tls=true")).toBe(
      "mongodb://db.internal:27017/fleet_monitor",
    );
    expect(redactMongoUri("mongodb+srv://alice:s3cr3t@cluster.example.net/fleet")).toBe(
      "mongodb+srv://cluster.example.net/fleet",
    );
  });

  it("passes through credential-free URIs and redacts unparseable input", () => {
    expect(redactMongoUri("mongodb://127.0.0.1:27017/fleet_monitor")).toBe(
      "mongodb://127.0.0.1:27017/fleet_monitor",
    );
    expect(redactMongoUri("not a uri")).toBe("<redacted>");
  });
});

describe("MongoConnectionSupervisor connectivity state", () => {
  it("is disconnected before start and reports connected once a session opens", async () => {
    const session = new FakeSession();
    const supervisor = new MongoConnectionSupervisor({
      open: async () => session,
      logger: silentLogger(),
    });

    expect(supervisor.isConnected()).toBe(false);
    await supervisor.start();
    expect(supervisor.isConnected()).toBe(true);
  });

  it("follows topology heartbeats down and back up without reopening the client", async () => {
    const session = new FakeSession();
    const open = vi.fn(async () => session);
    const supervisor = new MongoConnectionSupervisor({ open, logger: silentLogger() });
    await supervisor.start();

    session.emit("serverHeartbeatFailed");
    expect(supervisor.isConnected()).toBe(false);

    // The driver recovers its own pool; only the flag has to follow.
    session.emit("serverHeartbeatSucceeded");
    expect(supervisor.isConnected()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);

    session.emit("serverClosed");
    expect(supervisor.isConnected()).toBe(false);
    session.emit("serverHeartbeatSucceeded");
    expect(supervisor.isConnected()).toBe(true);
  });

  it("logs the lost transition once, not on every failed heartbeat", async () => {
    const session = new FakeSession();
    const logger = silentLogger();
    const supervisor = new MongoConnectionSupervisor({ open: async () => session, logger });
    await supervisor.start();

    session.emit("serverHeartbeatFailed");
    session.emit("serverHeartbeatFailed");
    session.emit("serverHeartbeatFailed");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    session.emit("serverHeartbeatSucceeded");
    session.emit("serverHeartbeatSucceeded");
    // One "connected" at start plus exactly one "restored".
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(supervisor.isConnected()).toBe(true);
  });
});

describe("MongoConnectionSupervisor reconnect loop", () => {
  it("retries a failed initial connect with exponential backoff until it succeeds", async () => {
    const scheduler = createFakeScheduler();
    const session = new FakeSession();
    let attempts = 0;
    const open = vi.fn(async () => {
      attempts += 1;
      if (attempts < 4) {
        throw new Error("connect ECONNREFUSED");
      }
      return session;
    });
    const supervisor = new MongoConnectionSupervisor({
      open,
      logger: silentLogger(),
      schedule: scheduler.schedule,
    });

    // start() must not throw or block on an unavailable server.
    await supervisor.start();
    expect(supervisor.isConnected()).toBe(false);

    await scheduler.fire();
    expect(supervisor.isConnected()).toBe(false);
    await scheduler.fire();
    expect(supervisor.isConnected()).toBe(false);
    await scheduler.fire();

    // Fourth attempt succeeds: the process upgrades off the in-memory fallback.
    expect(supervisor.isConnected()).toBe(true);
    expect(open).toHaveBeenCalledTimes(4);
    expect(scheduler.delays).toEqual([2_000, 4_000, 8_000]);
    expect(scheduler.hasPending).toBe(false);

    // Events from the freshly opened session are wired up.
    session.emit("serverHeartbeatFailed");
    expect(supervisor.isConnected()).toBe(false);
  });

  it("keeps retrying indefinitely, holding the delay at the cap", async () => {
    const scheduler = createFakeScheduler();
    const supervisor = new MongoConnectionSupervisor({
      open: async () => {
        throw new Error("down");
      },
      logger: silentLogger(),
      schedule: scheduler.schedule,
    });

    await supervisor.start();
    for (let i = 0; i < 6; i += 1) {
      await scheduler.fire();
    }
    expect(scheduler.delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(scheduler.hasPending).toBe(true);
    expect(supervisor.isConnected()).toBe(false);
  });

  it("replaces the client when the topology closes under it", async () => {
    const scheduler = createFakeScheduler();
    const first = new FakeSession();
    const second = new FakeSession();
    const sessions = [first, second];
    const open = vi.fn(async () => sessions.shift() as MongoSession);
    const supervisor = new MongoConnectionSupervisor({
      open,
      logger: silentLogger(),
      schedule: scheduler.schedule,
    });

    await supervisor.start();
    first.emit("topologyClosed");
    expect(supervisor.isConnected()).toBe(false);
    // The dead client is released rather than left monitoring in the background.
    expect(first.closeCount).toBe(1);
    expect(scheduler.delays).toEqual([2_000]);

    await scheduler.fire();
    expect(supervisor.isConnected()).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);

    // Stale events from the abandoned session must not flip the live state.
    first.emit("serverHeartbeatFailed");
    expect(supervisor.isConnected()).toBe(true);
    second.emit("serverHeartbeatFailed");
    expect(supervisor.isConnected()).toBe(false);
  });

  it("stop() cancels a pending retry and ends the loop", async () => {
    const scheduler = createFakeScheduler();
    const open = vi.fn(async () => {
      throw new Error("down");
    });
    const supervisor = new MongoConnectionSupervisor({
      open,
      logger: silentLogger(),
      schedule: scheduler.schedule,
    });

    await supervisor.start();
    expect(scheduler.hasPending).toBe(true);

    await supervisor.stop();
    expect(scheduler.cancelled).toBe(1);
    expect(scheduler.hasPending).toBe(false);
    expect(supervisor.isConnected()).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("stop() closes the live session and stops tracking its events", async () => {
    const session = new FakeSession();
    const supervisor = new MongoConnectionSupervisor({
      open: async () => session,
      logger: silentLogger(),
    });

    await supervisor.start();
    await supervisor.stop();
    expect(session.closeCount).toBe(1);
    expect(supervisor.isConnected()).toBe(false);

    session.emit("serverHeartbeatSucceeded");
    expect(supervisor.isConnected()).toBe(false);

    // Idempotent.
    await supervisor.stop();
    expect(session.closeCount).toBe(1);
  });

  it("discards a connection that lands after shutdown", async () => {
    const session = new FakeSession();
    let release: () => void = () => undefined;
    const supervisor = new MongoConnectionSupervisor({
      open: () =>
        new Promise<MongoSession>((resolve) => {
          release = () => resolve(session);
        }),
      logger: silentLogger(),
    });

    const starting = supervisor.start();
    await supervisor.stop();
    release();
    await starting;

    expect(supervisor.isConnected()).toBe(false);
    expect(session.closeCount).toBe(1);
  });
});

describe("unrefTimerScheduler", () => {
  it("runs the retry after the delay and cancels cleanly", () => {
    vi.useFakeTimers();
    const run = vi.fn();

    const cancel = unrefTimerScheduler(run, 2_000);
    vi.advanceTimersByTime(1_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    unrefTimerScheduler(cancelled, 2_000)();
    vi.advanceTimersByTime(10_000);
    expect(cancelled).not.toHaveBeenCalled();
    expect(cancel).toBeTypeOf("function");
  });
});

describe("Persistence connectivity reporting", () => {
  it("reports disconnected without a client and closes safely without connect()", async () => {
    const persistence = new Persistence();
    expect(persistence.isMongoConnected()).toBe(false);
    await persistence.close();
    expect(persistence.isMongoConnected()).toBe(false);
  });
});
