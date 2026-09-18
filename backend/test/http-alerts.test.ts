import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * Alert acknowledgement API (Phase 16A). The role gate is pinned in http-rbac; here we cover
 * the router → persistence wiring: a matching active alert acks and broadcasts, an unknown or
 * cleared one is 404, a malformed body is 400, and each success emits one audit entry.
 *
 * Collaborators are stubbed — the persistence match/no-match is unit-tested in
 * persistence-mongo, the broadcast in store, and the audit write shape in persistence-mongo.
 */
const OPERATOR = sessionCookie("operator", "op-1");
const REF = { deviceId: "agv-01", alertId: "err-1" };

describe("POST /api/alerts/ack", () => {
  it("acks a matching active alert, audits it, broadcasts, and 204s", async () => {
    const context = createTestApp();
    context.persistence.ackAlert.mockResolvedValue(true);

    const response = await request(context.app)
      .post("/api/alerts/ack")
      .set("Cookie", OPERATOR)
      .send({ ...REF, comment: "看过了" });

    expect(response.status).toBe(204);
    // eventKey is assembled server-side from the body, never taken from a path segment.
    expect(context.persistence.ackAlert).toHaveBeenCalledWith(
      "agv-01:err-1",
      "op-1",
      "看过了",
      expect.any(Date),
    );
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "op-1",
        action: "alert_ack",
        target: "agv-01:err-1",
      }),
    );
    expect(context.store.broadcastAlertAck).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "agv-01", alertId: "err-1", ackedBy: "op-1" }),
    );
  });

  it("404s when no active alert matches — and neither audits nor broadcasts", async () => {
    const context = createTestApp();
    context.persistence.ackAlert.mockResolvedValue(false);

    const response = await request(context.app)
      .post("/api/alerts/ack")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(404);
    expect(context.auditService.record).not.toHaveBeenCalled();
    expect(context.store.broadcastAlertAck).not.toHaveBeenCalled();
  });

  it("400s a body missing deviceId/alertId, without touching persistence", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/alerts/ack")
      .set("Cookie", OPERATOR)
      .send({ deviceId: "agv-01" });

    expect(response.status).toBe(400);
    expect(context.persistence.ackAlert).not.toHaveBeenCalled();
  });

  it("omits the comment from the audit detail when none is given", async () => {
    const context = createTestApp();
    context.persistence.ackAlert.mockResolvedValue(true);

    await request(context.app).post("/api/alerts/ack").set("Cookie", OPERATOR).send(REF);

    expect(context.persistence.ackAlert).toHaveBeenCalledWith(
      "agv-01:err-1",
      "op-1",
      null,
      expect.any(Date),
    );
  });
});

describe("POST /api/alerts/unack", () => {
  it("unacks a matching alert, audits it, broadcasts, and 204s", async () => {
    const context = createTestApp();
    context.persistence.unackAlert.mockResolvedValue(true);

    const response = await request(context.app)
      .post("/api/alerts/unack")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(204);
    expect(context.persistence.unackAlert).toHaveBeenCalledWith("agv-01:err-1");
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert_unack", target: "agv-01:err-1" }),
    );
    expect(context.store.broadcastAlertUnack).toHaveBeenCalledWith({
      deviceId: "agv-01",
      alertId: "err-1",
    });
  });

  it("404s an unknown alert", async () => {
    const context = createTestApp();
    context.persistence.unackAlert.mockResolvedValue(false);

    const response = await request(context.app)
      .post("/api/alerts/unack")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(404);
    expect(context.store.broadcastAlertUnack).not.toHaveBeenCalled();
  });
});
