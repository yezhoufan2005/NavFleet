import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";

describe("security response headers", () => {
  it("sends a content policy that allows nothing to be fetched or framed", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health");

    const csp = response.headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("API rate limit", () => {
  it("answers over-limit requests with a JSON 429", async () => {
    const { app } = createTestApp({
      configOverrides: { rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    });
    const cookie = sessionCookie();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app).get("/api/formations").set("Cookie", cookie);
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 429]);

    const blocked = await request(app).get("/api/formations").set("Cookie", cookie);
    expect(blocked.headers["content-type"]).toMatch(/application\/json/);
    expect(blocked.body).toEqual({ error: "too_many_requests" });
  });

  it("limits the credential endpoint separately from the rest of the API", async () => {
    // The auth limiter used to be a hardcoded 50-per-15-minutes, which no
    // deployment and no test could adjust. Two limiters now apply to
    // /api/auth: this proves the tighter one bites first, at its own number.
    const { app } = createTestApp({
      configOverrides: { authRateLimitMax: 2, rateLimitMax: 1_000 },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app)
        .post("/api/auth/login")
        .send({ username: "nobody", password: "wrong-on-purpose" });
      statuses.push(response.status);
    }

    // Two rejected logins, then the limiter takes over from the credential check.
    expect(statuses).toEqual([401, 401, 429]);

    // The rest of the API is untouched by the credential limiter.
    expect((await request(app).get("/api/formations").set("Cookie", sessionCookie())).status).toBe(
      200,
    );
  });

  it("never throttles the probes and the metrics scrape", async () => {
    const { app } = createTestApp({ configOverrides: { rateLimitMax: 1 } });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await request(app).get("/health")).status).toBe(200);
      expect((await request(app).get("/health/ready")).status).toBe(503);
      expect((await request(app).get("/metrics")).status).toBe(200);
    }
  });

  it("caps unauthenticated probing too, ahead of the auth gate", async () => {
    const { app } = createTestApp({ configOverrides: { rateLimitMax: 1 } });

    expect((await request(app).get("/api/formations")).status).toBe(401);
    expect((await request(app).get("/api/formations")).status).toBe(429);
  });
});

describe("client identification behind a proxy", () => {
  it("gives each forwarded client its own bucket when a proxy hop is trusted", async () => {
    const { app } = createTestApp({
      configOverrides: { rateLimitMax: 1, trustProxy: 1 },
    });
    const cookie = sessionCookie();

    const first = await request(app)
      .get("/api/formations")
      .set("X-Forwarded-For", "203.0.113.1")
      .set("Cookie", cookie);
    const second = await request(app)
      .get("/api/formations")
      .set("X-Forwarded-For", "203.0.113.2")
      .set("Cookie", cookie);
    const firstAgain = await request(app)
      .get("/api/formations")
      .set("X-Forwarded-For", "203.0.113.1")
      .set("Cookie", cookie);

    expect([first.status, second.status]).toEqual([200, 200]);
    // Only the client that already spent its allowance is blocked.
    expect(firstAgain.status).toBe(429);
  });

  it("ignores a forged forwarding header when no proxy is trusted", async () => {
    // The default. Without it a directly exposed backend would let a client pick
    // a fresh rate-limit bucket per request by varying the header.
    const { app } = createTestApp({
      configOverrides: { rateLimitMax: 1, trustProxy: 0 },
    });
    const cookie = sessionCookie();

    const first = await request(app)
      .get("/api/formations")
      .set("X-Forwarded-For", "203.0.113.1")
      .set("Cookie", cookie);
    const second = await request(app)
      .get("/api/formations")
      .set("X-Forwarded-For", "203.0.113.2")
      .set("Cookie", cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
