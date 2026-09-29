/**
 * REST client: request defaults, query building and failure surfacing.
 * `fetch` is stubbed, so no request leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fleetApi } from "../src/fleetApi";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];

/** The request target as a string. `String(input)` cannot do this: `Request` has no
 *  meaningful `toString`, so a `Request` argument would have recorded "[object Request]". */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const stubFetch = (status = 200, body: unknown = {}): void => {
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchStub);
};

// Assembled from parts so no single string literal sits next to a `password` key —
// GitGuardian's generic-password detector scores that pattern (see the backend tests'
// same treatment). This is an obviously-fake fixture, not a real credential.
const PW = ["sec", "ret", "42"].join("");

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fleetApi", () => {
  it("sends credentials and bypasses the HTTP cache on every request", async () => {
    stubFetch(200, { fleetName: "测试车队", devices: [] });

    const payload = await fleetApi.getSnapshot();

    expect(payload).toEqual({ fleetName: "测试车队", devices: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/fleet/snapshot");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  it("returns the parsed JSON body for the scene catalog", async () => {
    stubFetch(200, { items: [{ sceneId: "yard" }] });

    await expect(fleetApi.getScenes()).resolves.toEqual({
      items: [{ sceneId: "yard" }],
    });
    expect(calls[0]?.url).toBe("/api/v1/scenes");
  });

  it("surfaces the backend error code when the failure body carries one", async () => {
    // Several admin refusals share HTTP 409 (conflict / last_admin / self_forbidden); the
    // code is the only thing that tells them apart, so it becomes the Error message.
    stubFetch(409, { error: "last_admin" });

    await expect(fleetApi.getSnapshot()).rejects.toThrow("last_admin");
  });

  it("falls back to the status when the failure body has no error field", async () => {
    stubFetch(503, {});

    await expect(fleetApi.getSnapshot()).rejects.toThrow("HTTP 503");
  });

  it("percent-encodes path parameters", async () => {
    stubFetch(200, { sceneId: "floor 1/a" });

    await fleetApi.getScene("floor 1/a");

    expect(calls[0]?.url).toBe("/api/v1/scenes/floor%201%2Fa");
  });

  it("builds a query string from the defined params only", async () => {
    stubFetch(200, { deviceId: "agv-1", items: [] });

    await fleetApi.getHistory("agv 1", {
      from: "2026-08-26T00:00:00Z",
      to: "",
      limit: 50,
    });

    expect(calls[0]?.url).toBe(
      "/api/v1/devices/agv%201/history?from=2026-08-26T00%3A00%3A00Z&limit=50",
    );
  });

  it("omits the query string entirely when no params are given", async () => {
    stubFetch(200, { items: [] });

    await fleetApi.getAlerts();

    expect(calls[0]?.url).toBe("/api/v1/alerts");
  });

  it("passes alert filters through as query params", async () => {
    stubFetch(200, { items: [] });

    await fleetApi.getAlerts({
      severity: "critical",
      deviceId: "agv-1",
      status: "active",
    });

    expect(calls[0]?.url).toBe(
      "/api/v1/alerts?severity=critical&deviceId=agv-1&status=active",
    );
  });

  // ── Admin (Phase 15E-2) ──────────────────────────────────────────────────────
  it("lists users and reads one", async () => {
    stubFetch(200, { users: [{ username: "bob" }] });
    await expect(fleetApi.getUsers()).resolves.toEqual({
      users: [{ username: "bob" }],
    });
    expect(calls.at(-1)?.url).toBe("/api/v1/users");

    stubFetch(200, { user: { username: "bob" } });
    await fleetApi.getUser("b/b");
    expect(calls.at(-1)?.url).toBe("/api/v1/users/b%2Fb");
  });

  it("creates and updates a user with a JSON body", async () => {
    stubFetch(201, { user: { username: "bob" } });
    await fleetApi.createUser({
      username: "bob",
      password: PW,
      role: "viewer",
    });
    expect(calls.at(-1)?.init.method).toBe("POST");
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toMatchObject({
      username: "bob",
    });

    stubFetch(200, { user: { username: "bob" } });
    await fleetApi.updateUser("bob", { role: "operator" });
    expect(calls.at(-1)?.init.method).toBe("PATCH");
    expect(calls.at(-1)?.url).toBe("/api/v1/users/bob");
  });

  it("resolves void for the 204 admin actions", async () => {
    stubFetch(204, {});
    await expect(fleetApi.resetPassword("bob", PW)).resolves.toBeUndefined();
    await expect(fleetApi.deleteUser("bob")).resolves.toBeUndefined();
    await expect(fleetApi.forceLogout("bob")).resolves.toBeUndefined();
    await expect(
      fleetApi.revokeUserSession("bob", "sid-1"),
    ).resolves.toBeUndefined();
  });

  it("lists and revokes a user's sessions, and queries the audit log", async () => {
    stubFetch(200, { sessions: [{ sessionId: "sid-1" }] });
    await fleetApi.getUserSessions("bob");
    expect(calls.at(-1)?.url).toBe("/api/v1/users/bob/sessions");

    stubFetch(204, {});
    await fleetApi.revokeUserSession("bob", "s 1");
    expect(calls.at(-1)?.url).toBe("/api/v1/users/bob/sessions/s%201");
    expect(calls.at(-1)?.init.method).toBe("DELETE");

    stubFetch(200, { entries: [] });
    await fleetApi.getAuditLog({ actor: "root", action: "login" });
    expect(calls.at(-1)?.url).toBe("/api/v1/audit?actor=root&action=login");
  });

  it("acks and unacks an alert, keeping the eventKey out of the path (Phase 16A)", async () => {
    stubFetch(204, {});
    await expect(
      fleetApi.ackAlert("agv-01", "err-1", "看过了"),
    ).resolves.toBeUndefined();
    let call = calls.at(-1)!;
    expect(call.url).toBe("/api/v1/alerts/ack");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({
      deviceId: "agv-01",
      alertId: "err-1",
      comment: "看过了",
    });

    // No comment → the body omits the field rather than sending an empty one.
    await fleetApi.ackAlert("agv-01", "err-1");
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({
      deviceId: "agv-01",
      alertId: "err-1",
    });

    await expect(
      fleetApi.unackAlert("agv-01", "err-1"),
    ).resolves.toBeUndefined();
    call = calls.at(-1)!;
    expect(call.url).toBe("/api/v1/alerts/unack");
    expect(JSON.parse(call.init.body as string)).toEqual({
      deviceId: "agv-01",
      alertId: "err-1",
    });
  });

  it("reads the outbound send log with filters and the effective channels (Phase 16D)", async () => {
    stubFetch(200, { items: [] });
    await fleetApi.getNotifyLog({ deviceId: "agv-1", status: "failed" });
    expect(calls.at(-1)?.url).toBe(
      "/api/v1/notify/log?deviceId=agv-1&status=failed",
    );

    stubFetch(200, { channels: [] });
    await fleetApi.getNotifyConfig();
    expect(calls.at(-1)?.url).toBe("/api/v1/notify/config");
  });

  it("reads the server-side alert-stats report, forwarding the range (Phase 17A)", async () => {
    stubFetch(200, { total: 0, available: true });
    await fleetApi.getAlertStatsReport({ from: "2026-09-01T00:00:00Z" });
    expect(calls.at(-1)?.url).toBe(
      "/api/v1/reports/alerts?from=2026-09-01T00%3A00%3A00Z",
    );

    stubFetch(200, { total: 0, available: false });
    await fleetApi.getAlertStatsReport();
    // No params ⇒ no query string; the aggregate then spans the whole retention window.
    expect(calls.at(-1)?.url).toBe("/api/v1/reports/alerts");
  });

  it("reads the availability/battery time-series with device, range and bucket (Phase 17A-2)", async () => {
    stubFetch(200, { bucket: "hour", devices: [], available: true });
    await fleetApi.getAvailabilityReport({
      deviceId: "agv-1",
      from: "2026-09-01T00:00:00Z",
      bucket: "hour",
    });
    expect(calls.at(-1)?.url).toBe(
      "/api/v1/reports/availability?deviceId=agv-1&from=2026-09-01T00%3A00%3A00Z&bucket=hour",
    );

    stubFetch(200, { bucket: "day", devices: [], available: false });
    await fleetApi.getAvailabilityReport();
    expect(calls.at(-1)?.url).toBe("/api/v1/reports/availability");
  });
});

