import express from "express";
import { requireCapability } from "../auth/middleware";
import type { NotifyService } from "../notify/service";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";
import { parseNotifyConfig } from "../configRegistry";
import { notifyLogQuerySchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Outbound-notification read API (Phase 16D-1). Both routes are **admin-only** on top of the
 * session gate: a send record names the endpoints an alert was pushed to, and the channel
 * overview says which are wired up — operational detail on the same footing as the audit trail.
 *
 * Since 1.6.1 the config is editable from the console (`PUT /notify/config`, `notify:write`) — the
 * same operator-domain config-write motion as the codebook and vehicles/formations. Endpoint
 * secrets still live in env; the file only records each channel's `urlEnv` variable name, so a
 * write never persists a credential.
 *
 * `GET /notify/log` — recent send records (newest first, capped server-side), filterable by
 * device / channel / status / time. `GET /notify/config` — the effective channels with secrets
 * redacted (`configured` says whether each channel's endpoint env is set; the URL is never
 * returned). `GET /notify/config/raw` + `PUT /notify/config` — the editable config (`notify:write`,
 * 1.6.1): the raw `{ channels, groups }` for the editor, and a validate-first whole-file write.
 * Endpoint secrets never enter this file — only their `urlEnv` variable *names* — so writing it is
 * operator-domain config, not command dispatch: the read-only red line holds.
 */
export const buildNotifyRouter = (
  notify: NotifyService,
  store: DashboardStore,
  audit: AuditService,
): express.Router => {
  const router = express.Router();

  router.get("/notify/log", requireCapability("notify:read"), async (request, response, next) => {
    try {
      const parsed = notifyLogQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      response.json({ items: await notify.queryLog(parsed.data) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/notify/config", requireCapability("notify:read"), (_request, response) => {
    response.json({ channels: notify.effectiveConfig() });
  });

  // The raw editable config for the write editor (`notify:write`): channels with their `urlEnv`
  // variable *names* (not secrets) + routing + groups, so the editor can round-trip the fields it
  // does not expose. Gated tighter than the redacted read view above.
  router.get("/notify/config/raw", requireCapability("notify:write"), (_request, response) => {
    response.json({ config: store.getNotifyConfig() });
  });

  // Validate-first whole-file write (like the codebook / vehicles routes): parse in the route so an
  // invalid body is a 400 that never touches disk, then persist + reload via the store.
  router.put(
    "/notify/config",
    requireCapability("notify:write"),
    async (request, response, next) => {
      let parsed;
      try {
        parsed = parseNotifyConfig(request.body);
      } catch (error) {
        response.status(400).json({
          error: "invalid_notify",
          detail: error instanceof Error ? error.message : "invalid notify",
        });
        return;
      }
      try {
        const config = await store.writeNotifyConfig(parsed);
        void audit.record({
          actor: request.user!.username,
          action: "notify_write",
          requestId: request.requestId,
          detail: { channelCount: config.channels.length },
        });
        response.json({ config });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
