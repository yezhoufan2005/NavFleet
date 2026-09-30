import express from "express";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";
import { parseAlertRules } from "../configRegistry";

/**
 * Alert-rule config API (1.6.1) — the console face of `rules.json`. Admin-only (`rules:write`),
 * like the notify config-write: retuning a threshold, toggling a rule or scoping it to some
 * devices is deployment-domain configuration, not vehicle command dispatch, so the read-only red
 * line (no control-plane writes) holds. Endpoint has no secrets to redact — the rules file is a
 * handful of thresholds — so there is a single editable read (`GET /rules/config`) rather than the
 * redacted-vs-raw split notify needs.
 *
 * `GET /rules/config` — the effective rules (built-in defaults ⊕ `rules.json`) for the editor.
 * `PUT /rules/config` — a validate-first whole-file write: `parseAlertRules` runs in the route so
 * a malformed body is a 400 (`invalid_rules`) that never touches disk, then the store persists
 * atomically + hot-reloads and the audit trail records `rules_write`.
 */
export const buildRulesRouter = (store: DashboardStore, audit: AuditService): express.Router => {
  const router = express.Router();

  router.get("/rules/config", requireCapability("rules:write"), (_request, response) => {
    response.json({ config: store.getAlertRules() });
  });

  router.put("/rules/config", requireCapability("rules:write"), async (request, response, next) => {
    let parsed;
    try {
      parsed = parseAlertRules(request.body);
    } catch (error) {
      response
        .status(400)
        .json({ error: "invalid_rules", message: error instanceof Error ? error.message : "" });
      return;
    }
    try {
      const config = await store.writeAlertRules(parsed);
      void audit.record({
        actor: request.user!.username,
        action: "rules_write",
        requestId: request.requestId,
        detail: {
          lowBatteryEnabled: config.lowBattery.enabled,
          offlineEnabled: config.offline.enabled,
        },
      });
      response.json({ config });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
