import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData } from "ws";
import type { DashboardStore } from "./store";
import type { AppConfig } from "./config";
import { ACCESS_COOKIE, type SessionCheck, type UserLookup } from "./auth/middleware";
import { verifyToken } from "./auth/tokens";
import { moduleLogger } from "./logger";
import type { SocketEvent } from "./types";

/**
 * A client frame as text.
 *
 * `raw.toString("utf8")` was the whole implementation, and `ws` types `RawData` as
 * `Buffer | ArrayBuffer | Buffer[]`. On the array arm that call reaches
 * `Array.prototype.toString`, which ignores the encoding argument and joins with commas —
 * so the parse below would fail on a frame that is in fact valid JSON. Not reachable with
 * this server's settings (the `Buffer[]` arm needs `binaryType: "fragments"`, and the
 * default is `"nodebuffer"`), which is exactly why nothing caught it: the defect is one
 * option away, and `no-base-to-string` (P0-f 第 3 批) is what pointed at it.
 */
export const rawToText = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const log = moduleLogger("websocket");

interface LiveSocket {
  isAlive: boolean;
}

/**
 * Cap on an inbound frame, in bytes.
 *
 * Not configurable on purpose: the inbound protocol is exactly one message shape
 * (`{"type":"ping"}`, see the app-level heartbeat below), so no deployment has a
 * reason to tune this, and 64 KiB already leaves four orders of magnitude of
 * headroom. It is set explicitly because `ws` defaults to 100 MiB, which lets a
 * single client make the server allocate that much per connection.
 */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * A client is "slow" when its outbound buffer has grown past this at broadcast
 * time (Phase 18). `ws` queues `send()` in memory when the socket cannot drain
 * fast enough, so a stuck consumer shows up here before it shows up as an OOM.
 * This drives `navfleet_ws_broadcast_slow_total` — an observability signal only;
 * the frame is still sent (the client recovers via the next snapshot/reconnect).
 * 1 MiB is ~hundreds of queued deltas: comfortably above a momentary blip, well
 * below the per-connection memory that would matter on a single-host deployment.
 */
export const WS_SLOW_CLIENT_BYTES = 1024 * 1024;

export interface WebSocketBridge {
  broadcast: (event: SocketEvent) => void;
  clientCount: () => number;
  /** Times a broadcast met a client whose send buffer was over the slow threshold. */
  slowBroadcastCount: () => number;
  close: () => void;
}

/**
 * Read the access token from the handshake `Cookie` header.
 *
 * Cookie only, deliberately: a `?access_token=` fallback used to be accepted,
 * and a token in a URL leaks — into nginx access logs, into `Referer`, into
 * browser history and into any proxy in between. The frontend has always
 * connected with the httpOnly cookie (stores/fleet.ts builds a bare `/ws` URL),
 * so nothing depends on the query form.
 */
const extractWsAccessToken = (request: http.IncomingMessage): string => {
  const cookieHeader = request.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE && rest.length) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
};

/**
 * Wire the `/ws` WebSocket endpoint onto an existing HTTP server: authenticated
 * upgrade, snapshot-on-connect, app-level + protocol heartbeats, and fan-out of
 * store change events. Returns handles for broadcasting and shutdown.
 */
