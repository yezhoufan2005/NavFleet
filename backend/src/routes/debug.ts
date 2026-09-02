import express from "express";
import type { DashboardStore } from "../store";
import type { AppConfig } from "../config";
import { requireRole } from "../auth/middleware";
import { ingestBodySchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Debug ingestion endpoint: inject a synthetic payload through the same
 * normalization path as MQTT. Double-gated — admin role + DEBUG_INGEST_ENABLED
 * (default false), so it is inert in production unless explicitly enabled.
 */
export const buildDebugRouter = (store: DashboardStore, config: AppConfig): express.Router => {
  const router = express.Router();

  router.post("/debug/ingest", requireRole("admin"), async (request, response, next) => {
    try {
      if (!config.debugIngestEnabled) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      const parsed = ingestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      // The one caller allowed to replace the whole fleet, and the one that wants a
      // snapshot back — see `applyPayload`, which no longer builds one for everybody.
      await store.applyPayload(parsed.data, "debug-api", { allowReplace: true });
      response.json(store.snapshot());
    } catch (error) {
      next(error);
    }
  });

  return router;
};
