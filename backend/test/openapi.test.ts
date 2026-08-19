import { describe, it, expect } from "vitest";
import { openApiDocument } from "../src/openapi";

describe("openApiDocument", () => {
  it("is a well-formed OpenAPI 3.1 document", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    const info = openApiDocument.info as { title: string; version: string };
    expect(info.title).toBe("NavFleet API");
    expect(info.version).toBe("0.1.0");
  });

  it("documents the core public and authenticated paths", () => {
    const paths = openApiDocument.paths as Record<string, unknown>;
    for (const path of [
      "/health",
      "/health/ready",
      "/metrics",
      "/api/auth/login",
      "/api/auth/me",
      "/api/fleet/snapshot",
      "/api/devices/{deviceId}/history",
      "/api/alerts",
      "/api/scenes",
      "/api/debug/ingest",
    ]) {
      expect(paths[path], `missing path ${path}`).toBeTruthy();
    }
  });

  it("declares cookie auth and leaves public probes unsecured", () => {
    const components = openApiDocument.components as { securitySchemes: Record<string, unknown> };
    expect(components.securitySchemes.cookieAuth).toBeTruthy();

    const paths = openApiDocument.paths as Record<string, { get?: { security?: unknown[] } }>;
    // Public probes opt out of the global security requirement with `security: []`.
    expect(paths["/health"].get?.security).toEqual([]);
    expect(paths["/metrics"].get?.security).toEqual([]);
    // Authenticated endpoints inherit the global cookieAuth requirement (no override).
    expect(paths["/api/fleet/snapshot"].get?.security).toBeUndefined();
  });
});
