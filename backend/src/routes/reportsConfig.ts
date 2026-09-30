import express from "express";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";
import { parseReportsConfig } from "../configRegistry";

/**
 * Scheduled-report config API (1.6.1) — the console face of `reports.json`. Admin-only
 * (`reports:write`), like the notify/rules config-writes: choosing when a periodic report is
 * mailed and to whom is deployment-domain configuration, not vehicle command dispatch, so the
 * read-only red line holds. The file carries no secrets — each schedule records the *name* of the
 * env var that holds its SMTP connection string (`smtpEnv`), never the string itself — so there is
 * a single editable read (`GET /reports/config`) with no redacted-vs-raw split.
 *
 * `GET /reports/config` — the scheduled-report config for the editor. `PUT /reports/config` — a
 * validate-first whole-file write: `parseReportsConfig` runs in the route so a malformed body is a
 * 400 (`invalid_reports`) that never touches disk, then the store persists atomically + hot-reloads
 * (the scheduler reads the config live each tick, so a change takes effect on the next poll) and
 * the audit trail records `reports_write`.
 */
export const buildReportsConfigRouter = (
  store: DashboardStore,
  audit: AuditService,
): express.Router => {
  const router = express.Router();

  router.get("/reports/config", requireCapability("reports:write"), (_request, response) => {
    response.json({ config: store.getReportsConfig() });
  });

  router.put(
    "/reports/config",
    requireCapability("reports:write"),
    async (request, response, next) => {
      let parsed;
      try {
        parsed = parseReportsConfig(request.body);
      } catch (error) {
        response
          .status(400)
          .json({ error: "invalid_reports", message: error instanceof Error ? error.message : "" });
        return;
      }
      try {
        const config = await store.writeReportsConfig(parsed);
        void audit.record({
          actor: request.user!.username,
          action: "reports_write",
          requestId: request.requestId,
          detail: { scheduleCount: config.schedules.length },
        });
        response.json({ config });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
