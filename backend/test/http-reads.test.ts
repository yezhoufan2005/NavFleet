import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  DEVICE_ID,
  SCENE_ID,
  createTestApp,
  sampleAlert,
  sampleAlertStatsReport,
  sampleAvailabilityReport,
  sampleHistoryPoint,
  sessionCookie,
  type TestAppContext,
} from "./helpers/testApp";
import { config } from "../src/config";

const anyIso: unknown = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

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
    expect(body.items[0]?.formationId).toBe("formation-a");
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

  it("spreads a whole window over the cap when sampling=even", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/devices/${DEVICE_ID}/history?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&sampling=even`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      deviceId: DEVICE_ID,
      items: [sampleHistoryPoint()],
      total: 1,
      sampled: false,
    });
    expect(context.store.sampleHistory).toHaveBeenCalledWith(
      DEVICE_ID,
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
    );
    expect(context.store.getHistory).not.toHaveBeenCalled();
  });

  it("refuses sampling=even without both window bounds", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/devices/${DEVICE_ID}/history?from=2026-01-01T00:00:00Z&sampling=even`,
    );
    expect(response.status).toBe(400);
    expect(context.store.sampleHistory).not.toHaveBeenCalled();
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
    expect(response.body).toEqual({ items: [sampleAlert()], truncated: false, limit: 500 });
    expect(response.headers["x-result-truncated"]).toBeUndefined();
    expect(context.store.getAlerts).toHaveBeenCalledWith({});
  });

  it("says when the list hit the server cap", async () => {
    const context = createTestApp();
    context.store.getAlerts.mockResolvedValue(Array.from({ length: 500 }, () => sampleAlert()));
    const response = await authed(context, "/api/alerts");
    expect((response.body as { truncated: boolean }).truncated).toBe(true);
    expect(response.headers["x-result-truncated"]).toBe("true");
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

describe("GET /api/reports/alerts", () => {
  it("returns the aggregated report as the response body (viewer+, no envelope)", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/reports/alerts");

    expect(response.status).toBe(200);
    // The report is the body itself, not wrapped in `{ items }` — it is one object, not a list.
    expect(response.body).toEqual(sampleAlertStatsReport());
    // No `from`: the window starts REPORT_MAX_RANGE_DAYS back, not at the first stored row.
    expect(context.store.getAlertStats).toHaveBeenCalledWith({ from: anyIso });
    const [{ from }] = context.store.getAlertStats.mock.calls[0] as [{ from: string }];
    const days = (Date.now() - Date.parse(from)) / 86_400_000;
    expect(days).toBeCloseTo(config.reportMaxRangeDays, 0);
  });

  it("refuses a seconds epoch window wider than the cap, read the way the query reads it", async () => {
    // 1600000000 → 1760000000 is five years in seconds; read as milliseconds it was two days.
    const context = createTestApp();
    const response = await authed(context, "/api/reports/alerts?from=1600000000&to=1760000000");
    expect(response.status).toBe(400);
    expect(context.store.getAlertStats).not.toHaveBeenCalled();
  });

  it("forwards the validated from/to window to the store", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      "/api/reports/alerts?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z",
    );

    expect(response.status).toBe(200);
    expect(context.store.getAlertStats).toHaveBeenCalledWith({
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-30T00:00:00Z",
    });
  });

  it("rejects an unparseable bound with 400 rather than passing it through", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/reports/alerts?from=not-a-time");

    expect(response.status).toBe(400);
    expect(context.store.getAlertStats).not.toHaveBeenCalled();
  });
});

describe("GET /api/reports/availability", () => {
  it("returns the report and defaults the bucket to day", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/reports/availability");

    expect(response.status).toBe(200);
    // With the zone the buckets were cut in, so an export can write them as local times.
    expect(response.body).toEqual({
      ...sampleAvailabilityReport(),
      timeZone: config.reportTimezone,
    });
    // The schema fills in the default, so the store always receives an explicit bucket.
    expect(context.store.getAvailabilityReport).toHaveBeenCalledWith({
      bucket: "day",
      from: anyIso,
    });
  });

  it("forwards device, range and an explicit bucket", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/reports/availability?deviceId=${DEVICE_ID}&from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z&bucket=hour`,
    );

    expect(response.status).toBe(200);
    expect(context.store.getAvailabilityReport).toHaveBeenCalledWith({
      deviceId: [DEVICE_ID],
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-30T00:00:00Z",
      bucket: "hour",
    });
  });

  it("parses a comma-joined device list into a set", async () => {
    const context = createTestApp();
    const response = await authed(
      context,
      `/api/reports/availability?deviceId=${DEVICE_ID},agv-other`,
    );

    expect(response.status).toBe(200);
    expect(context.store.getAvailabilityReport).toHaveBeenCalledWith({
      deviceId: [DEVICE_ID, "agv-other"],
      bucket: "day",
      from: anyIso,
    });
  });

  it("rejects an unknown bucket with 400", async () => {
    const context = createTestApp();
    const response = await authed(context, "/api/reports/availability?bucket=week");

    expect(response.status).toBe(400);
    expect(context.store.getAvailabilityReport).not.toHaveBeenCalled();
  });
});
