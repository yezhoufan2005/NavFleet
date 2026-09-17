import express from "express";
import { requireRole } from "../auth/middleware";
import type { AuditService } from "../audit/service";
import { auditQuerySchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Audit trail query API (Phase 15D). Admin-only, on top of the session gate — reading who did
 * what is itself a privileged action. The write side is emitted from the auth and user-admin
 * routes; this only reads back.
 */
export const buildAuditRouter = (audit: AuditService): express.Router => {
  const router = express.Router();

  router.get("/audit", requireRole("admin"), async (request, response, next) => {
    try {
      const parsed = auditQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      response.json({ entries: await audit.query(parsed.data) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
