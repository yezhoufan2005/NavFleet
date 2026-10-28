import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { config } from "../src/config";
import { openApiDocument } from "../src/openapi";
import { alertsQuerySchema, loginSchema } from "../src/validation";
import { version as releaseVersion } from "../../package.json";

/**
 * Every route the routers register, as `METHOD /path` with `{param}` placeholders — read from
 * the router sources, so a route added without documenting it fails here instead of being
 * found missing by a client months later (eight route groups had drifted out that way).
 */
const registeredRoutes = (): string[] => {
  const dirs = [join(__dirname, "../src/routes"), join(__dirname, "../src/auth")];
  const found = new Set<string>();
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      const authRouter = dir.endsWith("auth");
      for (const match of source.matchAll(/router\.(get|put|post|patch|delete)\(\s*"([^"]+)"/g)) {
        const route = match[2]!.replace(/:(\w+)/g, "{$1}");
        found.add(`${match[1]!.toUpperCase()} ${route}`);
        if (authRouter) found.add(`${match[1]!.toUpperCase()} /api/auth${route}`);
      }
    }
  }
  return [...found];
};

/** Where a router path is documented: the ops/docs ones at the root, the domain ones under /api/v1. */
const documentedAt = (route: string): string[] => {
  const [, path] = route.split(" ") as [string, string];
  return [path, `/api/v1${path}`, `/api/auth${path}`];
};

describe("openApiDocument", () => {
  it("documents every route the routers register", () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    const missing = registeredRoutes().filter((route) => {
      const method = route.split(" ")[0]!.toLowerCase();
      return !documentedAt(route).some((path) => paths[path]?.[method]);
    });
    expect(missing).toEqual([]);
  });

  it("is a well-formed OpenAPI 3.1 document", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    const info = openApiDocument.info as { title: string; version: string };
    expect(info.title).toBe("NavFleet API");
    // Asserted against the ROOT manifest — the version release-please tags and
    // the image carries — not a literal. The literal used to be `0.1.0` and
    // stayed wrong through two releases, because a hardcoded version in a test is
    // the same drift as one in the document; it just moves which file nobody
    // remembers to edit.
    expect(info.version).toBe(releaseVersion);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
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
      // Four surfaces the server has always served while the document said nothing
      // about them. This list is the reason the gap lasted: it was the only check on
      // path coverage and it only ever named the paths someone remembered.
      "/openapi.json",
      "/docs",
      "/docs/openapi.json",
      "/scene-maps/{assetPath}",
    ]) {
      expect(paths[path], `missing path ${path}`).toBeTruthy();
    }
  });

  it("documents 429 and 500 on every /api operation, and on no public probe", () => {
    const paths = openApiDocument.paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;

    // Both come from middleware mounted on the whole `/api` surface — the coarse
    // rate limiter and the error handler at the end of the chain — so every operation
    // under it can answer with them, and none of them said so. A generated client that
    // has never been told about either treats both as an unexpected shape.
    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const codes = operation.responses ?? {};
        const where = `${method.toUpperCase()} ${path}`;
        if (path.startsWith("/api")) {
          expect(codes["429"], `${where} should document 429`).toBeTruthy();
          expect(codes["500"], `${where} should document 500`).toBeTruthy();
        } else {
          // `/health`, `/metrics`, `/docs`, `/openapi.json`, `/scene-maps/**` sit
          // outside `/api`, so the limiter never sees them.
          expect(codes["429"], `${where} must not claim 429`).toBeUndefined();
        }
      }
    }
  });

  it("expresses nullability the way OpenAPI 3.1 does", () => {
    // 3.1's schemas are JSON Schema 2020-12, which dropped `nullable`. A 3.1
    // validator ignores it, so three fields that genuinely emit `null` — a report
    // code's `stamp`, an alert's `code` and its `clearedAt` — were published as
    // non-nullable while the keyword sat there looking like it did something.
    expect(JSON.stringify(openApiDocument)).not.toContain('"nullable"');

    const schemas = (openApiDocument.components as { schemas: Record<string, unknown> })
      .schemas as Record<string, { properties: Record<string, { type?: unknown }> }>;
    expect(schemas.Alert?.properties.code?.type).toEqual(["number", "null"]);
    expect(schemas.Alert?.properties.clearedAt?.type).toEqual(["string", "null"]);
  });

  it("documents the error fields the server actually sends", () => {
    const schemas = (openApiDocument.components as { schemas: Record<string, unknown> })
      .schemas as Record<string, { properties: Record<string, unknown> }>;

    // `issues` on a validation 400, `requiredCapability` on an RBAC 403, `requestId` on a
    // 500 — the last one exists precisely so a caller can quote it, and a client built
    // from the spec could not read any of the three.
    for (const field of ["error", "detail", "issues", "requiredCapability", "requestId"]) {
      expect(schemas.Error?.properties[field], `Error.${field}`).toBeTruthy();
    }
  });

  it("carries no component that nothing references", () => {
    const schemas = Object.keys(
      (openApiDocument.components as { schemas: Record<string, unknown> }).schemas,
    );
    const serialised = JSON.stringify(openApiDocument);

    // `CodeState` used to sit in `components.schemas` with no `$ref` pointing at it:
    // a shape a client could see and could not place. An unreferenced component is a
    // claim with no subject.
    for (const name of schemas) {
      expect(
        serialised.includes(`#/components/schemas/${name}`),
        `component ${name} is referenced by nothing`,
      ).toBe(true);
    }
  });

  it("declares cookie auth and leaves public probes unsecured", () => {
    const components = openApiDocument.components as { securitySchemes: Record<string, unknown> };
    expect(components.securitySchemes.cookieAuth).toBeTruthy();

    const paths = openApiDocument.paths as Record<string, { get?: { security?: unknown[] } }>;
    // Public probes opt out of the global security requirement with `security: []`.
    expect(paths["/health"]?.get?.security).toEqual([]);
    expect(paths["/metrics"]?.get?.security).toEqual([]);
    // Authenticated endpoints inherit the global cookieAuth requirement (no override).
    // Fetched into a local on purpose: written as `paths[…]?.get?.security`, a path that
    // had *disappeared* from the spec would also read `undefined` and this assertion would
    // stay green while documenting nothing. The two above are safe as they stand — a
    // missing path reads `undefined`, which is not `[]`.
    const snapshot = paths["/api/v1/fleet/snapshot"];
    expect(snapshot).toBeTruthy();
    expect(snapshot?.get?.security).toBeUndefined();
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
    expect(properties.username?.minLength).toBe(1);
    expect(properties.password?.minLength).toBe(1);
  });

  it("documents the history query bounds the server actually enforces", () => {
    const limit = paths["/api/v1/devices/{deviceId}/history"]?.get?.parameters?.find(
      (parameter) => parameter.name === "limit",
    );

    // Against `config.maxHistoryPoints`, not a literal — the test's own title is the
    // claim being made, and it was false: the spec said 5000 while both query paths
    // clamp to this value (default 500). Pinning the *relationship* is what keeps the
    // published contract honest if the cap is ever reconfigured.
    expect(limit?.schema).toMatchObject({
      type: "integer",
      maximum: config.maxHistoryPoints,
      exclusiveMinimum: 0,
    });
  });

  it("documents every alert filter the validator accepts, and no others", () => {
    const documented = paths["/api/v1/alerts"]?.get?.parameters?.map((p) => p.name) ?? [];
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
