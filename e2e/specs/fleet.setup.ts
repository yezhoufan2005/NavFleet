/**
 * Seeds the fleet before any spec runs (the `seed` project the `chromium`
 * project depends on).
 *
 * Telemetry goes in over `POST /api/debug/ingest` with an admin session, which
 * runs the frames through exactly the same normalization, alert derivation and
 * persistence path as MQTT — so no broker and no demo publisher are involved,
 * and the resulting fleet is byte-for-byte deterministic.
 */

import { expect, test as setup } from "@playwright/test";
import { ADMIN } from "../support/harness";
import {
  SAMPLES_PER_DEVICE,
  SEEDED_DEVICES,
  buildSeedFrames,
} from "../support/seed";

setup("seed the demo fleet over debug ingest", async ({ request }) => {
  const login = await request.post("/api/auth/login", { data: ADMIN });
  expect(login.status(), "admin login for seeding").toBe(200);

  const frames = buildSeedFrames();
  for (const frame of frames) {
    const response = await request.post("/api/debug/ingest", { data: frame });
    expect(
      response.status(),
      `ingest ${frame.deviceId} (a 404 means the backend under test has DEBUG_INGEST_ENABLED off)`,
    ).toBe(200);
  }

  const snapshot = await request.get("/api/fleet/snapshot");
  expect(snapshot.status()).toBe(200);
  const body = (await snapshot.json()) as {
    devices: { deviceId: string; deviceName: string; alerts: unknown[] }[];
  };
  expect(body.devices.map((device) => device.deviceId).sort()).toEqual(
    SEEDED_DEVICES.map((device) => device.deviceId).sort(),
  );

  // Each frame is retained, so history playback has something to replay.
  const history = await request.get(
    `/api/devices/${SEEDED_DEVICES[0].deviceId}/history?limit=100`,
  );
  expect(history.status()).toBe(200);
  const historyBody = (await history.json()) as { items: unknown[] };
  expect(historyBody.items.length).toBe(SAMPLES_PER_DEVICE);
});
