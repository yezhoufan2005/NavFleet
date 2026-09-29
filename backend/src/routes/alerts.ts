import express from "express";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { Persistence } from "../persistence";
import type { AuditService } from "../audit/service";
import { alertAckSchema, alertUnackSchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Alert acknowledgement API (Phase 16A). Acknowledging a live alert is the first capability
 * that is `operator`+ rather than `admin`-only or read-for-everyone, so these routes gate on
 * `requireCapability("alerts:ack")` on top of the session check already applied in `app.ts`.
 *
 * The eventKey is assembled here from `deviceId:alertId` in the body rather than taken from a
 * path segment, because a deviceId can carry arbitrary vendor characters. Persistence only
 * touches active rows, so an unknown or already-cleared alert answers 404. On success the
 * store broadcasts so every open console — including other operators — sees the change live.
 */
export const buildAlertsRouter = (
  store: DashboardStore,
  persistence: Persistence,
  audit: AuditService,
): express.Router => {
  const router = express.Router();
  router.use("/alerts/ack", requireCapability("alerts:ack"));
  router.use("/alerts/unack", requireCapability("alerts:ack"));

  router.post("/alerts/ack", async (request, response, next) => {
    try {
      const parsed = alertAckSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const { deviceId, alertId, comment } = parsed.data;
      const eventKey = `${deviceId}:${alertId}`;
      // `requireCapability` guarantees request.user.
      const ackedBy = request.user!.username;
      const ackedAt = new Date();
      const ok = await persistence.ackAlert(eventKey, ackedBy, comment ?? null, ackedAt);
      if (!ok) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      void audit.record({
        actor: ackedBy,
        action: "alert_ack",
        target: eventKey,
        requestId: request.requestId,
        detail: comment ? { comment } : undefined,
      });
      store.broadcastAlertAck({
        deviceId,
        alertId,
        ackedBy,
        ackedAt: ackedAt.toISOString(),
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/alerts/unack", async (request, response, next) => {
    try {
      const parsed = alertUnackSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const { deviceId, alertId } = parsed.data;
      const eventKey = `${deviceId}:${alertId}`;
      const ok = await persistence.unackAlert(eventKey);
      if (!ok) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      void audit.record({
        actor: request.user!.username,
        action: "alert_unack",
        target: eventKey,
        requestId: request.requestId,
      });
      store.broadcastAlertUnack({ deviceId, alertId });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
