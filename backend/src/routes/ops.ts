import express from "express";
import type { Persistence } from "../persistence";
import type { DashboardStore } from "../store";
import type { RuntimeState } from "../runtimeState";
import type { AppConfig } from "../config";
import { renderMetrics } from "../metrics";
import { openApiDocument } from "../openapi";

export interface OpsRouterDeps {
  store: DashboardStore;
  persistence: Persistence;
  state: RuntimeState;
  config: AppConfig;
  wsClientCount: () => number;
}

/**
 * Public operational endpoints (no auth): liveness, readiness, Prometheus
 * metrics and the OpenAPI document. Mounted at the root before the auth gate.
 */
export const buildOpsRouter = ({
  store,
  persistence,
  state,
  config,
  wsClientCount,
}: OpsRouterDeps): express.Router => {
  const router = express.Router();

  // Liveness (no auth).
  router.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "fleet-backend",
      now: new Date().toISOString(),
    });
  });

  // Readiness (no auth): per-dependency status. The store degrades gracefully
  // without MongoDB/MQTT, so those are informational; the probe is only "not
  // ready" (503) until the store has finished initializing.
  router.get("/health/ready", (_request, response) => {
    const checks = {
      store: state.storeReady,
      mongo: persistence.isMongoConnected(),
      mqtt: state.mqttConnected,
    };
    const ready = checks.store;
    response.status(ready ? 200 : 503).json({
      ready,
      degraded: !checks.mongo || !checks.mqtt,
      checks,
      now: new Date().toISOString(),
    });
  });

  // Prometheus metrics (gated by METRICS_ENABLED). Internal scraping only.
  router.get("/metrics", (_request, response) => {
    if (!config.metricsEnabled) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.send(renderMetrics({ store, persistence, state, wsClientCount }));
  });

  // OpenAPI document (no auth): describes the API for tooling / Swagger UI.
  router.get("/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });

  return router;
};
