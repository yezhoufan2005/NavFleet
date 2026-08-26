import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  DEVICE_ID,
  createTestApp,
  sessionCookie,
  type TestAppContext,
  type ValidationErrorBody,
} from "./helpers/testApp";

const authed = (context: TestAppContext, path: string) =>
  request(context.app).get(path).set("Cookie", sessionCookie());

describe("validation → 400 response wiring", () => {
  it("uses the documented {error, issues} shape and never reaches the store", async () => {
    const context = createTestApp();
    const response = await authed(context, `/api/devices/${DEVICE_ID}/history?limit=abc`);

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    const body = response.body as ValidationErrorBody;
    expect(body.error).toBe("invalid_request");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0].path).toBe("limit");
    expect(typeof body.issues[0].message).toBe("string");
    expect(context.store.getHistory).not.toHaveBeenCalled();
  });

  it.each([
    { query: "limit=abc", field: "limit" },
    { query: "limit=0", field: "limit" },
    { query: "limit=-5", field: "limit" },
    { query: "limit=1.5", field: "limit" },
    { query: "limit=5001", field: "limit" },
    { query: "from=not-a-timestamp", field: "from" },
    { query: "from=", field: "from" },
    { query: "to=nonsense", field: "to" },
  ])("rejects history ?$query with a 400 on $field", async ({ query, field }) => {
    const context = createTestApp();
    const response = await authed(context, `/api/devices/${DEVICE_ID}/history?${query}`);

    expect(response.status).toBe(400);
    const body = response.body as ValidationErrorBody;
    expect(body.issues.map((issue) => issue.path)).toContain(field);
  });

  it("rejects an over-long device id", async () => {
    const context = createTestApp();
    const response = await authed(context, `/api/devices/${"d".repeat(201)}/history`);

    expect(response.status).toBe(400);
    // A bare string schema has no field path, so the issue path is empty.
    expect((response.body as ValidationErrorBody).issues[0].path).toBe("");
    expect(context.store.getHistory).not.toHaveBeenCalled();
  });

  it.each([
    { query: "severity=fatal", field: "severity" },
    { query: "status=unknown", field: "status" },
    { query: "deviceId=", field: "deviceId" },
  ])("rejects alerts ?$query with a 400 on $field", async ({ query, field }) => {
    const context = createTestApp();
    const response = await authed(context, `/api/alerts?${query}`);

    expect(response.status).toBe(400);
    const body = response.body as ValidationErrorBody;
    expect(body.issues.map((issue) => issue.path)).toContain(field);
    expect(context.store.getAlerts).not.toHaveBeenCalled();
  });

  // Literal "." / ".." segments never survive a conforming HTTP client (WHATWG
  // URL normalizes them away, `%2E` included), so the dot-only refinement is
  // exercised here through "..." — the schema-level cases live in
  // validation.test.ts.
  it.each(["...", "bad%20id", "scene%2Fetc", "sc%C3%A9ne"])(
    "rejects the scene id %s on both scene routes",
    async (sceneId) => {
      const context = createTestApp();

      const scene = await authed(context, `/api/scenes/${sceneId}`);
      expect(scene.status).toBe(400);
      expect((scene.body as ValidationErrorBody).error).toBe("invalid_request");

      const overlay = await authed(context, `/api/scenes/${sceneId}/overlay`);
      expect(overlay.status).toBe(400);

      expect(context.store.getScene).not.toHaveBeenCalled();
      expect(context.store.getSceneOverlay).not.toHaveBeenCalled();
    },
  );

  it("accepts the safe scene id charset", async () => {
    const context = createTestApp();
    context.store.getScene.mockResolvedValue(null);
    const response = await authed(context, "/api/scenes/scene.a_1-2");

    // Rejected by the store as unknown, not by validation.
    expect(response.status).toBe(404);
    expect(context.store.getScene).toHaveBeenCalledWith("scene.a_1-2");
  });
});
