import http from "node:http";
import mqtt from "mqtt";
import express from "express";
import pino from "pino";
import { WebSocketServer } from "ws";
import { config, runtimePaths } from "./config";
import { ConfigRegistry } from "./configRegistry";
import { Persistence } from "./persistence";
import { DashboardStore } from "./store";
import { SocketEvent } from "./types";

const logger = pino({ name: "fleet-backend" });
const app = express();
const persistence = new Persistence();
const configRegistry = new ConfigRegistry();
const store = new DashboardStore(persistence, configRegistry);

app.use(express.json({ limit: "2mb" }));
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
  })
);

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "fleet-backend",
    now: new Date().toISOString(),
  });
});

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
    const { deviceId } = request.params;
    const history = await store.getHistory(
      deviceId,
      typeof request.query.from === "string" ? request.query.from : undefined,
      typeof request.query.to === "string" ? request.query.to : undefined,
      typeof request.query.limit === "string" ? Number(request.query.limit) : undefined
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
    const items = await store.getAlerts({
      severity: typeof request.query.severity === "string" ? request.query.severity : undefined,
      deviceId: typeof request.query.deviceId === "string" ? request.query.deviceId : undefined,
      status: typeof request.query.status === "string" ? request.query.status : undefined,
    });
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

app.post("/api/debug/ingest", async (request, response, next) => {
  try {
    const snapshot = await store.applyPayload(request.body, "debug-api");
    response.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  logger.error({ err: error }, "Unhandled request error");
  response.status(500).json({
    error: "internal_error",
    message: error instanceof Error ? error.message : "Unknown error",
  });
});

const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/ws")) {
    socket.destroy();
    return;
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
    } satisfies SocketEvent)
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

const extractStatusDeviceId = (topic: string): string => {
  const match = topic.match(/^\/fleet\/([^/]+)\/status$/);
  return match?.[1] || "";
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
    client.subscribe(["/fleet/+/vehicle_info", "/fleet/+/status"], (error) => {
      if (error) {
        logger.error({ err: error }, "Failed to subscribe MQTT topics");
      }
    });
  });

  client.on("message", async (topic, payloadBuffer) => {
    const payloadText = payloadBuffer.toString("utf8");
    try {
      const statusDeviceId = extractStatusDeviceId(topic);
      if (statusDeviceId) {
        const deviceId = statusDeviceId;
        await store.applyStatus(deviceId, safeJsonParse(payloadText));
        return;
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
