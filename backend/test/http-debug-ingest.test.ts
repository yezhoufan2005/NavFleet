import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  DEVICE_ID,
  createTestApp,
  sessionCookie,
  type TestAppContext,
  type ValidationErrorBody,
} from "./helpers/testApp";

const ingest = (context: TestAppContext, role: "admin" | "operator" | "viewer") =>
  request(context.app).post("/api/debug/ingest").set("Cookie", sessionCookie(role));

describe("POST /api/debug/ingest", () => {
  it("returns 404 for an admin when DEBUG_INGEST_ENABLED is off", async () => {
    const context = createTestApp();
    const response = await ingest(context, "admin").send({ deviceId: DEVICE_ID });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
    expect(context.store.applyPayload).not.toHaveBeenCalled();
  });

  it.each(["operator", "viewer"] as const)(
    "returns 403 for the %s role even when the flag is on",
    async (role) => {
      const context = createTestApp({ configOverrides: { debugIngestEnabled: true } });
      const response = await ingest(context, role).send({ deviceId: DEVICE_ID });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "forbidden", requiredRoles: ["admin"] });
      expect(context.store.applyPayload).not.toHaveBeenCalled();
    },
  );

  it("checks the role before the feature flag", async () => {
    // requireRole runs as route middleware, ahead of the flag check in the
    // handler, so a non-admin sees 403 rather than leaking that it is disabled.
    const context = createTestApp();
    const response = await ingest(context, "viewer").send({ deviceId: DEVICE_ID });

    expect(response.status).toBe(403);
  });

  it("ingests a payload for an admin when the flag is on", async () => {
    const context = createTestApp({ configOverrides: { debugIngestEnabled: true } });
    const payload = { deviceId: DEVICE_ID, stamp: 1, fusion_loc: { x: 1 } };
    const response = await ingest(context, "admin").send(payload);

    expect(response.status).toBe(200);
    expect(context.store.applyPayload).toHaveBeenCalledWith(payload, "debug-api", {
      allowReplace: true,
    });
    // The route answers with the resulting fleet snapshot.
    expect((response.body as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it("accepts an array payload", async () => {
    const context = createTestApp({ configOverrides: { debugIngestEnabled: true } });
    const response = await ingest(context, "admin").send([{ deviceId: DEVICE_ID }]);

    expect(response.status).toBe(200);
    expect(context.store.applyPayload).toHaveBeenCalledWith(
      [{ deviceId: DEVICE_ID }],
      "debug-api",
      {
        allowReplace: true,
      },
    );
  });

  it("rejects a missing body with a 400 validation error", async () => {
    const context = createTestApp({ configOverrides: { debugIngestEnabled: true } });
    const response = await ingest(context, "admin");

    expect(response.status).toBe(400);
    const body = response.body as ValidationErrorBody;
    expect(body.error).toBe("invalid_request");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(context.store.applyPayload).not.toHaveBeenCalled();
  });
});
