import { describe, it, expect } from "vitest";
import request from "supertest";
import type { UserRole } from "../src/types";
import { createTestApp, sessionCookie, DEVICE_ID, SCENE_ID } from "./helpers/testApp";

/**
 * The RBAC matrix as an enforced contract (Phase 15C).
 *
 * This is a read-only monitoring system: configuration flows over a file watch, not the API,
 * so there is no operator-only route. The real matrix is therefore thin — every read is
 * viewer+, and only `/users*` and `/debug/ingest` are admin — and that thinness is exactly
 * why it is worth pinning: before this, only `/users` and `/debug` had any role test, so
 * nothing stopped a future edit from quietly opening an admin route to viewers, or gating a
 * read behind a role. `operator` is deliberately equal to `viewer` here; its own surface
 * arrives with alert acknowledgement (16A).
 */

const READ_ROUTES: Array<{ method: "get"; path: string }> = [
  { method: "get", path: "/api/fleet/snapshot" },
  { method: "get", path: "/api/formations" },
  { method: "get", path: "/api/scenes" },
  { method: "get", path: `/api/scenes/${SCENE_ID}` },
  { method: "get", path: `/api/scenes/${SCENE_ID}/overlay` },
  { method: "get", path: `/api/devices/${DEVICE_ID}/history` },
  { method: "get", path: "/api/alerts" },
  { method: "get", path: "/api/auth/me" },
  { method: "get", path: "/api/auth/sessions" },
];

const ADMIN_ROUTES: Array<{ method: "get" | "post" | "patch" | "delete"; path: string }> = [
  { method: "get", path: "/api/users" },
  { method: "post", path: "/api/users" },
  { method: "get", path: "/api/users/bob" },
  { method: "patch", path: "/api/users/bob" },
  { method: "delete", path: "/api/users/bob" },
  { method: "post", path: "/api/users/bob/reset-password" },
  { method: "post", path: "/api/users/bob/logout" },
  { method: "post", path: "/api/debug/ingest" },
  { method: "get", path: "/api/audit" },
];

const ALL_ROLES: UserRole[] = ["viewer", "operator", "admin"];

describe("RBAC matrix — read routes are viewer+", () => {
  for (const role of ALL_ROLES) {
    it(`allows ${role} to reach every read route`, async () => {
      const { app } = createTestApp();
      for (const route of READ_ROUTES) {
        const response = await request(app)
          [route.method](route.path)
          .set("Cookie", sessionCookie(role));
        // Reachable: not blocked by the auth gate (401) or a role gate (403).
        expect([401, 403], `${role} ${route.path} → ${response.status}`).not.toContain(
          response.status,
        );
      }
    });
  }
});

describe("RBAC matrix — admin-only routes reject viewer/operator", () => {
  for (const role of ["viewer", "operator"] as const) {
    it(`403s ${role} on every admin route`, async () => {
      const { app } = createTestApp();
      for (const route of ADMIN_ROUTES) {
        const response = await request(app)
          [route.method](route.path)
          .set("Cookie", sessionCookie(role));
        expect(response.status, `${role} ${route.method} ${route.path}`).toBe(403);
      }
    });
  }

  it("does NOT 403 admin on any admin route (the role gate passes)", async () => {
    const { app } = createTestApp();
    for (const route of ADMIN_ROUTES) {
      const response = await request(app)
        [route.method](route.path)
        .set("Cookie", sessionCookie("admin"));
      // May be 200/201/204/400/404 depending on body/flags — the point is the gate let it through.
      expect(response.status, `admin ${route.method} ${route.path}`).not.toBe(403);
    }
  });
});

describe("RBAC matrix — anonymous is blocked everywhere", () => {
  it("401s an anonymous caller on read and admin routes alike", async () => {
    const { app } = createTestApp();
    for (const route of [...READ_ROUTES, ...ADMIN_ROUTES]) {
      const response = await request(app)[route.method](route.path);
      expect(response.status, `anon ${route.method} ${route.path}`).toBe(401);
    }
  });
});
