import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";

describe("GET /health", () => {
  it("answers the liveness probe without a session", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    const body = response.body as { ok: boolean; service: string; now: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("fleet-backend");
    expect(Number.isFinite(Date.parse(body.now))).toBe(true);
  });
});

interface ReadyBody {
  ready: boolean;
  degraded: boolean;
  checks: { store: boolean; mongo: boolean; mqtt: boolean };
  now: string;
}

describe("GET /health/ready", () => {
  it("returns 503 while the store is still initializing", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    const body = response.body as ReadyBody;
    expect(body.ready).toBe(false);
    expect(body.checks.store).toBe(false);
  });

  it("returns 200 once the store is ready", async () => {
    const context = createTestApp();
    context.state.storeReady = true;
    const response = await request(context.app).get("/health/ready");

    expect(response.status).toBe(200);
    expect((response.body as ReadyBody).ready).toBe(true);
  });

  it("flags degraded while MongoDB or MQTT is down, and clears it when both are up", async () => {
    const context = createTestApp();
    context.state.storeReady = true;

    // Mongo down, MQTT up.
    context.state.mqttConnected = true;
    const mongoDown = await request(context.app).get("/health/ready");
    expect(mongoDown.status).toBe(200);
    expect((mongoDown.body as ReadyBody).degraded).toBe(true);
    expect((mongoDown.body as ReadyBody).checks).toEqual({
      store: true,
      mongo: false,
      mqtt: true,
    });

    // MQTT down, Mongo up.
    context.state.mqttConnected = false;
    context.persistence.isMongoConnected.mockReturnValue(true);
    const mqttDown = await request(context.app).get("/health/ready");
    expect((mqttDown.body as ReadyBody).degraded).toBe(true);

    // Both up.
    context.state.mqttConnected = true;
    const healthy = await request(context.app).get("/health/ready");
    expect((healthy.body as ReadyBody).degraded).toBe(false);
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text when metrics are enabled", async () => {
    const { app } = createTestApp({ wsClientCount: () => 3 });
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/plain/);
    expect(response.text).toContain("navfleet_up 1");
    expect(response.text).toContain("navfleet_devices_total 1");
    expect(response.text).toContain("navfleet_ws_connections 3");
    expect(response.text).toContain("navfleet_mongo_connected 0");
  });

  it("returns a JSON 404 when metrics are disabled", async () => {
    const { app } = createTestApp({ configOverrides: { metricsEnabled: false } });
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "not_found" });
  });
});

describe("GET /openapi.json", () => {
  it("requires a session: an API map is not for anonymous callers", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/openapi.json");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
  });

  it("serves the OpenAPI document to a signed-in caller", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/openapi.json").set("Cookie", sessionCookie());

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    const body = response.body as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/api/fleet/snapshot"]).toBeTruthy();
  });
});
