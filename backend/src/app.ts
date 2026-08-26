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
import { logger } from "./logger";
import { authenticate } from "./auth/middleware";
import { buildAuthRouter } from "./auth/routes";
import { buildOpsRouter } from "./routes/ops";
import { buildFleetRouter } from "./routes/fleet";
import { buildScenesRouter } from "./routes/scenes";
import { buildDebugRouter } from "./routes/debug";

export interface AppDeps {
  store: DashboardStore;
  persistence: Persistence;
  authService: AuthService;
  config: AppConfig;
  state: RuntimeState;
  wsClientCount: () => number;
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
}: AppDeps): express.Express => {
  const app = express();

  app.use(helmet());
  if (config.corsOrigins.length) {
    app.use(cors({ origin: config.corsOrigins, credentials: true }));
  }
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  // Request logging: one line per request on completion. Health/metrics probes
  // are noisy and logged at debug; everything else at info (gated by LOG_LEVEL).
  app.use((request, response, next) => {
    const startedAtMs = Date.now();
    response.on("finish", () => {
      const durationMs = Date.now() - startedAtMs;
      const isProbe = request.path === "/health" || request.path.startsWith("/metrics");
      logger[isProbe ? "debug" : "info"](
        {
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs,
        },
        "request",
      );
    });
    next();
  });

  // __APP_BODY__

  // Public operational endpoints (liveness/readiness/metrics/openapi).
  app.use(buildOpsRouter({ store, persistence, state, config, wsClientCount }));

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

  app.use("/api", buildFleetRouter(store));
  app.use("/api", buildScenesRouter(store));
  app.use("/api", buildDebugRouter(store, config));

  // __APP_TAIL__

  // JSON 404 for any unmatched route, keeping the error contract consistent
  // with the rest of the API (Express's default would return an HTML page).
  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
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
      // Log the detail server-side but return a generic message so internal
      // error text (e.g. driver messages) never leaks to clients.
      logger.error({ err: error }, "Unhandled request error");
      response.status(500).json({ error: "internal_error" });
    },
  );

  return app;
};
