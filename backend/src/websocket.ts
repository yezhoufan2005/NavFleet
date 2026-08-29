import http from "node:http";
import { WebSocketServer } from "ws";
import type { DashboardStore } from "./store";
import type { AppConfig } from "./config";
import { ACCESS_COOKIE } from "./auth/middleware";
import { verifyToken } from "./auth/tokens";
import { moduleLogger } from "./logger";
import type { SocketEvent } from "./types";

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

export interface WebSocketBridge {
  broadcast: (event: SocketEvent) => void;
  clientCount: () => number;
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
): WebSocketBridge => {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  // A `ws` server reports listener-level problems here. Without this handler the
  // EventEmitter rethrows and the process-level `uncaughtException` hook shuts
  // the backend down — see the "connection errors" tests.
  wsServer.on("error", (error) => {
    log.error({ err: error }, "WebSocket server error");
  });

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

    if (config.authEnabled) {
      const token = extractWsAccessToken(request);
      if (!token || !verifyToken(token, "access")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wsServer.handleUpgrade(request, socket, head, (client) => {
      wsServer.emit("connection", client, request);
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
        const message = JSON.parse(raw.toString("utf8"));
        if (message?.type === "ping" && client.readyState === client.OPEN) {
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

  const broadcast = (event: SocketEvent): void => {
    const message = JSON.stringify(event);
    wsServer.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    });
  };

  store.on("event", broadcast);

  return {
    broadcast,
    clientCount: () => wsServer.clients.size,
    close: () => {
      wsServer.clients.forEach((client) => {
        try {
          client.close();
        } catch {
          // Ignore client close errors during shutdown.
        }
      });
    },
  };
};
