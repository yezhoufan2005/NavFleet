import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { Persistence } from "./persistence";
import type { DashboardStore } from "./store";
import type { AuthService } from "./auth/service";
import type { AppConfig } from "./config";
import type { RuntimeState } from "./runtimeState";
import { runtimePaths } from "./config";
import { createMetrics, captureRouteMount } from "./metrics";
import { requestContext, requestLogger } from "./requestContext";
import { authenticate } from "./auth/middleware";
import { buildAuthRouter } from "./auth/routes";
import { buildOpsRouter, buildOpenApiRouter } from "./routes/ops";
import { buildDocsRouter } from "./routes/docs";
import { buildFleetRouter } from "./routes/fleet";
import { buildScenesRouter } from "./routes/scenes";
import { buildDebugRouter } from "./routes/debug";

/**
 * Mount prefixes for the domain API. `/api/v1` is the surface to build against;
 * bare `/api` stays so existing clients keep working.
 */
export const API_PREFIXES = ["/api/v1", "/api"] as const;

export interface AppDeps {
  store: DashboardStore;
  persistence: Persistence;
  authService: AuthService;
  config: AppConfig;
  state: RuntimeState;
  wsClientCount: () => number;
  /** Register process-level metrics (heap/GC/event loop). See MetricsDeps. */
  collectDefaultMetrics?: boolean;
}

/**
 * Build the Express application: base middleware, public ops + auth routes, the
 * authentication gate, then the authenticated static + domain routers, and
 * finally the JSON 404 and error handlers. Route/middleware order is
 * significant and mirrors the original composition.
 */
export const createApp = ({
  store,
  persistence,
  authService,
  config,
  state,
  wsClientCount,
  collectDefaultMetrics = false,
}: AppDeps): express.Express => {
  const app = express();
  const metrics = createMetrics({
    store,
    persistence,
    state,
    wsClientCount,
    collectDefault: collectDefaultMetrics,
  });

  // How many reverse-proxy hops may set X-Forwarded-For. Without this the rate
  // limiters below key every request behind nginx to the proxy's own address, so
  // one bucket is shared by the whole deployment — one noisy client would lock
  // everybody out. Trusting the header unconditionally is the opposite mistake:
  // a directly exposed backend would let a client choose its own bucket.
  app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      // The backend answers JSON and serves scene-map images; it renders no
      // document, so nothing legitimate needs a fetch directive. `default-src
      // 'none'` covers them all, and framing/base/form directives blunt the
      // damage if a response ever does get interpreted as HTML.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        },
      },
    }),
  );
  if (config.corsOrigins.length) {
    app.use(cors({ origin: config.corsOrigins, credentials: true }));
  }
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  // Correlation id first, so every later middleware (including the request log
  // and the error handler) can attribute its output to one request.
  app.use(requestContext);

  // Request logging + latency histogram: one line and one observation per
  // request on completion. Health/metrics probes are noisy and logged at debug;
  // everything else at info (gated by LOG_LEVEL).
  app.use((request, response, next) => {
    const startedAtNs = process.hrtime.bigint();
    response.on("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAtNs) / 1e9;
      metrics.observeHttpRequest(request, response, durationSeconds);
      const isProbe = request.path === "/health" || request.path.startsWith("/metrics");
      requestLogger(request)[isProbe ? "debug" : "info"](
        {
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Math.round(durationSeconds * 1000),
        },
        "request",
      );
    });
    next();
  });

  // Public operational endpoints (liveness/readiness/metrics/openapi). Mounted
  // ahead of the API rate limit so a probe or a Prometheus scrape can never be
  // throttled by client traffic.
  app.use(captureRouteMount, buildOpsRouter({ persistence, state, config, metrics }));

  // Coarse per-IP limit for the whole API, including the auth routes below.
  // Complements the tighter credential limit rather than replacing it, and sits
  // in front of the auth gate so unauthenticated probing is capped too.
  app.use(
    "/api",
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "too_many_requests" },
    }),
  );

  // Auth routes are public (login/refresh/logout); /me is guarded inside the
  // router. A tight rate limit protects the credential endpoint from brute force.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests" },
  });
  app.use("/api/auth", authLimiter, captureRouteMount, buildAuthRouter(authService));

  // Everything below requires a valid session.
  app.use(authenticate);

  app.use(captureRouteMount, buildOpenApiRouter());
  app.use(captureRouteMount, buildDocsRouter());

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

  /**
   * Domain routes are served under both `/api/v1` (the versioned surface new
   * clients should use) and bare `/api` (what every existing deployment, script
   * and bookmark already calls). Mounting the same routers twice rather than
   * redirecting keeps both exact — no method or body is lost to a 30x — and lets
   * the unversioned prefix be retired later without touching the routers.
   *
   * Authentication deliberately stays unversioned at `/api/auth`: the refresh
   * cookie is scoped to that path so it is not sent with every API call, and
   * widening it to cover a versioned twin would undo that.
   */
  for (const prefix of API_PREFIXES) {
    app.use(prefix, captureRouteMount, buildFleetRouter(store));
    app.use(prefix, captureRouteMount, buildScenesRouter(store));
    app.use(prefix, captureRouteMount, buildDebugRouter(store, config));
  }

  // JSON 404 for any unmatched route, keeping the error contract consistent
  // with the rest of the API (Express's default would return an HTML page).
  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  app.use(
    (
      error: unknown,
      request: express.Request,
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
      // Log the detail server-side but return a generic message so internal
      // error text (e.g. driver messages) never leaks to clients. The request id
      // travels with the response so a reported failure can be found in the logs.
      requestLogger(request).error({ err: error }, "Unhandled request error");
      response.status(500).json({ error: "internal_error", requestId: request.requestId });
    },
  );

  return app;
};