export const createWebSocketBridge = (
  server: http.Server,
  store: DashboardStore,
  config: AppConfig,
  lookupUser: UserLookup,
  isSessionActive?: SessionCheck,
): WebSocketBridge => {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  // A `ws` server reports listener-level problems here. Without this handler the
  // EventEmitter rethrows and the process-level `uncaughtException` hook shuts
  // the backend down — see the "connection errors" tests.
  wsServer.on("error", (error) => {
    log.error({ err: error }, "WebSocket server error");
  });

  const rejectUpgrade = (socket: Duplex): void => {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  };

  server.on("upgrade", (request, socket, head) => {
    // The handshake socket is raw and pre-`ws`, so nothing else would be
    // listening if the peer vanished between the request and our reply below.
    socket.on("error", (error) => {
      log.warn({ err: error }, "WebSocket handshake socket error");
      socket.destroy();
    });

    const url = new URL(request.url || "", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const finishUpgrade = (): void => {
      wsServer.handleUpgrade(request, socket, head, (client) => {
        wsServer.emit("connection", client, request);
      });
    };

    if (!config.authEnabled) {
      finishUpgrade();
      return;
    }

    const token = extractWsAccessToken(request);
    const claims = token ? verifyToken(token, "access") : null;
    if (!claims) {
      rejectUpgrade(socket);
      return;
    }
    // Same per-request check the REST middleware makes, once at handshake: a socket lives for
    // hours, so a token that was valid at connect but belongs to a since-disabled account or a
    // bumped tokenVersion must not open one. (An already-open socket is closed on shutdown; a
    // mid-session disable is bounded by that, not by this check.)
    lookupUser(claims.sub)
      .then(async (user) => {
        if (!user || !user.enabled || user.tokenVersion !== claims.ver) {
          rejectUpgrade(socket);
          return;
        }
        // Per-session revocation (Phase 15E), checked once at handshake like the other gates:
        // a socket that would live for hours must not open on a token whose session has been
        // revoked. Only when the token names a session and a checker is wired.
        if (claims.sid && isSessionActive && !(await isSessionActive(claims.sub, claims.sid))) {
          rejectUpgrade(socket);
          return;
        }
        finishUpgrade();
      })
      .catch((error) => {
        log.warn({ err: error }, "WebSocket upgrade user lookup failed");
        rejectUpgrade(socket);
      });
  });

  wsServer.on("connection", (client) => {
    // Per-connection faults — a reset peer, a frame that violates the protocol,
    // a payload over the cap — must stay contained to that one client. `ws`
    // closes the socket itself after emitting; terminating is belt-and-braces
    // for the case where it is already half-open.
    client.on("error", (error) => {
      log.warn({ err: error }, "WebSocket client error; dropping that connection");
      client.terminate();
    });
    (client as unknown as LiveSocket).isAlive = true;
    client.on("pong", () => {
      (client as unknown as LiveSocket).isAlive = true;
    });
    client.on("message", (raw) => {
      // App-level heartbeat: browsers cannot observe protocol ping/pong frames,
      // so the client sends {type:"ping"} and expects {type:"pong"}.
      try {
        const message: unknown = JSON.parse(rawToText(raw));
        if (isRecord(message) && message.type === "ping" && client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: "pong", payload: null } satisfies SocketEvent));
        }
      } catch {
        // Ignore non-JSON client messages.
      }
    });
    client.send(
      JSON.stringify({
        type: "fleet.snapshot",
        payload: store.snapshot(),
      } satisfies SocketEvent),
    );
  });

  // Server-side heartbeat: terminate connections that stop answering protocol
  // pings so dead sockets don't accumulate.
  const heartbeat = setInterval(() => {
    wsServer.clients.forEach((client) => {
      const live = client as unknown as LiveSocket;
      if (!live.isAlive) {
        client.terminate();
        return;
      }
      live.isAlive = false;
      try {
        client.ping();
      } catch {
        // ignore
      }
    });
  }, 30_000);
  heartbeat.unref();
  wsServer.on("close", () => clearInterval(heartbeat));

  let slowBroadcasts = 0;
  const broadcast = (event: SocketEvent): void => {
    const message = JSON.stringify(event);
    wsServer.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        if (client.bufferedAmount > WS_SLOW_CLIENT_BYTES) {
          slowBroadcasts += 1;
        }
        client.send(message);
      }
    });
  };

  store.on("event", broadcast);

  return {
    broadcast,
    clientCount: () => wsServer.clients.size,
    slowBroadcastCount: () => slowBroadcasts,
    close: () => {
      wsServer.clients.forEach((client) => {
        try {
          // 1001 "going away" rather than a bare close: the browser client treats an
          // unexplained drop as a fault and starts its reconnect backoff, while 1001 says
          // "the server is shutting down", which is a different thing to report to whoever
          // is on shift.
          client.close(1001, "server shutting down");
        } catch {
          // Ignore client close errors during shutdown.
        }
      });
    },
  };
};
