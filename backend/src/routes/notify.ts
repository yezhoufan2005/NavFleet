import express from "express";
import { requireRole } from "../auth/middleware";
import type { NotifyService } from "../notify/service";
import { notifyLogQuerySchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Outbound-notification read API (Phase 16D-1). Both routes are **admin-only** on top of the
 * session gate: a send record names the endpoints an alert was pushed to, and the channel
 * overview says which are wired up — operational detail on the same footing as the audit trail.
 *
 * There is deliberately no write route. Channels and routing live in `notify.json` on disk
 * (the `rules.json` precedent: file-managed, no web editing), and endpoint secrets live in env,
 * so nothing here mutates config — it only reads back what was sent and what is configured.
 *
 * `GET /notify/log` — recent send records (newest first, capped server-side), filterable by
 * device / channel / status / time. `GET /notify/config` — the effective channels with secrets
 * redacted (`configured` says whether each channel's endpoint env is set; the URL is never
 * returned).
 */
export const buildNotifyRouter = (notify: NotifyService): express.Router => {
  const router = express.Router();

  router.get("/notify/log", requireRole("admin"), async (request, response, next) => {
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

  router.get("/notify/config", requireRole("admin"), (_request, response) => {
    response.json({ channels: notify.effectiveConfig() });
  });

  return router;
};
