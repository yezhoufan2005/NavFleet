/**
 * Prometheus instrumentation, backed by `prom-client`.
 *
 * Note on the dependency: npm marks `prom-client` deprecated in favour of
 * `@prometheus-io/client` (the same codebase after its donation to the
 * Prometheus org). That successor published its first stable release only days
 * ago (0.16.0, three versions total, ~750 weekly downloads against 9M for
 * prom-client), so this stays on the proven package for now. The API is
 * identical, which makes the swap a one-line change once adoption catches up.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { NextFunction, Request, Response } from "express";
import type { Persistence } from "./persistence";
import type { DashboardStore } from "./store";
import type { RuntimeState } from "./runtimeState";

declare module "express-serve-static-core" {
  interface Request {
    /** Router mount prefix, captured while it is still in scope. */
    metricsMount?: string;
  }
}

export interface MetricsDeps {
  store: DashboardStore;
  persistence: Persistence;
  state: RuntimeState;
  wsClientCount: () => number;
  /**
   * Register `prom-client`'s process metrics (heap, event-loop lag, GC, fds).
   * Off by default: each call installs process-wide hooks (including a GC
   * PerformanceObserver that is never disconnected), which would accumulate
   * across the many app instances a test suite builds. The composition root
   * turns it on for the single real process.
   */
  collectDefault?: boolean;
}

export interface Metrics {
  registry: Registry;
  /** Prometheus text exposition for the current process state. */
  render: () => Promise<string>;
  contentType: string;
  /** Record one finished HTTP request in the duration histogram. */
  observeHttpRequest: (request: Request, response: Response, durationSeconds: number) => void;
}

/**
 * Record the router mount prefix on the request while it is still in scope.
 *
 * Express restores `request.baseUrl` as the router stack unwinds, and `next(err)`
 * unwinds it *before* the response finishes. Reading `baseUrl` when the response
 * finishes would therefore label the very same endpoint `/api/fleet/snapshot`
 * when it succeeds and `/fleet/snapshot` when it throws — two series for one
 * route, and a latency panel that silently drops the error traffic. Mount this
 * as the first handler of every router mount instead.
 */
export const captureRouteMount = (
  request: Request,
  _response: Response,
  next: NextFunction,
): void => {
  request.metricsMount = request.baseUrl || "";
  next();
};

/**
 * The label used for a request's route. Must be the matched *route template*
 * (`/api/devices/:deviceId/history`), never the concrete path, or every device
 * id would mint a new time series and blow up the histogram's cardinality.
 *
 * Express exposes the template on `request.route` only for matched routes, and
 * relative to the router's mount point — hence the captured mount + `route.path`.
 * Unmatched requests collapse into a single `unmatched` series; note that a
 * request rejected by the auth gate lands there too, because no route has
 * matched yet when the 401 is written (the status label keeps the two apart).
 */
export const routeLabel = (request: Request): string => {
  const routePath = (request.route as { path?: string } | undefined)?.path;
  if (typeof routePath !== "string") {
    return "unmatched";
  }
  const mount = request.metricsMount ?? request.baseUrl ?? "";
  const combined = `${mount}${routePath}`;
  if (combined === "") {
    return "/";
  }
  // A router mounted at "/api" with a route "/" yields "/api/" — normalize the
  // trailing slash away so it shares a series with "/api".
  return combined.length > 1 && combined.endsWith("/") ? combined.slice(0, -1) : combined;
};

/**
 * Build an isolated metrics registry for one application instance.
 *
 * Deliberately not the `prom-client` global registry: the gauges below close
 * over their collaborators, so a process-wide singleton would make the first
 * app ever built the permanent source of truth — wrong for tests, and a leak in
 * any future multi-app scenario.
 *
 * Gauges are pull-based (`collect()` reads live state at scrape time), matching
 * the semantics of the hand-rolled exposition this replaced. Metric names are
 * unchanged so existing scrape configs and dashboards keep working.
 */
export const createMetrics = ({
  store,
  persistence,
  state,
  wsClientCount,
  collectDefault = false,
}: MetricsDeps): Metrics => {
  const registry = new Registry();

  if (collectDefault) {
    collectDefaultMetrics({ register: registry, prefix: "navfleet_process_" });
  }

  const gauge = (name: string, help: string, read: () => number): void => {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read());
      },
    });
  };

  /**
   * A counter whose authoritative value lives on RuntimeState (written by the
   * MQTT client). `prom-client` counters are normally incremented in place; to
   * publish an externally-owned absolute value we reset and re-add it at scrape
   * time. Keeping RuntimeState as the single writer avoids two sources of truth.
   */
  const mirroredCounter = (name: string, help: string, read: () => number): void => {
    new Counter({
      name,
      help,
      registers: [registry],
      collect() {
        this.reset();
        this.inc(read());
      },
    });
  };

  const numeric = (value: unknown): number => Number(value) || 0;

  gauge("navfleet_up", "1 if the backend process is running", () => 1);
  gauge("navfleet_uptime_seconds", "Process uptime in seconds", () =>
    Math.round((Date.now() - state.startedAt) / 1000),
  );
  gauge("navfleet_devices_total", "Devices known to the fleet", () =>
    numeric(store.buildSummary().deviceCount),
  );
  gauge("navfleet_devices_online", "Devices currently online", () =>
    numeric(store.buildSummary().onlineCount),
  );
  gauge("navfleet_alerts_active", "Active alerts across the fleet", () =>
    numeric(store.buildSummary().alertCount),
  );
  gauge("navfleet_ws_connections", "Open WebSocket client connections", () => wsClientCount());
  gauge("navfleet_mongo_connected", "1 if MongoDB is connected", () =>
    persistence.isMongoConnected() ? 1 : 0,
  );
  gauge("navfleet_mongo_buffer_pending", "Telemetry docs buffered awaiting MongoDB flush", () =>
    persistence.pendingTelemetryCount(),
  );
  gauge("navfleet_mqtt_connected", "1 if the MQTT broker is connected", () =>
    state.mqttConnected ? 1 : 0,
  );
  mirroredCounter(
    "navfleet_mqtt_messages_total",
    "Total MQTT messages ingested",
    () => state.mqttMessagesTotal,
  );
  mirroredCounter(
    "navfleet_mqtt_messages_rejected_total",
    "Total MQTT messages dropped by ingest validation",
    () => state.mqttMessagesRejected,
  );

  // Buckets span an in-memory snapshot read (sub-millisecond) through a slow
  // Mongo history query (seconds), which is the actual latency range here.
  const httpDuration = new Histogram({
    name: "navfleet_http_request_duration_seconds",
    help: "HTTP request duration by method, matched route and status code",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return {
    registry,
    render: () => registry.metrics(),
    contentType: registry.contentType,
    observeHttpRequest: (request, response, durationSeconds) => {
      httpDuration.observe(
        {
          method: request.method,
          route: routeLabel(request),
          status: String(response.statusCode),
        },
        durationSeconds,
      );
    },
  };
};
