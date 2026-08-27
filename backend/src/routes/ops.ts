import express from "express";
import type { Persistence } from "../persistence";
import type { RuntimeState } from "../runtimeState";
import type { AppConfig } from "../config";
import type { Metrics } from "../metrics";
import { openApiDocument } from "../openapi";

export interface OpsRouterDeps {
  persistence: Persistence;
  state: RuntimeState;
  config: AppConfig;
  metrics: Metrics;
}

/**
 * Public operational endpoints (no auth): liveness, readiness, Prometheus
 * metrics and the OpenAPI document. Mounted at the root before the auth gate.
 */
export const buildOpsRouter = ({
  persistence,
  state,
  config,
  metrics,
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

  // Prometheus metrics (gated by METRICS_ENABLED). Unauthenticated so a scraper
  // needs no session, and therefore NOT proxied by the edge nginx: scraping
  // happens from inside the deployment's network.
  router.get("/metrics", (_request, response, next) => {
    if (!config.metricsEnabled) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    metrics
      .render()
      .then((body) => {
        response.setHeader("Content-Type", metrics.contentType);
        response.send(body);
      })
      .catch(next);
  });

  return router;
};

/**
 * The OpenAPI document, mounted after the auth gate.
 *
 * Behind a session on purpose: it is a complete map of the API, and an
 * unauthenticated scanner has no business reading one. A browser (or Swagger UI)
 * already carries the session cookie, so nothing legitimate loses access.
 */
export const buildOpenApiRouter = (): express.Router => {
  const router = express.Router();

  router.get("/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });

  return router;
};
