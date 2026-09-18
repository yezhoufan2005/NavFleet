import { describe, it, expect } from "vitest";
import request from "supertest";
import type { NotifyChannelView, NotifySendRecord } from "../src/types";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * 告警外发 read API (Phase 16D-1). The admin-only role gate is pinned in http-rbac; here we
 * cover the router → service wiring: GET /notify/log passes validated filters through and
 * returns the records, GET /notify/config returns the (already-redacted) channel views, and a
 * bad query filter is a 400 that never reaches the service.
 */
const ADMIN = sessionCookie("admin", "admin-1");

const RECORD: NotifySendRecord = {
  ts: "2026-09-19T00:00:00.000Z",
  eventKey: "agv-1:agv-1-offline",
  channelId: "ops-webhook",
  channelType: "webhook",
  deviceId: "agv-1",
  alertId: "agv-1-offline",
  severity: "critical",
  title: "设备离线",
  status: "failed",
  httpStatus: 503,
  attempts: 3,
  latencyMs: 42,
  error: "HTTP 503",
};

const VIEW: NotifyChannelView = {
  id: "ops-webhook",
  type: "webhook",
  enabled: true,
  severities: ["critical", "warning", "notice"],
  configured: true,
};

describe("GET /api/notify/log", () => {
  it("passes filters through and returns the records", async () => {
    const context = createTestApp();
    context.notifyService.queryLog.mockResolvedValue([RECORD]);

    const response = await request(context.app)
      .get("/api/notify/log?deviceId=agv-1&status=failed")
      .set("Cookie", ADMIN);

    expect(response.status).toBe(200);
    expect((response.body as { items: unknown[] }).items).toEqual([RECORD]);
    expect(context.notifyService.queryLog).toHaveBeenCalledWith({
      deviceId: "agv-1",
      status: "failed",
    });
  });

  it("rejects an unknown status with a 400 and never calls the service", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .get("/api/notify/log?status=bogus")
      .set("Cookie", ADMIN);

    expect(response.status).toBe(400);
    expect(context.notifyService.queryLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/notify/config", () => {
  it("returns the effective channels (redacted view from the service)", async () => {
    const context = createTestApp();
    context.notifyService.effectiveConfig.mockReturnValue([VIEW]);

    const response = await request(context.app).get("/api/notify/config").set("Cookie", ADMIN);

    expect(response.status).toBe(200);
    expect((response.body as { channels: unknown[] }).channels).toEqual([VIEW]);
    // The wire shape carries no endpoint URL / env-var name.
    expect(JSON.stringify(response.body)).not.toContain("urlEnv");
  });
});
