import { describe, it, expect } from "vitest";
import request from "supertest";
import type { AuditInput } from "../src/audit/service";
import { createTestApp, sessionCookie, type TestAppContext } from "./helpers/testApp";

/**
 * What an audit row says about a change. A `user_update` row used to list every field the editor
 * sent back, with no values, and a role or group row held only its UUID, so "who gave this group
 * users:manage" could not be answered from the log.
 */
const ADMIN = sessionCookie("admin", "root");

const recorded = (context: TestAppContext, action: string) =>
  context.auditService.record.mock.calls
    .map((call) => call[0] as AuditInput)
    .filter((entry) => entry.action === action);

describe("user_update audit detail", () => {
  it("lists only the fields that changed, with old and new values", async () => {
    const context = createTestApp();
    // The stub user is a viewer named `bob`, enabled, with no email.
    await request(context.app)
      .patch("/api/users/bob")
      .set("Cookie", ADMIN)
      .send({ role: "operator", displayName: "bob", enabled: true, email: "bob@example.com" });

    const [entry] = recorded(context, "user_update");
    expect(entry?.detail).toEqual({
      fields: ["role", "email"],
      changes: { role: { from: "viewer", to: "operator" } },
    });
  });

  it("records an empty change list for a save that changed nothing", async () => {
    const context = createTestApp();
    await request(context.app)
      .patch("/api/users/bob")
      .set("Cookie", ADMIN)
      .send({ role: "viewer", displayName: "bob" });
    expect(recorded(context, "user_update")[0]?.detail).toEqual({ fields: [], changes: {} });
  });
});

describe("role and group audit detail", () => {
  it("names the role and the capabilities a save added and removed", async () => {
    const context = createTestApp();
    const created = await request(context.app)
      .post("/api/rbac/roles")
      .set("Cookie", ADMIN)
      .send({ name: "Ops", capabilities: ["alerts:ack", "notify:read"] });
    const { id } = (created.body as { role: { id: string } }).role;
    expect(recorded(context, "role_create")[0]?.detail).toEqual({
      name: "Ops",
      capabilities: ["alerts:ack", "notify:read"],
    });

    await request(context.app)
      .patch(`/api/rbac/roles/${id}`)
      .set("Cookie", ADMIN)
      .send({ name: "Operations", capabilities: ["alerts:ack", "users:manage"] });
    expect(recorded(context, "role_update")[0]?.detail).toEqual({
      name: "Operations",
      renamedFrom: "Ops",
      added: ["users:manage"],
      removed: ["notify:read"],
    });

    await request(context.app).delete(`/api/rbac/roles/${id}`).set("Cookie", ADMIN);
    expect(recorded(context, "role_delete")[0]?.detail).toEqual({ name: "Operations" });
  });

  it("names the group, and the roles and members a save added and removed", async () => {
    const context = createTestApp();
    const role = await request(context.app)
      .post("/api/rbac/roles")
      .set("Cookie", ADMIN)
      .send({ name: "Admins", capabilities: ["users:manage"] });
    const roleId = (role.body as { role: { id: string } }).role.id;
    const created = await request(context.app)
      .post("/api/rbac/groups")
      .set("Cookie", ADMIN)
      .send({ name: "Shift", roleIds: [], memberUsernames: ["bob"] });
    const { id } = (created.body as { group: { id: string } }).group;
    expect(recorded(context, "group_create")[0]?.detail).toEqual({
      name: "Shift",
      roles: [],
      members: ["bob"],
    });

    await request(context.app)
      .patch(`/api/rbac/groups/${id}`)
      .set("Cookie", ADMIN)
      .send({ name: "Shift", roleIds: [roleId], memberUsernames: ["carol"] });
    expect(recorded(context, "group_update")[0]?.detail).toEqual({
      name: "Shift",
      rolesAdded: ["Admins"],
      membersAdded: ["carol"],
      membersRemoved: ["bob"],
    });

    await request(context.app).delete(`/api/rbac/groups/${id}`).set("Cookie", ADMIN);
    expect(recorded(context, "group_delete")[0]?.detail).toEqual({ name: "Shift" });
  });
});