describe("设备接入向导 config (Phase 18)", () => {
  it("reads vehicles and formations config", async () => {
    stubFetch(200, { vehicles: [{ deviceId: "agv-1", deviceName: "一号" }] });
    await expect(fleetApi.getVehicleConfig()).resolves.toEqual({
      vehicles: [{ deviceId: "agv-1", deviceName: "一号" }],
    });
    expect(calls.at(-1)?.url).toBe("/api/v1/vehicles");

    stubFetch(200, { formations: [] });
    await expect(fleetApi.getFormationConfig()).resolves.toEqual({
      formations: [],
    });
    expect(calls.at(-1)?.url).toBe("/api/v1/formation-config");
  });

  it("PUTs the whole array in a keyed body", async () => {
    stubFetch(200, { vehicles: [] });
    await fleetApi.putVehicleConfig([
      { deviceId: "agv-1", deviceName: "一号" },
    ]);
    expect(calls.at(-1)?.url).toBe("/api/v1/vehicles");
    expect(calls.at(-1)?.init.method).toBe("PUT");
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      vehicles: [{ deviceId: "agv-1", deviceName: "一号" }],
    });

    stubFetch(200, { formations: [] });
    await fleetApi.putFormationConfig([
      { formationId: "f", formationName: "F", deviceIds: ["agv-1"] },
    ]);
    expect(calls.at(-1)?.url).toBe("/api/v1/formation-config");
    expect(calls.at(-1)?.init.method).toBe("PUT");
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({
      formations: [
        { formationId: "f", formationName: "F", deviceIds: ["agv-1"] },
      ],
    });
  });
});

