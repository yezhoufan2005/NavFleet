import { describe, it, expect } from "vitest";
import { z } from "zod";
import { openApiDocument } from "../src/openapi";
import { alertsQuerySchema, loginSchema } from "../src/validation";

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
      "/api/v1/fleet/snapshot",
      "/api/v1/devices/{deviceId}/history",
      "/api/v1/alerts",
      "/api/v1/scenes",
      "/api/v1/debug/ingest",
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
    expect(paths["/api/v1/fleet/snapshot"].get?.security).toBeUndefined();
  });
});

/**
 * The point of generating these from the validators is that they cannot drift.
 * These assertions compare the document against the schemas the server enforces,
 * so a change to a validator that forgets the docs fails here rather than
 * shipping a lie.
 */
describe("input schemas generated from the validators", () => {
  const paths = openApiDocument.paths as Record<
    string,
    { get?: { parameters?: Array<{ name: string; schema: Record<string, unknown> }> } }
  >;

  it("documents the login body exactly as loginSchema validates it", () => {
    const schemas = (openApiDocument.components as { schemas: Record<string, unknown> }).schemas;
    const { $schema: _ignored, ...expected } = z.toJSONSchema(loginSchema, {
      io: "input",
    }) as Record<string, unknown>;

    expect(schemas.LoginRequest).toEqual(expected);
    // The hand-written version omitted this, promising empty strings were fine.
    const properties = (expected as { properties: Record<string, { minLength?: number }> })
      .properties;
    expect(properties.username.minLength).toBe(1);
    expect(properties.password.minLength).toBe(1);
  });

  it("documents the history query bounds the server actually enforces", () => {
    const limit = paths["/api/v1/devices/{deviceId}/history"].get?.parameters?.find(
      (parameter) => parameter.name === "limit",
    );

    expect(limit?.schema).toMatchObject({ type: "integer", maximum: 5000, exclusiveMinimum: 0 });
  });

  it("documents every alert filter the validator accepts, and no others", () => {
    const documented = paths["/api/v1/alerts"].get?.parameters?.map((p) => p.name) ?? [];
    const validated = Object.keys(
      (
        z.toJSONSchema(alertsQuerySchema, { io: "input" }) as {
          properties: Record<string, unknown>;
        }
      ).properties,
    );

    expect([...documented].sort()).toEqual([...validated].sort());
  });
});
