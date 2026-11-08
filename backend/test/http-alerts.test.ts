import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie, storedAlert } from "./helpers/testApp";

/**
 * Message disposition API (claim / release / ignore / unignore). The role gate is pinned in
 * http-rbac; here we cover the router → persistence wiring: a successful write audits, broadcasts
 * and returns the disposition; a missing occurrence is 404; a version conflict is 409 with the
 * current holder; a malformed body is 400. Collaborators are stubbed — the persistence state
 * machine and optimistic lock are unit-tested in persistence-mongo.
 */
const OPERATOR = sessionCookie("operator", "op-1");
const REF = { deviceId: "agv-01", alertId: "err-1" };

describe("POST /api/alerts/claim", () => {
  it("claims an active occurrence, audits, broadcasts and returns the disposition", async () => {
    const context = createTestApp();
    context.persistence.claimAlert.mockResolvedValue({
      ok: true,
      alert: storedAlert({ claimedBy: "op-1", claimedAt: "2026-01-01T00:00:00.000Z", version: 1 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/claim")
      .set("Cookie", OPERATOR)
      .send({ ...REF, version: 0 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      deviceId: "agv-01",
      alertId: "err-1",
      disposition: "investigating",
      claimedBy: "op-1",
      version: 1,
    });
    // eventKey is assembled server-side from the body, never taken from a path segment.
    expect(context.persistence.claimAlert).toHaveBeenCalledWith(
      "agv-01:err-1",
      "op-1",
      expect.any(Date),
      0,
    );
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "op-1", action: "alert_claim", target: "agv-01:err-1" }),
    );
    expect(context.store.broadcastAlertDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "agv-01", alertId: "err-1", claimedBy: "op-1" }),
    );
  });

  it("409s a version conflict with the current holder, neither auditing nor broadcasting", async () => {
    const context = createTestApp();
    context.persistence.claimAlert.mockResolvedValue({
      ok: false,
      error: "already_claimed",
      current: storedAlert({ claimedBy: "zhaoyun", version: 1 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/claim")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "already_claimed",
      current: { claimedBy: "zhaoyun", disposition: "investigating" },
    });
    expect(context.auditService.record).not.toHaveBeenCalled();
    expect(context.store.broadcastAlertDisposition).not.toHaveBeenCalled();
  });

  it("404s when no active occurrence matches", async () => {
    const context = createTestApp();
    context.persistence.claimAlert.mockResolvedValue({
      ok: false,
      error: "not_found",
      current: null,
    });

    const response = await request(context.app)
      .post("/api/alerts/claim")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(404);
  });

  it("400s a body missing deviceId/alertId, without touching persistence", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/alerts/claim")
      .set("Cookie", OPERATOR)
      .send({ deviceId: "agv-01" });

    expect(response.status).toBe(400);
    expect(context.persistence.claimAlert).not.toHaveBeenCalled();
  });
});

describe("POST /api/alerts/release", () => {
  it("releases a claim (passes the actor and admin flag) and returns unhandled", async () => {
    const context = createTestApp();
    context.persistence.releaseAlert.mockResolvedValue({
      ok: true,
      alert: storedAlert({ version: 2 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/release")
      .set("Cookie", OPERATOR)
      .send({ ...REF, version: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ disposition: "unhandled", version: 2 });
    expect(context.persistence.releaseAlert).toHaveBeenCalledWith("agv-01:err-1", "op-1", false, 1);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert_release", target: "agv-01:err-1" }),
    );
  });

  it("403s when the caller is not the claimant", async () => {
    const context = createTestApp();
    context.persistence.releaseAlert.mockResolvedValue({
      ok: false,
      error: "not_claimant",
      current: storedAlert({ claimedBy: "zhaoyun", version: 1 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/release")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(403);
    expect(context.store.broadcastAlertDisposition).not.toHaveBeenCalled();
  });
});

describe("POST /api/alerts/ignore", () => {
  it("ignores an occurrence with an optional reason and returns ignored", async () => {
    const context = createTestApp();
    context.persistence.ignoreAlert.mockResolvedValue({
      ok: true,
      alert: storedAlert({ ignoredBy: "op-1", ignoreReason: "噪声", version: 1 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/ignore")
      .set("Cookie", OPERATOR)
      .send({ ...REF, reason: "噪声" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ disposition: "ignored", ignoredBy: "op-1" });
    expect(context.persistence.ignoreAlert).toHaveBeenCalledWith(
      "agv-01:err-1",
      "op-1",
      "噪声",
      expect.any(Date),
      undefined,
    );
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert_ignore", target: "agv-01:err-1" }),
    );
  });

  it("passes null when no reason is given", async () => {
    const context = createTestApp();
    context.persistence.ignoreAlert.mockResolvedValue({ ok: true, alert: storedAlert() });
    await request(context.app).post("/api/alerts/ignore").set("Cookie", OPERATOR).send(REF);
    expect(context.persistence.ignoreAlert).toHaveBeenCalledWith(
      "agv-01:err-1",
      "op-1",
      null,
      expect.any(Date),
      undefined,
    );
  });
});

describe("POST /api/alerts/unignore", () => {
  it("cancels an ignore and returns unhandled", async () => {
    const context = createTestApp();
    context.persistence.unignoreAlert.mockResolvedValue({
      ok: true,
      alert: storedAlert({ version: 2 }),
    });

    const response = await request(context.app)
      .post("/api/alerts/unignore")
      .set("Cookie", OPERATOR)
      .send(REF);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ disposition: "unhandled" });
    expect(context.persistence.unignoreAlert).toHaveBeenCalledWith("agv-01:err-1", undefined);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert_unignore", target: "agv-01:err-1" }),
    );
  });

  it("404s an unknown occurrence", async () => {
    const context = createTestApp();
    context.persistence.unignoreAlert.mockResolvedValue({
      ok: false,
      error: "not_found",
      current: null,
    });
    const response = await request(context.app)
      .post("/api/alerts/unignore")
      .set("Cookie", OPERATOR)
      .send(REF);
    expect(response.status).toBe(404);
  });
});
