import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  backoffDelay,
  createRealtimeLink,
  BACKOFF_MAX_MS,
  HEARTBEAT_MS,
  OPEN_TIMEOUT_MS,
  PONG_GRACE_MS,
} from "@/lib/realtimeLink";
import type { RealtimeLinkStatus, RealtimeSocket } from "@/lib/realtimeLink";

/**
 * The link's whole job is surviving failure, and every one of its failure paths is
 * on a timer — which is why it is a module of its own rather than 130 lines inside a
 * Pinia store, where none of this was ever tested.
 */
class FakeSocket implements RealtimeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls = 0;

  private listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was created");
    return socket;
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  /** Test drivers. */
  acceptConnection(): void {
    this.readyState = 1;
    this.emit("open");
  }

  deliver(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  deliverRaw(data: unknown): void {
    this.emit("message", { data });
  }

  dropFromServer(code?: number): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  private emit(
    type: string,
    event: { data?: unknown; code?: number } = {},
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let statuses: RealtimeLinkStatus[];
let messages: unknown[];

const makeLink = () => {
  statuses = [];
  messages = [];
  return createRealtimeLink({
    url: () => "ws://test/ws",
    createSocket: (url) => new FakeSocket(url),
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// Jitter off: these cases pin the backoff schedule itself, so `Math.random` sits at the midpoint
// (factor 1.0). The jitter range has its own case below.
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("connecting", () => {
  it("reports connecting, then open", () => {
    const link = makeLink();
    link.connect();

    expect(FakeSocket.last.url).toBe("ws://test/ws");
    expect(statuses).toEqual(["connecting"]);

    FakeSocket.last.acceptConnection();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("does not open a second socket while one is live", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    link.connect();

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("distinguishes a first attempt from a reconnect", () => {
    // "We are connecting" and "we had this and lost it" need different words on
    // screen; collapsing them makes a blip look like a cold start.
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    FakeSocket.last.dropFromServer();
    vi.advanceTimersByTime(backoffDelay(0));

    expect(statuses).toEqual([
      "connecting",
      "open",
      "reconnecting",
      "reconnecting",
    ]);
  });
});

describe("messages", () => {
  it("hands decoded frames to the consumer", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    FakeSocket.last.deliver({ type: "fleet.delta", payload: { device: {} } });

    expect(messages).toEqual([
      { type: "fleet.delta", payload: { device: {} } },
    ]);
  });

  it("swallows a frame that is not JSON rather than tearing down the link", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    FakeSocket.last.deliverRaw("<html>gateway error</html>");

    expect(messages).toEqual([]);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("keeps a pong to itself", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    FakeSocket.last.deliver({ type: "pong", payload: null });

    expect(messages).toEqual([]);
  });
});

describe("heartbeat", () => {
  it("pings on the interval and survives when the pong arrives", () => {
    const link = makeLink();
    link.connect();
    const socket = FakeSocket.last;
    socket.acceptConnection();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.sent).toEqual([JSON.stringify({ type: "ping" })]);

    socket.deliver({ type: "pong" });
    vi.advanceTimersByTime(PONG_GRACE_MS);
    expect(socket.closeCalls).toBe(0);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("closes a socket that stops answering, which is what starts the reconnect", () => {
    // The nasty case: the network black-holes the connection, so the socket stays
    // at OPEN and no `close` ever fires. Without the app-level ping the console
    // would show a healthy link forever. Browsers cannot see protocol ping frames,
    // which is why the backend answers `{type:"ping"}` explicitly.
    const link = makeLink();
    link.connect();
    const socket = FakeSocket.last;
    socket.acceptConnection();

    vi.advanceTimersByTime(HEARTBEAT_MS + PONG_GRACE_MS);

    expect(socket.closeCalls).toBe(1);
    expect(statuses.at(-1)).toBe("reconnecting");
  });
});

describe("the connect that never completes", () => {
  it("gives up on a socket stuck at CONNECTING and keeps the chain moving", () => {
    // FIXED: v1.0.0 had no open timeout and started its heartbeat only on `open`,
    // so a hung connect fired no `close`, armed no pong timer and advanced no
    // backoff. One of these ended automatic recovery for the rest of the session.
    const link = makeLink();
    link.connect();
    const stuck = FakeSocket.last;

    vi.advanceTimersByTime(OPEN_TIMEOUT_MS);
    expect(stuck.closeCalls).toBe(1);
    expect(statuses.at(-1)).toBe("reconnecting");

    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("does not close a socket that opened in time", () => {
    const link = makeLink();
    link.connect();
    const socket = FakeSocket.last;
    socket.acceptConnection();

    vi.advanceTimersByTime(OPEN_TIMEOUT_MS);
    expect(socket.closeCalls).toBe(0);
  });
});

describe("backoff", () => {
  it("doubles from one second and stops at the cap", () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(4)).toBe(16_000);
    expect(backoffDelay(99)).toBe(BACKOFF_MAX_MS);
    // ±20% jitter around the step, so consoles that lost the backend together spread out.
    expect(backoffDelay(4, () => 0)).toBe(12_800);
    expect(backoffDelay(4, () => 1)).toBe(19_200);
  });

  it("waits longer after each failed attempt", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.dropFromServer();

    // Not yet: the first retry is a second away.
    vi.advanceTimersByTime(backoffDelay(0) - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.last.dropFromServer();
    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(2); // one second is no longer enough
    vi.advanceTimersByTime(backoffDelay(1) - backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("starts over from one second once a connection succeeds", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.dropFromServer();
    vi.advanceTimersByTime(backoffDelay(0));
    FakeSocket.last.acceptConnection();
    FakeSocket.last.dropFromServer();

    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("treats a constructor that throws as a failed attempt, not the end of it", () => {
    statuses = [];
    let attempts = 0;
    const link = createRealtimeLink({
      url: () => "ws://test/ws",
      createSocket: (url) => {
        attempts += 1;
        if (attempts === 1) throw new Error("blocked scheme");
        return new FakeSocket(url);
      },
      onMessage: () => undefined,
      onStatus: (status) => statuses.push(status),
    });

    link.connect();
    expect(statuses).toEqual(["reconnecting"]);

    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("disconnect", () => {
  it("closes the socket and schedules nothing after it", () => {
    const link = makeLink();
    link.connect();
    const socket = FakeSocket.last;
    socket.acceptConnection();

    link.disconnect();
    expect(socket.closeCalls).toBe(1);
    expect(statuses.at(-1)).toBe("idle");

    vi.advanceTimersByTime(BACKOFF_MAX_MS * 4);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("cancels a reconnect that was already pending", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.dropFromServer();

    link.disconnect();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 4);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("stops the heartbeat, so a closed link cannot keep pinging", () => {
    const link = makeLink();
    link.connect();
    const socket = FakeSocket.last;
    socket.acceptConnection();
    link.disconnect();

    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(socket.sent).toEqual([]);
  });

  it("can be reconnected afterwards, reporting a first attempt again", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.last.acceptConnection();
    link.disconnect();

    link.connect();
    expect(statuses.at(-1)).toBe("connecting");
  });
});

describe("session-invalid close and retryNow", () => {
  it("reports a 4401 close to the session layer, and still schedules the reconnect", () => {
    const onSessionInvalid = vi.fn();
    const link = createRealtimeLink({
      url: () => "ws://test/ws",
      createSocket: (url) => new FakeSocket(url),
      onMessage: () => undefined,
      onStatus: () => undefined,
      onSessionInvalid,
    });
    link.connect();
    FakeSocket.instances[0]!.acceptConnection();

    FakeSocket.instances[0]!.dropFromServer(4401);
    expect(onSessionInvalid).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("does not treat an ordinary drop as an invalid session", () => {
    const onSessionInvalid = vi.fn();
    const link = createRealtimeLink({
      url: () => "ws://test/ws",
      createSocket: (url) => new FakeSocket(url),
      onMessage: () => undefined,
      onStatus: () => undefined,
      onSessionInvalid,
    });
    link.connect();
    FakeSocket.instances[0]!.acceptConnection();
    FakeSocket.instances[0]!.dropFromServer();
    expect(onSessionInvalid).not.toHaveBeenCalled();
  });

  it("retryNow skips the remaining backoff", () => {
    const link = makeLink();
    link.connect();
    FakeSocket.instances[0]!.acceptConnection();
    FakeSocket.instances[0]!.dropFromServer();
    expect(FakeSocket.instances).toHaveLength(1);

    link.retryNow();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
