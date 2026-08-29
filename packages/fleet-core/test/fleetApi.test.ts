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

const stubFetch = (status = 200, body: unknown = {}): void => {
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchStub);
};

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
    expect(calls[0].url).toBe("/api/v1/fleet/snapshot");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.cache).toBe("no-store");
  });

  it("returns the parsed JSON body for the scene catalog", async () => {
    stubFetch(200, { items: [{ sceneId: "yard" }] });

    await expect(fleetApi.getScenes()).resolves.toEqual({
      items: [{ sceneId: "yard" }],
    });
    expect(calls[0].url).toBe("/api/v1/scenes");
  });

  it("throws with the status code when the response is not 2xx", async () => {
    stubFetch(503, { error: "unavailable" });

    await expect(fleetApi.getSnapshot()).rejects.toThrow("HTTP 503");
  });

  it("percent-encodes path parameters", async () => {
    stubFetch(200, { sceneId: "floor 1/a" });

    await fleetApi.getScene("floor 1/a");

    expect(calls[0].url).toBe("/api/v1/scenes/floor%201%2Fa");
  });

  it("builds a query string from the defined params only", async () => {
    stubFetch(200, { deviceId: "agv-1", items: [] });

    await fleetApi.getHistory("agv 1", {
      from: "2026-08-26T00:00:00Z",
      to: "",
      limit: 50,
    });

    expect(calls[0].url).toBe(
      "/api/v1/devices/agv%201/history?from=2026-08-26T00%3A00%3A00Z&limit=50",
    );
  });

  it("omits the query string entirely when no params are given", async () => {
    stubFetch(200, { items: [] });

    await fleetApi.getAlerts();

    expect(calls[0].url).toBe("/api/v1/alerts");
  });

  it("passes alert filters through as query params", async () => {
    stubFetch(200, { items: [] });

    await fleetApi.getAlerts({
      severity: "critical",
      deviceId: "agv-1",
      status: "active",
    });

    expect(calls[0].url).toBe(
      "/api/v1/alerts?severity=critical&deviceId=agv-1&status=active",
    );
  });
});
