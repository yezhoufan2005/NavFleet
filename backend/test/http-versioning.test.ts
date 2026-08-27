import { describe, it, expect } from "vitest";
import request from "supertest";
import { API_PREFIXES } from "../src/app";
import { DEVICE_ID, SCENE_ID, createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * `/api/v1` is the surface new clients should build against; bare `/api` stays
 * for everything already deployed. Both must behave identically — a versioned
 * alias that quietly differs is worse than no version at all.
 */
describe("API version prefixes", () => {
  it("advertises the versioned prefix first, so it is the one new code picks up", () => {
    expect(API_PREFIXES).toEqual(["/api/v1", "/api"]);
  });

  it.each([
    "/fleet/snapshot",
    "/formations",
    "/scenes",
    `/scenes/${SCENE_ID}`,
    `/scenes/${SCENE_ID}/overlay`,
    `/devices/${DEVICE_ID}/history`,
    "/alerts",
  ])("serves %s identically under both prefixes", async (route) => {
    const { app } = createTestApp();
    const cookie = sessionCookie();

    const [unversioned, versioned] = await Promise.all([
      request(app).get(`/api${route}`).set("Cookie", cookie),
      request(app).get(`/api/v1${route}`).set("Cookie", cookie),
    ]);

    expect(versioned.status).toBe(unversioned.status);
    expect(versioned.status).toBe(200);
    expect(versioned.body).toEqual(unversioned.body);
  });

  it("guards the versioned prefix with the same auth gate", async () => {
    const { app } = createTestApp();

    expect((await request(app).get("/api/v1/fleet/snapshot")).status).toBe(401);
  });

  it("applies validation to the versioned prefix too", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get(`/api/v1/devices/${DEVICE_ID}/history?limit=abc`)
      .set("Cookie", sessionCookie());

    expect(response.status).toBe(400);
  });

  it("keeps authentication unversioned, so the refresh cookie stays scoped", async () => {
    // /api/auth/* is the stable surface; a versioned twin would force the
    // refresh cookie's path to widen to all of /api. Sent with a session so the
    // auth gate does not answer first — an unauthenticated unknown path is a 401
    // everywhere, which would prove nothing about routing.
    const { app } = createTestApp();

    const versioned = await request(app)
      .post("/api/v1/auth/login")
      .set("Cookie", sessionCookie())
      .send({});
    expect(versioned.status).toBe(404);

    const unversioned = await request(app).post("/api/auth/login").send({});
    expect(unversioned.status).toBe(400);
  });

  it("still answers an unknown versioned path with the JSON 404", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/api/v1/nope").set("Cookie", sessionCookie());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});
