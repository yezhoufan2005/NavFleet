import http from "node:http";
import { config } from "./config";
import { logger } from "./logger";
import { createRuntimeState } from "./runtimeState";
import { ConfigRegistry } from "./configRegistry";
import { Persistence } from "./persistence";
import { DashboardStore } from "./store";
import { AuthService } from "./auth/service";
import { buildTopicScheme } from "./topics";
import { createApp } from "./app";
import { createWebSocketBridge } from "./websocket";
import { connectMqtt } from "./mqtt";

// Composition root: build the dependency graph, wire HTTP + WebSocket + MQTT,
// then own the process lifecycle (startup, config hot-reload, graceful shutdown).
const state = createRuntimeState();
const persistence = new Persistence();
const configRegistry = new ConfigRegistry();
const store = new DashboardStore(persistence, configRegistry);
const authService = new AuthService(persistence);
const topicScheme = buildTopicScheme(config.topicPattern);

let wsClientCount = (): number => 0;
const app = createApp({
  store,
  persistence,
  authService,
  config,
  state,
  wsClientCount: () => wsClientCount(),
});

const server = http.createServer(app);
const wsBridge = createWebSocketBridge(server, store, config);
wsClientCount = wsBridge.clientCount;

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
  await store.initialize();
  await authService.initialize();
  state.storeReady = true;
  try {
    await configRegistry.startWatching(async () => {
      await store.reloadConfig();
      wsBridge.broadcast({
        type: "fleet.snapshot",
        payload: store.snapshot(),
      });
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start config watcher");
  }
  connectMqtt({ store, topicScheme, config, state });
  setInterval(() => {
    store.evaluateOfflineDevices().catch((error) => {
      logger.error({ err: error }, "Offline evaluation failed");
    });
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
