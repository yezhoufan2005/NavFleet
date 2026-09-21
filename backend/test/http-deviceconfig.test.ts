import { describe, it, expect } from "vitest";
import request from "supertest";
import type { DeviceConfig, FormationConfig } from "@navfleet/shared";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * Device-onboarding wizard config API (Phase 18). The admin-only gate on all four routes is
 * pinned in http-rbac; here we cover the router → store wiring: reads list config, a valid PUT
 * validates + writes + audits, an invalid body is a 400 that never touches the store, and a
 * formation naming an unconfigured vehicle is a 400 (unknown_device_in_formation).
 */
const ADMIN = sessionCookie("admin", "admin-1");

const VEHICLE: DeviceConfig = {
  deviceId: "agv-x1",
  deviceName: "X1 巡检车",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: ["巡检"],
};
const FORMATION: FormationConfig = {
  formationId: "f-alpha",
  formationName: "编队 Alpha",
  deviceIds: ["agv-x1"],
};

describe("GET /api/vehicles", () => {
  it("lists the configured vehicles for an admin", async () => {
    const context = createTestApp();
    context.store.listVehicleConfigs.mockReturnValue([VEHICLE]);

    const response = await request(context.app).get("/api/vehicles").set("Cookie", ADMIN);

    expect(response.status).toBe(200);
    expect((response.body as { vehicles: unknown[] }).vehicles).toEqual([VEHICLE]);
  });
});

describe("PUT /api/vehicles", () => {
  it("validates, writes, audits, and returns the vehicles", async () => {
    const context = createTestApp();
    context.store.writeVehicles.mockResolvedValue([VEHICLE]);

    const response = await request(context.app)
      .put("/api/vehicles")
      .set("Cookie", ADMIN)
      .send({ vehicles: [VEHICLE] });

    expect(response.status).toBe(200);
    expect((response.body as { vehicles: unknown[] }).vehicles).toEqual([VEHICLE]);
    expect(context.store.writeVehicles).toHaveBeenCalledWith([VEHICLE]);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin-1", action: "vehicles_write" }),
    );
  });

  it("400s an invalid vehicles payload without writing or auditing", async () => {
    const context = createTestApp();

    const response = await request(context.app)
      .put("/api/vehicles")
      .set("Cookie", ADMIN)
      .send({ vehicles: [{ ...VEHICLE, deviceId: "" }] });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_vehicles");
    expect(context.store.writeVehicles).not.toHaveBeenCalled();
    expect(context.auditService.record).not.toHaveBeenCalled();
  });
});

describe("PUT /api/formation-config", () => {
  it("validates, writes, audits when every device is configured", async () => {
    const context = createTestApp();
    context.store.listVehicleConfigs.mockReturnValue([VEHICLE]);
    context.store.writeFormations.mockResolvedValue([FORMATION]);

    const response = await request(context.app)
      .put("/api/formation-config")
      .set("Cookie", ADMIN)
      .send({ formations: [FORMATION] });

    expect(response.status).toBe(200);
    expect(context.store.writeFormations).toHaveBeenCalledWith([FORMATION]);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin-1", action: "formations_write" }),
    );
  });

  it("400s an invalid formations payload", async () => {
    const context = createTestApp();

    const response = await request(context.app)
      .put("/api/formation-config")
      .set("Cookie", ADMIN)
      .send({ formations: [{ ...FORMATION, deviceIds: [] }] });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_formations");
    expect(context.store.writeFormations).not.toHaveBeenCalled();
  });

  it("400s a formation that references an unconfigured vehicle", async () => {
    const context = createTestApp();
    context.store.listVehicleConfigs.mockReturnValue([]); // agv-x1 not configured

    const response = await request(context.app)
      .put("/api/formation-config")
      .set("Cookie", ADMIN)
      .send({ formations: [FORMATION] });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("unknown_device_in_formation");
    expect(context.store.writeFormations).not.toHaveBeenCalled();
    expect(context.auditService.record).not.toHaveBeenCalled();
  });
});
