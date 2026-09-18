import http from "node:http";
import { config } from "./config";
import { logger } from "./logger";
import { auditProductionConfig } from "./startupChecks";
import { createRuntimeState } from "./runtimeState";
import { ConfigRegistry } from "./configRegistry";
import { Persistence } from "./persistence";
import { DashboardStore } from "./store";
import { AuthService } from "./auth/service";
import { AuditService } from "./audit/service";
import { NotifyService, type AlertCreatedEvent } from "./notify/service";
import { buildTopicScheme } from "./topics";
import { createApp } from "./app";
import { createWebSocketBridge } from "./websocket";
import { connectMqtt } from "./mqtt";
import type { SocketEvent } from "./types";

// Composition root: build the dependency graph, wire HTTP + WebSocket + MQTT,
// then own the process lifecycle (startup, config hot-reload, graceful shutdown).
const state = createRuntimeState();
const persistence = new Persistence();
const configRegistry = new ConfigRegistry();
const store = new DashboardStore(persistence, configRegistry);
const authService = new AuthService(persistence);
const auditService = new AuditService(persistence);
const notifyService = new NotifyService({
  persistence,
  getNotifyConfig: () => configRegistry.getNotifyConfig(),
  resolveDevice: (deviceId) => store.getDevice(deviceId),
  maxAttempts: config.notifyMaxAttempts,
  timeoutMs: config.notifyTimeoutMs,
});
const topicScheme = buildTopicScheme(config.topicPattern);

// Outbound notifications (Phase 16D-1). A SECOND listener on the store's event bus, alongside
// the WebSocket bridge below — it taps `alert.created` (emitted once when an alert id first
// appears) and dispatches fire-and-forget. Un-awaited on purpose: `alert.created` fires inside
// the store's serial ingest queue, so awaiting a slow webhook here would stall all ingest;
// `dispatch` contains its own failures and never rejects.
store.on("event", (event: SocketEvent) => {
  if (event.type === "alert.created") {
    void notifyService.dispatch(event.payload as AlertCreatedEvent);
  }
});

let wsClientCount = (): number => 0;
const app = createApp({
  store,
  persistence,
  authService,
  auditService,
  notifyService,
  config,
  state,
  wsClientCount: () => wsClientCount(),
  collectDefaultMetrics: true,
});

const server = http.createServer(app);
const wsBridge = createWebSocketBridge(
  server,
  store,
  config,
  (username) => authService.findByUsername(username),
  (username, sessionId) => authService.isSessionActive(username, sessionId),
);
wsClientCount = wsBridge.clientCount;

let shuttingDown = false;
/**
 * Kept so shutdown can end it. `connectMqtt` has always returned the client and the
 * return value was discarded here, so SIGTERM left the subscription open: the broker
 * kept delivering into a process that was closing its database.
 */
let mqttClient: ReturnType<typeof connectMqtt> | null = null;
/** The offline sweep, so it stops firing into a store that is being drained. */
let offlineSweep: NodeJS.Timeout | null = null;

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

  // The order below is the point of this sequence: stop what is coming *in*, let what is
  // already in flight finish, then get it on disk, and only then close the connection it
  // needs. The previous order closed MongoDB first, while ingests were still running and
  // with the write-behind buffer unflushed — up to `MONGO_BUFFER_LIMIT` documents left
  // with the process.
  if (offlineSweep) {
    clearInterval(offlineSweep);
    offlineSweep = null;
  }

  if (mqttClient) {
    try {
      await mqttClient.endAsync(false);
    } catch (error) {
      logger.warn({ err: error, signal }, "Failed to end the MQTT client cleanly");
    }
    mqttClient = null;
  }

  try {
    await configRegistry.closeWatcher();
  } catch (error) {
    logger.warn({ err: error, signal }, "Failed to stop config watcher cleanly");
  }

  try {
    await store.drain();
  } catch (error) {
    logger.warn({ err: error, signal }, "Failed to drain in-flight ingests");
  }

  try {
    await persistence.flushTelemetry();
    const { pending, dropped } = persistence.telemetryBufferStats();
    if (pending || dropped) {
      logger.warn({ signal, pending, dropped }, "Telemetry left unwritten at shutdown");
    }
  } catch (error) {
    logger.warn({ err: error, signal }, "Failed to flush buffered telemetry");
  }

  try {
    // Also cancels any pending MongoDB reconnect attempt.
    await persistence.close();
  } catch (error) {
    logger.warn({ err: error, signal }, "Failed to close MongoDB cleanly");
  }

  wsBridge.close();

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
  // Refuse an unsafe production configuration before anything starts listening.
  const issues = auditProductionConfig(config);
  for (const issue of issues) {
    logger[issue.level === "fatal" ? "fatal" : "warn"]({ setting: issue.setting }, issue.message);
  }
  if (issues.some((issue) => issue.level === "fatal")) {
    logger.fatal("Refusing to start with an unsafe production configuration");
    process.exit(1);
  }

  await store.initialize();

  // Refuse to start on a migration that errored: `store.initialize()` connects MongoDB, and
  // a failed migration there means the schema is half-applied. Serving it would be worse than
  // not starting. A plain "MongoDB unreachable" is not this — that stays a degraded, retrying
  // in-memory run, unchanged.
  if (persistence.migrationError) {
    logger.fatal(
      { err: persistence.migrationError, version: persistence.migrationError.version },
      "Schema migration failed; refusing to start",
    );
    process.exit(1);
  }

  await authService.initialize();
  state.storeReady = true;
  try {
    configRegistry.startWatching(async () => {
      await store.reloadConfig();
      wsBridge.broadcast({
        type: "fleet.snapshot",
        payload: store.snapshot(),
      });
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start config watcher");
  }
  mqttClient = connectMqtt({ store, topicScheme, config, state });
  offlineSweep = setInterval(() => {
    store.evaluateOfflineDevices().catch((error) => {
      logger.error({ err: error }, "Offline evaluation failed");
    });
  }, 15_000);
  offlineSweep.unref();

  // Retry the write-behind buffer on a timer. The write path only flushed *after a
  // successful write*, which never arrives while MongoDB is down — so a reconnect used to
  // sit on a full buffer until the next vehicle happened to report (P0-c).
  const bufferFlush = setInterval(() => {
    persistence.flushTelemetry().catch((error) => {
      logger.warn({ err: error }, "Scheduled telemetry flush failed");
    });
  }, 10_000);
  bufferFlush.unref();

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "Fleet backend listening");
  });
};

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

// Last-resort safety nets: log instead of crashing on a stray rejection, and
// shut down cleanly on a truly unexpected exception.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception; shutting down");
  void shutdown("uncaughtException");
});

void start();
