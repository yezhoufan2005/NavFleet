import express from "express";
import { requireCapability } from "../auth/middleware";
import type { AuditService } from "../audit/service";
import { auditQuerySchema } from "../validation";
import { markTruncation, respondValidationError } from "./helpers";
import { MAX_AUDIT_PER_QUERY } from "../persistence";

/**
 * Audit trail query API (Phase 15D). Admin-only, on top of the session gate — reading who did
 * what is itself a privileged action. The write side is emitted from the auth and user-admin
 * routes; this only reads back.
 */
export const buildAuditRouter = (audit: AuditService): express.Router => {
  const router = express.Router();

  router.get("/audit", requireCapability("audit:read"), async (request, response) => {
    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const entries = await audit.query(parsed.data);
    response.json({ entries, ...markTruncation(response, entries.length, MAX_AUDIT_PER_QUERY) });
  });

  return router;
};
