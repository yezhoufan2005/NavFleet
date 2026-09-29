import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie, type TestAppContext } from "./helpers/testApp";

/**
 * Custom-role + user-group management API (1.6.1 RBAC) and its effect on the capability gate.
 * `createTestApp` wires a real `RbacService` over the stub persistence, so a role/group created
 * through these routes is visible to the same app's auth gate on a later request — which is how
 * the end-to-end "a group grants a capability" case below is exercised.
 */
interface RoleBody {
  role: { id: string; name: string; capabilities: string[] };
}
interface RolesBody {
  roles: RoleBody["role"][];
}
interface GroupBody {
  group: { id: string; name: string };
}
interface MeBody {
  capabilities: string[];
}

const admin = () => sessionCookie("admin", "boss");

const createRole = (ctx: TestAppContext, name: string, capabilities: string[]) =>
  request(ctx.app).post("/api/rbac/roles").set("Cookie", admin()).send({ name, capabilities });

describe("RBAC management API — custom roles", () => {
  it("creates, lists, and orders capabilities of a role", async () => {
    const ctx = createTestApp();
    const created = await createRole(ctx, "Ops", ["notify:read", "alerts:ack"]);
    expect(created.status).toBe(201);
    const { role } = created.body as RoleBody;
    expect(role.id).toBeTruthy();
    expect(role.capabilities).toEqual(["alerts:ack", "notify:read"]);
    expect(ctx.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "role_create" }),
    );

    const listed = await request(ctx.app).get("/api/rbac/roles").set("Cookie", admin());
    expect(listed.status).toBe(200);
    expect((listed.body as RolesBody).roles).toHaveLength(1);
  });

  it("rejects an unknown capability with 400 (writes nothing)", async () => {
    const ctx = createTestApp();
    const response = await createRole(ctx, "Bad", ["fly:planes"]);
    expect(response.status).toBe(400);
  });

  it("409s a duplicate role name", async () => {
    const ctx = createTestApp();
    await createRole(ctx, "Ops", []);
    const dup = await createRole(ctx, "Ops", []);
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "conflict" });
  });

  it("404s a patch of an unknown role", async () => {
    const ctx = createTestApp();
    const response = await request(ctx.app)
      .patch("/api/rbac/roles/ghost")
      .set("Cookie", admin())
      .send({ name: "x", capabilities: [] });
    expect(response.status).toBe(404);
  });

  it("409s deleting a role a group still references, 204 once it is freed", async () => {
    const ctx = createTestApp();
    const role = await createRole(ctx, "Ackers", ["alerts:ack"]);
    const roleId = (role.body as RoleBody).role.id;
    const group = await request(ctx.app)
      .post("/api/rbac/groups")
      .set("Cookie", admin())
      .send({ name: "Shift", roleIds: [roleId], memberUsernames: ["bob"] });
    expect(group.status).toBe(201);

    const blocked = await request(ctx.app)
      .delete(`/api/rbac/roles/${roleId}`)
      .set("Cookie", admin());
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: "role_in_use" });

    const groupId = (group.body as GroupBody).group.id;
    await request(ctx.app).delete(`/api/rbac/groups/${groupId}`).set("Cookie", admin());
    const freed = await request(ctx.app).delete(`/api/rbac/roles/${roleId}`).set("Cookie", admin());
    expect(freed.status).toBe(204);
  });
});

describe("RBAC groups grant capabilities to their members (end-to-end)", () => {
  const seedAckGroup = async (ctx: TestAppContext) => {
    const role = await createRole(ctx, "Ackers", ["alerts:ack"]);
    await request(ctx.app)
      .post("/api/rbac/groups")
      .set("Cookie", admin())
      .send({
        name: "Shift",
        roleIds: [(role.body as RoleBody).role.id],
        memberUsernames: ["bob"],
      });
  };

  it("lets a grouped viewer through the operator-gated ack route, but not a plain viewer", async () => {
    const ctx = createTestApp();
    await seedAckGroup(ctx);
    const body = { deviceId: "agv-01", alertId: "a1" };

    // bob is a viewer, but his group carries alerts:ack — the gate lets him through (404 from the
    // stubbed persistence, not 403). alice, a plain viewer, is refused at the gate.
    const grouped = await request(ctx.app)
      .post("/api/alerts/ack")
      .set("Cookie", sessionCookie("viewer", "bob"))
      .send(body);
    expect(grouped.status).not.toBe(403);
    const plain = await request(ctx.app)
      .post("/api/alerts/ack")
      .set("Cookie", sessionCookie("viewer", "alice"))
      .send(body);
    expect(plain.status).toBe(403);
  });

  it("reflects the group's capabilities in GET /me", async () => {
    const ctx = createTestApp();
    await seedAckGroup(ctx);
    const me = await request(ctx.app)
      .get("/api/auth/me")
      .set("Cookie", sessionCookie("viewer", "bob"));
    expect(me.status).toBe(200);
    expect((me.body as MeBody).capabilities).toEqual(["alerts:ack"]);
  });
});
