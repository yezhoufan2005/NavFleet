import express from "express";
import { parseFormations, parseVehicles } from "@navfleet/shared";
import { requireRole } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";

/**
 * Device-onboarding wizard config API (Phase 18).
 *
 * The admin console edits `vehicles.json` / `formations.json` through these instead of a
 * human hand-editing files on the server. All four are **admin-only** (unlike the codebook's
 * viewer+ read): this is a management surface, not monitoring data, so even reading the raw
 * config is an admin concern.
 *
 * Writing config files is operator-domain and does **not** breach the read-only red line —
 * that line forbids dispatching commands to vehicles, not persisting configuration. It
 * extends the precedent the codebook import (Phase 16C) set. `vehicles.json` remains a set
 * of **overrides**: it does not create a live device — one still appears only once it reports.
 *
 * Validate-first, exactly like the codebook route: an invalid body is a 400 that writes
 * nothing; only a genuine write/reload failure falls through to 500.
 */
export const buildDeviceConfigRouter = (
  store: DashboardStore,
  audit: AuditService,
): express.Router => {
  const router = express.Router();

  const unwrap = (body: unknown, key: "vehicles" | "formations"): unknown =>
    body && typeof body === "object" && !Array.isArray(body) && key in body
      ? (body as Record<string, unknown>)[key]
      : body;

  router.get("/vehicles", requireRole("admin"), (_request, response) => {
    response.json({ vehicles: store.listVehicleConfigs() });
  });

  router.put("/vehicles", requireRole("admin"), async (request, response, next) => {
    const raw = unwrap(request.body, "vehicles");
    let vehicles;
    try {
      vehicles = parseVehicles(raw);
    } catch (validationError) {
      response.status(400).json({
        error: "invalid_vehicles",
        detail: validationError instanceof Error ? validationError.message : "invalid vehicles",
      });
      return;
    }
    // Refuse to orphan a formation: removing a vehicle a formation still names would make the
    // next config load fail. A clean 400 (writeVehicles re-checks as the authority).
    const nextIds = new Set(vehicles.map((vehicle) => vehicle.deviceId));
    for (const formation of store.listFormationConfigs()) {
      const missing = formation.deviceIds.find((deviceId) => !nextIds.has(deviceId));
      if (missing !== undefined) {
        response.status(400).json({
          error: "vehicle_referenced_by_formation",
          detail: `deviceId ${missing} is still referenced by formation ${formation.formationId}`,
        });
        return;
      }
    }
    try {
      const saved = await store.writeVehicles(raw);
      void audit.record({
        actor: request.user!.username,
        action: "vehicles_write",
        requestId: request.requestId,
        detail: { vehicleCount: saved.length },
      });
      response.json({ vehicles: saved });
    } catch (error) {
      next(error);
    }
  });

  router.get("/formation-config", requireRole("admin"), (_request, response) => {
    response.json({ formations: store.listFormationConfigs() });
  });

  router.put("/formation-config", requireRole("admin"), async (request, response, next) => {
    const raw = unwrap(request.body, "formations");
    let formations;
    try {
      formations = parseFormations(raw);
    } catch (validationError) {
      response.status(400).json({
        error: "invalid_formations",
        detail: validationError instanceof Error ? validationError.message : "invalid formations",
      });
      return;
    }
    // Referential integrity as a clean 400 (writeFormations re-checks as the authority): every
    // deviceId a formation names must be a configured vehicle, or a cold start could not load it.
    const knownDevices = new Set(store.listVehicleConfigs().map((vehicle) => vehicle.deviceId));
    for (const formation of formations) {
      const missing = formation.deviceIds.find((deviceId) => !knownDevices.has(deviceId));
      if (missing !== undefined) {
        response.status(400).json({
          error: "unknown_device_in_formation",
          detail: `formation ${formation.formationId} references unknown deviceId ${missing}`,
        });
        return;
      }
    }
    try {
      const saved = await store.writeFormations(raw);
      void audit.record({
        actor: request.user!.username,
        action: "formations_write",
        requestId: request.requestId,
        detail: { formationCount: saved.length },
      });
      response.json({ formations: saved });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
