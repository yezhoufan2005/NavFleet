import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * Swagger UI is served from the backend rather than a CDN so the docs work on an
 * air-gapped deployment and no third party sees a request for them.
 */
describe("GET /docs", () => {
  it("requires a session, like the document it renders", async () => {
    const { app } = createTestApp();

    expect((await request(app).get("/docs")).status).toBe(401);
    expect((await request(app).get("/docs/openapi.json")).status).toBe(401);
  });

  it("serves the page and the document to a signed-in caller", async () => {
    const { app } = createTestApp();
    const cookie = sessionCookie();

    const page = await request(app).get("/docs").set("Cookie", cookie);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain("swagger-ui-bundle.js");
    // No CDN: every asset the page pulls is same-origin.
    expect(page.text).not.toMatch(/https?:\/\//);

    const document = await request(app).get("/docs/openapi.json").set("Cookie", cookie);
    expect(document.status).toBe(200);
    expect((document.body as { openapi: string }).openapi).toBe("3.1.0");
  });

  it("relaxes the content policy for the docs page only", async () => {
    const { app } = createTestApp();
    const cookie = sessionCookie();

    const docs = await request(app).get("/docs").set("Cookie", cookie);
    const api = await request(app).get("/api/v1/scenes").set("Cookie", cookie);

    // The page needs to run a script; the API still must not.
    expect(docs.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(api.headers["content-security-policy"]).not.toContain("script-src");
    expect(api.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("does not expose the dist directory's own petstore index", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/docs/index.html").set("Cookie", sessionCookie());

    expect(response.status).toBe(404);
  });
});
