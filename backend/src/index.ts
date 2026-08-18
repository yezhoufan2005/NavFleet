import http from "node:http";
import mqtt from "mqtt";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { WebSocketServer } from "ws";
import { config, runtimePaths } from "./config";
import { ConfigRegistry } from "./configRegistry";
import { Persistence } from "./persistence";
import { DashboardStore } from "./store";
import { buildTopicScheme } from "./topics";
import { alertsQuerySchema, historyQuerySchema, ingestBodySchema } from "./validation";
import { AuthService } from "./auth/service";
import { buildAuthRouter } from "./auth/routes";
import { ACCESS_COOKIE, authenticate, requireRole } from "./auth/middleware";
import { verifyToken } from "./auth/tokens";
import { SocketEvent } from "./types";
import type { ZodError } from "zod";

const logger = pino({ name: "fleet-backend" });
const topicScheme = buildTopicScheme(config.topicPattern);

const respondValidationError = (response: express.Response, error: ZodError): void => {
  response.status(400).json({
    error: "invalid_request",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
};
const app = express();
const persistence = new Persistence();
const configRegistry = new ConfigRegistry();
const store = new DashboardStore(persistence, configRegistry);
const authService = new AuthService(persistence);

app.use(helmet());
if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
}
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Public liveness endpoint (no auth).
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "fleet-backend",
    now: new Date().toISOString(),
  });
});

// Auth routes are public (login/refresh/logout); /me is guarded inside the
// router. A tight rate limit protects the credential endpoint from brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth", authLimiter, buildAuthRouter(authService));

// Everything below requires a valid session.
app.use(authenticate);

app.use(
  "/scene-maps",
  (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Expires", "0");
    next();
  },
  express.static(runtimePaths.sceneMapsPath, {
    etag: false,
    fallthrough: true,
    index: false,
    lastModified: false,
  }),
);

app.get("/api/fleet/snapshot", (_request, response) => {
  response.json({
    summary: store.buildSummary(),
    ...store.snapshot(),
  });
});

app.get("/api/formations", (_request, response) => {
  response.json({ items: store.getFormations() });
});

app.get("/api/devices/:deviceId/history", async (request, response, next) => {
  try {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const { deviceId } = request.params;
    const history = await store.getHistory(
      deviceId,
      parsed.data.from,
      parsed.data.to,
      parsed.data.limit,
    );
    response.json({
      deviceId,
      items: history,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/alerts", async (request, response, next) => {
  try {
    const parsed = alertsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const items = await store.getAlerts(parsed.data);
    response.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scenes/:sceneId", async (request, response, next) => {
  try {
    const definition = await store.getScene(request.params.sceneId);
    if (!definition) {
      response.status(404).json({ error: "scene_not_found" });
      return;
    }
    response.json(definition);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scenes/:sceneId/overlay", async (request, response, next) => {
  try {
    const overlay = await store.getSceneOverlay(request.params.sceneId);
    if (!overlay) {
      response.status(404).json({ error: "scene_overlay_not_found" });
      return;
    }
    response.json(overlay);
  } catch (error) {
    next(error);
  }
});

app.get("/api/scenes", (_request, response) => {
  response.json({ items: store.getScenes() });
});

app.post("/api/debug/ingest", requireRole("admin"), async (request, response, next) => {
  try {
    if (!config.debugIngestEnabled) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = ingestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const snapshot = await store.applyPayload(parsed.data, "debug-api");
    response.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    // Body-parser and other middleware attach a 4xx `status`/`statusCode` for
    // client errors (e.g. malformed JSON). Surface those as-is instead of 500.
    const status =
      error && typeof error === "object"
        ? ((error as { status?: number; statusCode?: number }).status ??
          (error as { statusCode?: number }).statusCode)
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      response.status(status).json({
        error: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request",
      });
      return;
    }
    logger.error({ err: error }, "Unhandled request error");
    response.status(500).json({
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  },
);

const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });

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
  client.send(
    JSON.stringify({
      type: "fleet.snapshot",
      payload: store.snapshot(),
    } satisfies SocketEvent),
  );
});

const broadcast = (event: SocketEvent): void => {
  const message = JSON.stringify(event);
  wsServer.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
};

store.on("event", broadcast);

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const connectMqtt = (): void => {
  const client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    logger.info({ url: config.mqttUrl }, "Connected to MQTT broker");
    const subscriptions = [topicScheme.telemetrySubscription, topicScheme.statusSubscription];
    client.subscribe(subscriptions, (error) => {
      if (error) {
        logger.error({ err: error, subscriptions }, "Failed to subscribe MQTT topics");
        return;
      }
      logger.info({ subscriptions }, "Subscribed to MQTT topics");
    });
  });

  client.on("message", async (topic, payloadBuffer) => {
    const payloadText = payloadBuffer.toString("utf8");
    try {
      if (topicScheme.isStatusTopic(topic)) {
        const deviceId = topicScheme.extractDeviceId(topic);
        if (deviceId) {
          await store.applyStatus(deviceId, safeJsonParse(payloadText));
          return;
        }
      }

      await store.applyPayload({ topic, payload: safeJsonParse(payloadText) }, "mqtt");
    } catch (error) {
      logger.error({ err: error, topic, payloadText }, "Failed to process MQTT message");
    }
  });

  client.on("error", (error) => {
    logger.warn({ err: error }, "MQTT client error");
  });
};

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutting down fleet backend");
  const forceExitTimer = setTimeout(() => {
    logger.warn({ signal }, "Forcing fleet backend shutdown");
    process.exit(process.exitCode || 0);
  }, 5_000);
  forceExitTimer.unref();

  try {
    await configRegistry.closeWatcher();
  } catch (error) {
    logger.warn({ err: error, signal }, "Failed to stop config watcher cleanly");
  }

  wsServer.clients.forEach((client) => {
    try {
      client.close();
    } catch {
      // Ignore client close errors during shutdown.
    }
  });

  server.close((error) => {
    clearTimeout(forceExitTimer);
    if (error) {
      logger.error({ err: error, signal }, "HTTP server shutdown failed");
      process.exit(1);
      return;
    }
    logger.info({ signal }, "Fleet backend stopped");
    process.exit(process.exitCode || 0);
  });
};

const start = async (): Promise<void> => {
  await store.initialize();
  await authService.initialize();
  try {
    await configRegistry.startWatching(async () => {
      await store.reloadConfig();
      broadcast({
        type: "fleet.snapshot",
        payload: store.snapshot(),
      });
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start config watcher");
  }
  connectMqtt();
  setInterval(() => {
    void store.evaluateOfflineDevices();
  }, 15_000).unref();

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "Fleet backend listening");
  });
};

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

void start();
