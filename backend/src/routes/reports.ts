import express from "express";
import type { DashboardStore } from "../store";
import { reportAvailabilityQuerySchema, reportRangeSchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Report aggregation endpoints (Phase 17A).
 *
 * Read-only, so they sit at viewer+ like the rest of the fleet surface — no `requireRole`.
 * The numbers come from server-side Mongo aggregation (`store.getAlertStats` /
 * `store.getAvailabilityReport`), which returns an honest-empty report flagged `available:false`
 * when there is no Mongo, rather than pretending a zero-filled result means "no data". Channels /
 * routing stay out of here; this is pure read.
 */
export const buildReportsRouter = (store: DashboardStore): express.Router => {
  const router = express.Router();

  router.get("/reports/alerts", async (request, response, next) => {
    try {
      const parsed = reportRangeSchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const report = await store.getAlertStats(parsed.data);
      response.json(report);
    } catch (error) {
      next(error);
    }
  });

  router.get("/reports/availability", async (request, response, next) => {
    try {
      const parsed = reportAvailabilityQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const report = await store.getAvailabilityReport(parsed.data);
      response.json(report);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
