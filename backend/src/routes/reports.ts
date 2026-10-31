import express from "express";
import { config } from "../config";
import type { DashboardStore } from "../store";
import { boundReportWindow, reportAvailabilityQuerySchema, reportRangeSchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Report aggregation endpoints.
 *
 * Read-only, so they sit at viewer+ like the rest of the fleet surface — no `requireRole`.
 * The numbers come from server-side Mongo aggregation (`store.getAlertStats` /
 * `store.getAvailabilityReport`), which returns an honest-empty report flagged `available:false`
 * when there is no Mongo, rather than pretending a zero-filled result means "no data". Channels /
 * routing stay out of here; this is pure read.
 */
export const buildReportsRouter = (store: DashboardStore): express.Router => {
  const router = express.Router();

  router.get("/reports/alerts", async (request, response) => {
    const parsed = reportRangeSchema.safeParse(request.query);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const report = await store.getAlertStats(boundReportWindow(parsed.data));
    response.json(report);
  });

  router.get("/reports/availability", async (request, response) => {
    const parsed = reportAvailabilityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const report = await store.getAvailabilityReport(boundReportWindow(parsed.data));
    // The zone the buckets were cut in, so an export can write them as local times.
    response.json({ ...report, timeZone: config.reportTimezone });
  });

  return router;
};
