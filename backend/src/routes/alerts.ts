import express from "express";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { Persistence, DispositionOutcome, StoredAlert } from "../persistence";
import type { AuditService } from "../audit/service";
import type { AuditAction } from "@navfleet/shared";
import { alertDisposition } from "@navfleet/shared";
import {
  alertClaimSchema,
  alertReleaseSchema,
  alertIgnoreSchema,
  alertUnignoreSchema,
} from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Message disposition API — the human-handling axis of a message (claim / release / ignore /
 * unignore), orthogonal to its machine signal lifecycle. Handling a message happens off-line in a
 * read-only system; these routes only record the operator's action. All four are the first
 * `operator`+ capability (not admin-only, not read-for-everyone), so they gate on
 * `requireCapability("alerts:ack")` on top of the session check already applied in `app.ts`.
 *
 * The eventKey is assembled here from `deviceId:alertId` in the body, not a path segment, because a
 * deviceId can carry arbitrary vendor characters. Only active occurrences take a disposition, so an
 * unknown or already-cleared one answers 404. `version` in the body is an optimistic lock: a stale
 * value (or a value another operator moved past) answers 409 with the current holder, so two people
 * claiming at once cannot both win. On success the store broadcasts so every open console sees it.
 */

/** The disposition of an alert as returned to clients and broadcast to every console. */
const dispositionView = (deviceId: string, alertId: string, alert: StoredAlert) => ({
  deviceId,
  alertId,
  version: alert.version,
  disposition: alertDisposition(alert),
  claimedBy: alert.claimedBy,
  claimedAt: alert.claimedAt,
  ignoredBy: alert.ignoredBy,
  ignoredAt: alert.ignoredAt,
  ignoreReason: alert.ignoreReason,
});

/** HTTP status for a failed disposition write. `not_found` → 404; `not_claimant` is a permission
 *  refusal → 403; every other refusal (version conflict, already-claimed/ignored, cleared) is a
 *  state conflict → 409. */
const statusForError = (error: Exclude<DispositionOutcome, { ok: true }>["error"]): number => {
  if (error === "not_found") return 404;
  if (error === "not_claimant") return 403;
  return 409;
};

export const buildAlertsRouter = (
  store: DashboardStore,
  persistence: Persistence,
  audit: AuditService,
): express.Router => {
  const router = express.Router();
  for (const path of ["claim", "release", "ignore", "unignore"]) {
    router.use(`/alerts/${path}`, requireCapability("alerts:ack"));
  }

  /** Audit, broadcast and respond for a completed disposition write. */
  const settle = (
    request: express.Request,
    response: express.Response,
    deviceId: string,
    alertId: string,
    action: AuditAction,
    outcome: DispositionOutcome,
  ): void => {
    if (!outcome.ok) {
      const body: { error: string; current?: ReturnType<typeof dispositionView> } = {
        error: outcome.error,
      };
      if (outcome.current) {
        body.current = dispositionView(deviceId, alertId, outcome.current);
      }
      response.status(statusForError(outcome.error)).json(body);
      return;
    }
    const view = dispositionView(deviceId, alertId, outcome.alert);
    void audit.record({
      actor: request.user!.username,
      action,
      target: `${deviceId}:${alertId}`,
      requestId: request.requestId,
    });
    store.broadcastAlertDisposition(view);
    response.status(200).json(view);
  };

  router.post("/alerts/claim", async (request, response) => {
    const parsed = alertClaimSchema.safeParse(request.body);
    if (!parsed.success) return respondValidationError(response, parsed.error);
    const { deviceId, alertId, version } = parsed.data;
    const outcome = await persistence.claimAlert(
      `${deviceId}:${alertId}`,
      request.user!.username,
      new Date(),
      version,
    );
    settle(request, response, deviceId, alertId, "alert_claim", outcome);
  });

  router.post("/alerts/release", async (request, response) => {
    const parsed = alertReleaseSchema.safeParse(request.body);
    if (!parsed.success) return respondValidationError(response, parsed.error);
    const { deviceId, alertId, version } = parsed.data;
    const outcome = await persistence.releaseAlert(
      `${deviceId}:${alertId}`,
      request.user!.username,
      request.user!.role === "admin",
      version,
    );
    settle(request, response, deviceId, alertId, "alert_release", outcome);
  });

  router.post("/alerts/ignore", async (request, response) => {
    const parsed = alertIgnoreSchema.safeParse(request.body);
    if (!parsed.success) return respondValidationError(response, parsed.error);
    const { deviceId, alertId, reason, version } = parsed.data;
    const outcome = await persistence.ignoreAlert(
      `${deviceId}:${alertId}`,
      request.user!.username,
      reason ?? null,
      new Date(),
      version,
    );
    settle(request, response, deviceId, alertId, "alert_ignore", outcome);
  });

  router.post("/alerts/unignore", async (request, response) => {
    const parsed = alertUnignoreSchema.safeParse(request.body);
    if (!parsed.success) return respondValidationError(response, parsed.error);
    const { deviceId, alertId, version } = parsed.data;
    const outcome = await persistence.unignoreAlert(`${deviceId}:${alertId}`, version);
    settle(request, response, deviceId, alertId, "alert_unignore", outcome);
  });

  return router;
};
