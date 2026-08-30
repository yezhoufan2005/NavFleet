/**
 * The resilient WebSocket link, on its own and without Vue.
 *
 * In v1.0.0 this lived inside the fleet store — about 130 lines of timers and
 * reconnect bookkeeping wrapped in a `defineStore`, with **no tests at all**. It is
 * pulled out here for one concrete reason: everything interesting about it happens
 * on a timer, and testing a timer-driven state machine through a Pinia store means
 * every test needs a store, a payload normalizer and a fake clock to say anything
 * about backoff. Framework-free, a fake socket plus `vi.useFakeTimers()` is enough,
 * and the store keeps only the part that is genuinely about fleet state.
 *
 * Three failure modes it has to survive, in increasing order of nastiness:
 *
 * 1. **A clean close** — the backend restarts. `close` fires, we back off and retry.
 * 2. **A silently dead socket** — the network black-holes the connection, so no
 *    `close` ever arrives and the socket sits at OPEN forever. The app-level
 *    ping/pong is what detects this (browsers cannot observe protocol-level ping
 *    frames, which is why the backend answers `{type:"ping"}` explicitly).
 * 3. **A connect that never completes** — a socket stuck at CONNECTING. This one is
 *    a **fix, not a port**: v1.0.0 had no open timeout, and its heartbeat began only
 *    on `open`, so a hung connect fired no `close`, armed no pong timer, and
 *    advanced no backoff. One such attempt therefore ended automatic recovery *for
 *    the rest of the session* — the console sat on "正在重连" and never tried again.
 *    A connect attempt now has a deadline like everything else here.
 */

/** The bits of `WebSocket` this module uses — so a test can pass a fake. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

/**
 * What the UI is allowed to say about the link.
 *
 * `reconnecting` is deliberately distinct from `connecting`: "we are trying for the
 * first time" and "we had it and lost it" call for different words on screen, and
 * collapsing them is how a transient blip ends up looking like a cold start.
 */
export type RealtimeLinkStatus =
  "idle" | "connecting" | "open" | "reconnecting";

export interface RealtimeLinkConfig {
  /** Called for every decoded message that is not a `pong`. */
  onMessage: (message: unknown) => void;
  /** Called on every status transition, with the number of retries so far. */
  onStatus: (status: RealtimeLinkStatus, attempt: number) => void;
  /** Overridable for tests; defaults to same-origin `/ws`. */
  url?: () => string;
  /** Overridable for tests; defaults to the global `WebSocket`. */
  createSocket?: (url: string) => RealtimeSocket;
}

export const HEARTBEAT_MS = 20_000;
export const PONG_GRACE_MS = 10_000;
/**
 * How long a connect attempt may sit at CONNECTING before we give up on it. Longer
 * than the pong grace because a first connect legitimately involves DNS, TCP and
 * TLS; short enough that the backoff chain keeps moving.
 */
export const OPEN_TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

const SOCKET_OPEN = 1;

const defaultUrl = (): string => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
};

/** `2 ** attempt` seconds, capped. Exported so a test states the schedule itself. */
export const backoffDelay = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);

export interface RealtimeLink {
  connect: () => void;
  /** Stops for good: no reconnect follows, and the attempt counter resets. */
  disconnect: () => void;
}

export const createRealtimeLink = (
  config: RealtimeLinkConfig,
): RealtimeLink => {
  const url = config.url ?? defaultUrl;
  const createSocket =
    config.createSocket ?? ((target: string) => new WebSocket(target));

  let socket: RealtimeSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  /**
   * Whether this link has ever been open. It decides `connecting` vs
   * `reconnecting`, and it must survive a reconnect — hence a flag rather than
   * `attempt > 0`, which a successful open resets.
   */
  let everOpen = false;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer !== null) clearTimeout(timer);
  };

  const stopSocketTimers = () => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    clearTimer(pongTimer);
    clearTimer(openTimer);
    heartbeatTimer = null;
    pongTimer = null;
    openTimer = null;
  };

  const closeQuietly = (target: RealtimeSocket) => {
    try {
      target.close();
    } catch {
      // A socket that refuses to close is already gone for our purposes.
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    config.onStatus("reconnecting", attempt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const startHeartbeat = (target: RealtimeSocket) => {
    heartbeatTimer = setInterval(() => {
      if (target.readyState !== SOCKET_OPEN) return;
      try {
        target.send(JSON.stringify({ type: "ping" }));
      } catch {
        // Send failed on a socket that claims to be open: leave any armed pong
        // timer in place, which is exactly the recovery path we want.
        return;
      }
      clearTimer(pongTimer);
      pongTimer = setTimeout(() => {
        // No pong inside the grace window. The socket is dead however healthy it
        // looks; closing it is what gets `close` to fire and the backoff to start.
        closeQuietly(target);
      }, PONG_GRACE_MS);
    }, HEARTBEAT_MS);
  };

  function connect(): void {
    if (socket !== null) return;
    stopped = false;

    let target: RealtimeSocket;
    try {
      target = createSocket(url());
    } catch {
      // A constructor that throws (bad URL, blocked scheme) is a failed attempt
      // like any other — it must advance the backoff, not end the chain.
      scheduleReconnect();
      return;
    }

    socket = target;
    config.onStatus(everOpen ? "reconnecting" : "connecting", attempt);

    // See the module header, failure mode 3.
    openTimer = setTimeout(() => {
      openTimer = null;
      if (target.readyState !== SOCKET_OPEN) closeQuietly(target);
    }, OPEN_TIMEOUT_MS);

    target.addEventListener("open", () => {
      clearTimer(openTimer);
      openTimer = null;
      everOpen = true;
      attempt = 0;
      config.onStatus("open", 0);
      startHeartbeat(target);
    });

    target.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // Malformed frame: nothing to do but ignore it.
      }
      if ((message as { type?: unknown } | null)?.type === "pong") {
        clearTimer(pongTimer);
        pongTimer = null;
        return;
      }
      config.onMessage(message);
    });

    const handleClose = () => {
      if (socket !== target) return; // A later socket already superseded this one.
      socket = null;
      stopSocketTimers();
      scheduleReconnect();
    };
    target.addEventListener("close", handleClose);
    // "error" is always followed by "close" on a WebSocket, so letting close drive
    // the reconnect keeps one path instead of two that must agree.
    target.addEventListener("error", () => {});
  }

  const disconnect = () => {
    stopped = true;
    stopSocketTimers();
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    if (socket !== null) {
      const target = socket;
      socket = null;
      closeQuietly(target);
    }
    attempt = 0;
    everOpen = false;
    config.onStatus("idle", 0);
  };

  return { connect, disconnect };
};
