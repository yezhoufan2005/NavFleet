import { describe, it, expect } from "vitest";
import request from "supertest";
import { DEFAULT_REPORTS_CONFIG } from "@navfleet/shared";
import type { ReportsConfig } from "../src/types";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * 定时报表写 API (1.6.1). The admin-only role gate is pinned in http-rbac; here we cover the
 * router → store wiring: GET /reports/config returns the schedule config, PUT /reports/config
 * validates-then-writes-then-audits, and a malformed body is a 400 (`invalid_reports`) that never
 * reaches the store.
 */
const ADMIN = sessionCookie("admin", "admin-1");

const CONFIG: ReportsConfig = {
  schedules: [
    {
      id: "daily-ops",
      enabled: true,
      range: "24h",
      time: "08:00",
      smtpEnv: "REPORTS_SMTP_URL",
      from: "reports@fleet.local",
      recipients: [{ email: "ops@fleet.local" }],
    },
  ],
};

describe("GET /api/reports/config", () => {
  it("returns the scheduled-report config from the store", async () => {
    const context = createTestApp();
    context.store.getReportsConfig.mockReturnValue(CONFIG);

    const response = await request(context.app).get("/api/reports/config").set("Cookie", ADMIN);

    expect(response.status).toBe(200);
    expect((response.body as { config: unknown }).config).toEqual(CONFIG);
  });
});

describe("PUT /api/reports/config", () => {
  it("validates, writes, and audits", async () => {
    const context = createTestApp();
    context.store.writeReportsConfig.mockResolvedValue(CONFIG);

    const response = await request(context.app)
      .put("/api/reports/config")
      .set("Cookie", ADMIN)
      .send(CONFIG);

    expect(response.status).toBe(200);
    expect((response.body as { config: unknown }).config).toEqual(CONFIG);
    expect(context.store.writeReportsConfig).toHaveBeenCalledTimes(1);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reports_write" }),
    );
  });

  it("rejects a malformed schedule with 400 invalid_reports and never writes", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .put("/api/reports/config")
      .set("Cookie", ADMIN)
      // time must be HH:MM — "8am" is malformed and rejected before disk.
      .send({
        schedules: [
          { id: "x", enabled: true, range: "24h", time: "8am", smtpEnv: "E", from: "a@b.c" },
        ],
      });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_reports");
    expect(context.store.writeReportsConfig).not.toHaveBeenCalled();
  });

  it("accepts an empty schedule list (zero-config = nothing sent)", async () => {
    const context = createTestApp();
    context.store.writeReportsConfig.mockResolvedValue(DEFAULT_REPORTS_CONFIG);

    const response = await request(context.app)
      .put("/api/reports/config")
      .set("Cookie", ADMIN)
      .send({ schedules: [] });

    expect(response.status).toBe(200);
    expect(context.store.writeReportsConfig).toHaveBeenCalledTimes(1);
  });
});