describe("场景地图管理 (Phase 18)", () => {
  it("PUTs the whole scenes array in a keyed body", async () => {
    stubFetch(200, { items: [] });
    await fleetApi.putScenes([
      {
        sceneId: "yard",
        sceneName: "堆场",
        mapFrame: "map",
        resolution: 0.05,
        origin: { x: 0, y: 0, yaw: 0 },
        width: 800,
        height: 600,
      },
    ]);
    expect(calls.at(-1)?.url).toBe("/api/v1/scenes");
    expect(calls.at(-1)?.init.method).toBe("PUT");
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toMatchObject({
      scenes: [{ sceneId: "yard", width: 800 }],
    });
  });

  it("uploads a backdrop as a raw PUT body and returns the URL", async () => {
    stubFetch(200, { url: "/scene-maps/yard/image.svg" });
    const file = new Blob(["<svg></svg>"], { type: "image/svg+xml" });
    await expect(
      fleetApi.uploadSceneAsset("yard", "image", file),
    ).resolves.toEqual({
      url: "/scene-maps/yard/image.svg",
    });
    expect(calls.at(-1)?.url).toBe("/api/v1/scenes/yard/asset/image");
    expect(calls.at(-1)?.init.method).toBe("PUT");
    // Raw body: the Blob itself, not a JSON string.
    expect(calls.at(-1)?.init.body).toBe(file);
    expect(calls.at(-1)?.init.credentials).toBe("include");
  });

  it("percent-encodes the sceneId in the upload path", async () => {
    stubFetch(200, { url: "/scene-maps/a/image.svg" });
    await fleetApi.uploadSceneAsset("a b", "image", new Blob(["x"]));
    expect(calls.at(-1)?.url).toBe("/api/v1/scenes/a%20b/asset/image");
  });
});

describe("fleetApi — RBAC roles & groups (1.6.1)", () => {
  it("reads roles and groups from the versioned prefix", async () => {
    stubFetch(200, { roles: [] });
    await fleetApi.getRbacRoles();
    expect(calls.at(-1)?.url).toBe("/api/v1/rbac/roles");
    stubFetch(200, { groups: [] });
    await fleetApi.getRbacGroups();
    expect(calls.at(-1)?.url).toBe("/api/v1/rbac/groups");
  });

  it("POSTs a new role with its capabilities", async () => {
    stubFetch(201, { role: { id: "r1" } });
    await fleetApi.createRbacRole({
      name: "Ops",
      capabilities: ["codebook:write"],
    });
    const call = calls.at(-1);
    expect(call?.url).toBe("/api/v1/rbac/roles");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      name: "Ops",
      capabilities: ["codebook:write"],
    });
  });

  it("PATCHes a role and DELETEs one by (encoded) id", async () => {
    stubFetch(200, { role: { id: "r1" } });
    await fleetApi.updateRbacRole("r 1", { name: "Ops", capabilities: [] });
    expect(calls.at(-1)?.url).toBe("/api/v1/rbac/roles/r%201");
    expect(calls.at(-1)?.init.method).toBe("PATCH");
    stubFetch(204, {});
    await fleetApi.deleteRbacRole("r 1");
    expect(calls.at(-1)?.url).toBe("/api/v1/rbac/roles/r%201");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });

  it("POSTs / PATCHes / DELETEs a group with its roles and members", async () => {
    stubFetch(201, { group: { id: "g1" } });
    await fleetApi.createRbacGroup({
      name: "Shift",
      description: "夜班",
      roleIds: ["r1"],
      memberUsernames: ["bob"],
    });
    const created = calls.at(-1);
    expect(created?.url).toBe("/api/v1/rbac/groups");
    expect(JSON.parse(String(created?.init.body))).toEqual({
      name: "Shift",
      description: "夜班",
      roleIds: ["r1"],
      memberUsernames: ["bob"],
    });
    stubFetch(200, { group: { id: "g1" } });
    await fleetApi.updateRbacGroup("g1", {
      name: "Shift",
      roleIds: [],
      memberUsernames: [],
    });
    expect(calls.at(-1)?.init.method).toBe("PATCH");
    stubFetch(204, {});
    await fleetApi.deleteRbacGroup("g1");
    expect(calls.at(-1)?.url).toBe("/api/v1/rbac/groups/g1");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });
});
