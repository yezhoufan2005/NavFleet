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
 * read behind a role. `operator` is equal to `viewer` for reads, but Phase 16A gives it its
 * first distinct capability — acknowledging alerts — which viewers must not have.
 */

const READ_ROUTES: Array<{ method: "get"; path: string }> = [
  { method: "get", path: "/api/fleet/snapshot" },
  { method: "get", path: "/api/formations" },
  { method: "get", path: "/api/scenes" },
  { method: "get", path: `/api/scenes/${SCENE_ID}` },
  { method: "get", path: `/api/scenes/${SCENE_ID}/overlay` },
  { method: "get", path: `/api/devices/${DEVICE_ID}/history` },
  { method: "get", path: "/api/alerts" },
  { method: "get", path: "/api/codebook" },
  { method: "get", path: "/api/auth/me" },
  { method: "get", path: "/api/auth/sessions" },
];

/**
 * Operator+ routes (Phase 16A): the alert acknowledgement pair. A valid body is sent so the
 * request reaches the role gate rather than stopping at validation; operator/admin then pass
 * the gate (and hit a 404 from the stubbed persistence, which is fine — the point is the gate
 * let them through), while viewers are refused before the handler runs.
 */
const OPERATOR_ROUTES: Array<{
  method: "post";
  path: string;
  body: Record<string, string>;
}> = [
  { method: "post", path: "/api/alerts/ack", body: { deviceId: DEVICE_ID, alertId: "a1" } },
  { method: "post", path: "/api/alerts/unack", body: { deviceId: DEVICE_ID, alertId: "a1" } },
];

const ADMIN_ROUTES: Array<{ method: "get" | "post" | "patch" | "delete" | "put"; path: string }> = [
  { method: "get", path: "/api/users" },
  { method: "post", path: "/api/users" },
  { method: "get", path: "/api/users/bob" },
  { method: "patch", path: "/api/users/bob" },
  { method: "delete", path: "/api/users/bob" },
  { method: "post", path: "/api/users/bob/reset-password" },
  { method: "post", path: "/api/users/bob/logout" },
  { method: "get", path: "/api/users/bob/sessions" },
  { method: "delete", path: "/api/users/bob/sessions/s1" },
  { method: "post", path: "/api/debug/ingest" },
  { method: "get", path: "/api/audit" },
  { method: "put", path: "/api/codebook" },
  // 告警外发 read API (Phase 16D-1): send log + effective channels are admin-only, like audit.
  { method: "get", path: "/api/notify/log" },
  { method: "get", path: "/api/notify/config" },
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

describe("RBAC matrix — acknowledgement is operator+ (Phase 16A)", () => {
  it("403s a viewer on the ack routes", async () => {
    const { app } = createTestApp();
    for (const route of OPERATOR_ROUTES) {
      const response = await request(app)
        [route.method](route.path)
        .set("Cookie", sessionCookie("viewer"))
        .send(route.body);
      expect(response.status, `viewer ${route.path}`).toBe(403);
    }
  });

  for (const role of ["operator", "admin"] as const) {
    it(`does NOT 403 ${role} on the ack routes (the gate passes)`, async () => {
      const { app } = createTestApp();
      for (const route of OPERATOR_ROUTES) {
        const response = await request(app)
          [route.method](route.path)
          .set("Cookie", sessionCookie(role))
          .send(route.body);
        // 404 from the stubbed persistence is fine — the gate let it through, which is the point.
        expect(response.status, `${role} ${route.path}`).not.toBe(403);
      }
    });
  }

  it("401s an anonymous caller on the ack routes", async () => {
    const { app } = createTestApp();
    for (const route of OPERATOR_ROUTES) {
      const response = await request(app)[route.method](route.path).send(route.body);
      expect(response.status, `anon ${route.path}`).toBe(401);
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
