import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  DEVICE_ID,
  SCENE_ID,
  createTestApp,
  sampleAlert,
  sampleHistoryPoint,
  sessionCookie,
  type TestAppContext,
} from "./helpers/testApp";

const authed = (context: TestAppContext, path: string) =>
  request(context.app).get(path).set("Cookie", sessionCookie());

describe("GET /api/fleet/snapshot", () => {
  it("merges the summary into the fleet snapshot", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/fleet/snapshot");

    expect(response.status).toBe(200);
    const body = response.body as {
      summary: { deviceCount: number };
      devices: unknown[];
      formations: unknown[];
      fleetName: string;
    };
    expect(body.summary.deviceCount).toBe(1);
    expect(body.fleetName).toBe("测试车队");
    expect(body.devices).toHaveLength(1);
    expect(body.formations).toHaveLength(1);
    expect(context.store.buildSummary).toHaveBeenCalledOnce();
    expect(context.store.snapshot).toHaveBeenCalledOnce();
  });
});

describe("GET /api/formations", () => {
  it("returns the formation list under items", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/formations");

    expect(response.status).toBe(200);
    const body = response.body as { items: Array<{ formationId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].formationId).toBe("formation-a");
  });
});

describe("GET /api/scenes", () => {
  it("returns the scene list under items", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/scenes");

    expect(response.status).toBe(200);
    const body = response.body as { items: Array<{ sceneId: string }> };
    expect(body.items.map((scene) => scene.sceneId)).toEqual([SCENE_ID]);
  });
});

describe("GET /api/scenes/:sceneId", () => {
  it("returns the scene definition", async () => {
    const context = createTestApp();
    const response = await authed(context, `/api/scenes/${SCENE_ID}`);

    expect(response.status).toBe(200);
    expect((response.body as { sceneId: string }).sceneId).toBe(SCENE_ID);
    expect(context.store.getScene).toHaveBeenCalledWith(SCENE_ID);
  });

  it("returns 404 for an unknown scene", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/scenes/missing-scene");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "scene_not_found" });
  });
});

describe("GET /api/scenes/:sceneId/overlay", () => {
  it("returns the Lanelet2 overlay", async () => {
    const context = createTestApp();
    const response = await authed(context, `/api/scenes/${SCENE_ID}/overlay`);

    expect(response.status).toBe(200);
    const body = response.body as { sceneId: string; generator: string };
    expect(body.sceneId).toBe(SCENE_ID);
    expect(body.generator).toBe("lanelet2");
  });

  it("returns 404 when the scene has no overlay", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/scenes/missing-scene/overlay");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "scene_overlay_not_found" });
  });
});

describe("GET /api/devices/:deviceId/history", () => {
  it("returns the history points for the device", async () => {
    const context = createTestApp();
    const response = await authed(context, `/api/devices/${DEVICE_ID}/history`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deviceId: DEVICE_ID, items: [sampleHistoryPoint()] });
    expect(context.store.getHistory).toHaveBeenCalledWith(
      DEVICE_ID,
      undefined,
      undefined,
      undefined,
    );
  });

  it("forwards the validated from/to/limit window to the store", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/devices/${DEVICE_ID}/history?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=25`,
    );

    expect(response.status).toBe(200);
    // `limit` is coerced to a number by the schema; timestamps pass through as strings.
    expect(context.store.getHistory).toHaveBeenCalledWith(
      DEVICE_ID,
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      25,
    );
  });

  it("decodes a url-encoded device id before querying", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/devices/agv%2F1/history");

    expect(response.status).toBe(200);
    expect(context.store.getHistory).toHaveBeenCalledWith("agv/1", undefined, undefined, undefined);
  });
});

describe("GET /api/alerts", () => {
  it("returns the alert list under items", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/alerts");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [sampleAlert()] });
    expect(context.store.getAlerts).toHaveBeenCalledWith({});
  });

  it("forwards the validated filters to the store", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/alerts?severity=critical&status=active&deviceId=${DEVICE_ID}`,
    );

    expect(response.status).toBe(200);
    expect(context.store.getAlerts).toHaveBeenCalledWith({
      severity: "critical",
      status: "active",
      deviceId: DEVICE_ID,
    });
  });
});
