import { describe, it, expect } from "vitest";
import request from "supertest";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";
import type { AlertRulesConfig } from "../src/types";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * 告警规则写 API (1.6.1). The admin-only role gate is pinned in http-rbac; here we cover the
 * router → store wiring: GET /rules/config returns the effective rules, PUT /rules/config
 * validates-then-writes-then-audits, and a malformed body is a 400 (`invalid_rules`) that never
 * reaches the store.
 */
const ADMIN = sessionCookie("admin", "admin-1");

const RULES: AlertRulesConfig = {
  lowBattery: { enabled: true, thresholdPct: 15, debounceSeconds: 30 },
  offline: { enabled: true, afterSeconds: 90 },
};

describe("GET /api/rules/config", () => {
  it("returns the effective alert rules from the store", async () => {
    const context = createTestApp();
    context.store.getAlertRules.mockReturnValue(RULES);

    const response = await request(context.app).get("/api/rules/config").set("Cookie", ADMIN);

    expect(response.status).toBe(200);
    expect((response.body as { config: unknown }).config).toEqual(RULES);
  });
});

describe("PUT /api/rules/config", () => {
  it("validates, writes, and audits", async () => {
    const context = createTestApp();
    context.store.writeAlertRules.mockResolvedValue(RULES);

    const response = await request(context.app)
      .put("/api/rules/config")
      .set("Cookie", ADMIN)
      .send(RULES);

    expect(response.status).toBe(200);
    expect((response.body as { config: unknown }).config).toEqual(RULES);
    expect(context.store.writeAlertRules).toHaveBeenCalledTimes(1);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rules_write" }),
    );
  });

  it("rejects a malformed body with 400 invalid_rules and never writes", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .put("/api/rules/config")
      .set("Cookie", ADMIN)
      // thresholdPct must be a number — a string is malformed and rejected before disk.
      .send({ lowBattery: { thresholdPct: "low" } });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_rules");
    expect(context.store.writeAlertRules).not.toHaveBeenCalled();
  });

  it("accepts a body that omits fields (defaults fill in)", async () => {
    const context = createTestApp();
    context.store.writeAlertRules.mockResolvedValue(DEFAULT_ALERT_RULES);

    const response = await request(context.app)
      .put("/api/rules/config")
      .set("Cookie", ADMIN)
      .send({});

    expect(response.status).toBe(200);
    expect(context.store.writeAlertRules).toHaveBeenCalledTimes(1);
  });
});
