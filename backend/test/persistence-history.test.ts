import { describe, it, expect } from "vitest";
import { Persistence } from "../src/persistence";
import type { DeviceSnapshot } from "../src/types";

function sample(deviceId: string, stamp: string, x: number): DeviceSnapshot {
  return {
    deviceId,
    deviceName: deviceId,
    topic: `/fleet/${deviceId}/vehicle_info`,
    stamp,
    online: true,
    sceneId: "",
    runtimeSceneId: "",
    defaultSceneId: "",
    mapProfile: "lanelet",
    gpsEnabled: true,
    rosMapEnabled: true,
    tags: [],
    formationIds: [],
    gps: { lat: null, lng: null, heading: null },
    fusionLoc: { x, y: x, yaw: 0 },
    lidarLoc: { x: null, y: null, yaw: null },
    vehicleInfo: { controlMode: null, gear: null, speed: 1, omega: null, soc: 80 },
    taskStatus: 1,
    platformTaskStatus: null,
    infoCode: { code: 0, info: "", stamp: null },
    warningCode: { code: 0, info: "", stamp: null },
    errorCode: { code: 0, info: "", stamp: null },
    speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
    alerts: [],
    extra: {},
  } as DeviceSnapshot;
}

describe("Persistence in-memory history fallback", () => {
  it("serves recent telemetry without Mongo, newest-first, time-filtered and limited", async () => {
    // Never call connect(): db stays null, so the in-memory buffer is exercised.
    const persistence = new Persistence();
    await persistence.writeTelemetry(sample("agv-x", "2026-01-01T00:00:00Z", 1));
    await persistence.writeTelemetry(sample("agv-x", "2026-01-01T00:00:10Z", 2));
    await persistence.writeTelemetry(sample("agv-y", "2026-01-01T00:00:05Z", 9));

    const all = (await persistence.queryHistory({ deviceId: "agv-x" })) as Array<{
      measurements: { fusionLoc: { x: number } };
    }>;
    expect(all).toHaveLength(2);
    // Newest-first, matching the Mongo query contract.
    expect(all[0].measurements.fusionLoc.x).toBe(2);

    // Per-device isolation.
    expect(await persistence.queryHistory({ deviceId: "agv-y" })).toHaveLength(1);

    // Time-window filtering (inclusive lower bound).
    const windowed = (await persistence.queryHistory({
      deviceId: "agv-x",
      from: "2026-01-01T00:00:05Z",
    })) as Array<{ measurements: { fusionLoc: { x: number } } }>;
    expect(windowed).toHaveLength(1);
    expect(windowed[0].measurements.fusionLoc.x).toBe(2);

    // Limit is honoured.
    expect(await persistence.queryHistory({ deviceId: "agv-x", limit: 1 })).toHaveLength(1);
  });

  it("accepts numeric epoch bounds (ms and seconds) for from/to", async () => {
    const persistence = new Persistence();
    await persistence.writeTelemetry(sample("agv-e", "2026-01-01T00:00:00Z", 1));
    await persistence.writeTelemetry(sample("agv-e", "2026-01-01T00:00:10Z", 2));

    const cutoff = Date.parse("2026-01-01T00:00:05Z");
    const byMillis = (await persistence.queryHistory({
      deviceId: "agv-e",
      from: String(cutoff),
    })) as unknown[];
    expect(byMillis).toHaveLength(1);

    const bySeconds = (await persistence.queryHistory({
      deviceId: "agv-e",
      from: String(Math.floor(cutoff / 1000)),
    })) as unknown[];
    expect(bySeconds).toHaveLength(1);
  });
});

describe("Persistence in-memory alerts fallback", () => {
  it("serves active alerts from memory without Mongo and applies filters", async () => {
    const persistence = new Persistence();
    await persistence.upsertAlerts("agv-a", [
      {
        id: "agv-a-low-soc",
        title: "低电量预警",
        detail: "当前电量偏低",
        severity: "warning",
        source: "rule-engine",
        ts: "2026-01-01T00:00:00Z",
      },
    ]);

    const all = (await persistence.queryAlerts({})) as Array<{
      deviceId: string;
      alertId: string;
      severity: string;
    }>;
    expect(all).toHaveLength(1);
    expect(all[0].deviceId).toBe("agv-a");
    expect(all[0].alertId).toBe("agv-a-low-soc");

    // Severity filter and the cleared-status filter both narrow the set.
    expect(await persistence.queryAlerts({ severity: "critical" })).toHaveLength(0);
    expect(await persistence.queryAlerts({ status: "cleared" })).toHaveLength(0);

    // A subsequent upsert with an empty set clears the device's active alerts.
    await persistence.upsertAlerts("agv-a", []);
    expect(await persistence.queryAlerts({})).toHaveLength(0);
  });
});

describe("the write-behind buffer while MongoDB is unavailable (P0-c)", () => {
  it("buffers telemetry instead of dropping it on the floor", async () => {
    // `db` stays null, which is exactly the "database is down" case. This used to be a
    // bare `return` after the in-memory append: every frame that arrived while MongoDB
    // was unreachable was gone, and the reconnect path only flushed what a *failed write*
    // had buffered — a set that stays empty while there is no connection to fail against.
    const persistence = new Persistence();
    await persistence.writeTelemetry(sample("agv-buf", "2026-01-01T00:00:00Z", 1));
    await persistence.writeTelemetry(sample("agv-buf", "2026-01-01T00:00:01Z", 2));

    expect(persistence.pendingTelemetryCount()).toBe(2);
    expect(persistence.telemetryBufferStats()).toMatchObject({ pending: 2, dropped: 0 });
  });

  it("counts what the cap forces out, rather than dropping it silently", async () => {
    // The overflow used to `splice` the oldest away with no counter anywhere, so a
    // monitoring platform lost data and nothing on any dashboard said so.
    const persistence = new Persistence();
    const limit = persistence.telemetryBufferStats().limit;
    for (let index = 0; index < limit + 5; index += 1) {
      await persistence.writeTelemetry(
        sample("agv-full", new Date(1_760_000_000_000 + index * 1000).toISOString(), index),
      );
    }

    const stats = persistence.telemetryBufferStats();
    expect(stats.pending).toBe(limit);
    expect(stats.dropped).toBe(5);
  });

  it("flushing without a database is a no-op that keeps the buffer intact", async () => {
    // The shutdown path calls this unconditionally; it must not lose the buffer just
    // because there is nowhere to put it yet.
    const persistence = new Persistence();
    await persistence.writeTelemetry(sample("agv-keep", "2026-01-01T00:00:00Z", 1));
    await persistence.flushTelemetry();

    expect(persistence.pendingTelemetryCount()).toBe(1);
  });
});
