import http from "node:http";
import { WebSocketServer } from "ws";
import type { DashboardStore } from "./store";
import type { AppConfig } from "./config";
import { ACCESS_COOKIE } from "./auth/middleware";
import { verifyToken } from "./auth/tokens";
import type { SocketEvent } from "./types";

interface LiveSocket {
  isAlive: boolean;
}

export interface WebSocketBridge {
  broadcast: (event: SocketEvent) => void;
  clientCount: () => number;
  close: () => void;
}

const extractWsAccessToken = (request: http.IncomingMessage): string => {
  const cookieHeader = request.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE && rest.length) {
      return decodeURIComponent(rest.join("="));
    }
  }
  const url = new URL(request.url || "", "http://localhost");
  return url.searchParams.get("access_token") || "";
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
  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
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
