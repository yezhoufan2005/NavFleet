import express from "express";
import type { DashboardStore } from "../store";
import { alertsQuerySchema, deviceIdParamSchema, historyQuerySchema } from "../validation";
import { markTruncation, respondValidationError } from "./helpers";
import { MAX_ALERTS_PER_QUERY } from "../persistence";

/** Fleet read endpoints: snapshot, formations, per-device history, alerts. */
export const buildFleetRouter = (store: DashboardStore): express.Router => {
  const router = express.Router();

  router.get("/fleet/snapshot", (_request, response) => {
    response.json({
      summary: store.buildSummary(),
      ...store.snapshot(),
    });
  });

  router.get("/formations", (_request, response) => {
    response.json({ items: store.getFormations() });
  });

  router.get("/devices/:deviceId/history", async (request, response, next) => {
    try {
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const parsedDeviceId = deviceIdParamSchema.safeParse(request.params.deviceId);
      if (!parsedDeviceId.success) {
        respondValidationError(response, parsedDeviceId.error);
        return;
      }
      const deviceId = parsedDeviceId.data;
      const history = await store.getHistory(
        deviceId,
        parsed.data.from,
        parsed.data.to,
        parsed.data.limit,
      );
      response.json({ deviceId, items: history });
    } catch (error) {
      next(error);
    }
  });

  router.get("/alerts", async (request, response, next) => {
    try {
      const parsed = alertsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const items = await store.getAlerts(parsed.data);
      response.json({ items, ...markTruncation(response, items.length, MAX_ALERTS_PER_QUERY) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
