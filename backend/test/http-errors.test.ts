import { describe, it, expect } from "vitest";
import request from "supertest";
import { DEVICE_ID, SCENE_ID, createTestApp, sessionCookie } from "./helpers/testApp";

describe("JSON 404 catch-all", () => {
  it.each(["/api/does-not-exist", "/api/fleet/nope", "/not-an-api-path"])(
    "answers %s with JSON rather than Express's HTML page",
    async (path) => {
      const { app } = createTestApp();
      const response = await request(app).get(path).set("Cookie", sessionCookie());

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: "not_found" });
      expect(response.text).not.toMatch(/<html/i);
    },
  );

  it("answers an unsupported method on a known path with the JSON 404", async () => {
    const { app } = createTestApp();
    const response = await request(app).post("/api/formations").set("Cookie", sessionCookie());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});

describe("error middleware", () => {
  it("turns a rejected async collaborator into a generic 500", async () => {
    const context = createTestApp();
    context.store.getAlerts.mockRejectedValue(new Error("mongo exploded: secret-dsn"));

    const response = await request(context.app).get("/api/alerts").set("Cookie", sessionCookie());

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "internal_error" });
    // The internal detail is logged server-side only.
    expect(response.text).not.toContain("secret-dsn");
    expect(response.text).not.toContain("mongo exploded");
  });

  it.each([
    { path: `/api/devices/${DEVICE_ID}/history`, stub: "getHistory" as const },
    { path: `/api/scenes/${SCENE_ID}`, stub: "getScene" as const },
    { path: `/api/scenes/${SCENE_ID}/overlay`, stub: "getSceneOverlay" as const },
  ])("returns a generic 500 when $stub fails", async ({ path, stub }) => {
    const context = createTestApp();
    context.store[stub].mockRejectedValue(new Error("boom"));

    const response = await request(context.app).get(path).set("Cookie", sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });

  it("catches a synchronous throw from a handler", async () => {
    const context = createTestApp();
    context.store.getScenes.mockImplementation(() => {
      throw new Error("boom");
    });

    const response = await request(context.app).get("/api/scenes").set("Cookie", sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
  });

  it("surfaces a malformed JSON body as 400, not 500", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"username": "admin", ');

    expect(response.status).toBe(400);
    const body = response.body as { error: string; message?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("surfaces a JSON body rejected by strict parsing as 400", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("42");

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_request");
  });
});
