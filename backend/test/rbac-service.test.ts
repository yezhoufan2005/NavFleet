import { describe, it, expect } from "vitest";
import type { Persistence } from "../src/persistence";
import { RbacService } from "../src/rbac/service";
import type { RbacGroup, RbacRole } from "@navfleet/shared";

/** Minimal in-memory persistence double: RbacService only calls these two methods. */
const memoryPersistence = () => {
  let state: { roles: RbacRole[]; groups: RbacGroup[] } = { roles: [], groups: [] };
  return {
    persistence: {
      loadRbacState: async () => ({ roles: [...state.roles], groups: [...state.groups] }),
      saveRbacState: async (next: { roles: RbacRole[]; groups: RbacGroup[] }) => {
        state = { roles: [...next.roles], groups: [...next.groups] };
      },
    } as unknown as Persistence,
    read: () => state,
  };
};

const build = async () => {
  const { persistence, read } = memoryPersistence();
  const service = new RbacService(persistence);
  await service.init();
  return { service, read };
};

describe("RbacService — custom roles", () => {
  it("creates a role, ordering + deduping its capabilities, and persists whole", async () => {
    const { service, read } = await build();
    const result = await service.createRole({
      name: "Ops",
      // Out of canonical order, with a duplicate — the service normalizes both.
      capabilities: ["notify:read", "alerts:ack", "alerts:ack"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capabilities).toEqual(["alerts:ack", "notify:read"]);
    expect(service.getRoles()).toHaveLength(1);
    expect(read().roles).toHaveLength(1); // persisted
  });

  it("refuses a duplicate role name with conflict", async () => {
    const { service } = await build();
    await service.createRole({ name: "Ops", capabilities: [] });
    const dup = await service.createRole({ name: "Ops", capabilities: [] });
    expect(dup).toEqual({ ok: false, error: "conflict" });
  });

  it("refuses to delete a role a group still references (role_in_use)", async () => {
    const { service } = await build();
    const role = await service.createRole({ name: "Ackers", capabilities: ["alerts:ack"] });
    if (!role.ok) throw new Error("setup");
    await service.createGroup({
      name: "Shift",
      roleIds: [role.value.id],
      memberUsernames: ["bob"],
    });
    expect(await service.deleteRole(role.value.id)).toEqual({ ok: false, error: "role_in_use" });
  });

  it("deletes a role no group references", async () => {
    const { service, read } = await build();
    const role = await service.createRole({ name: "Spare", capabilities: [] });
    if (!role.ok) throw new Error("setup");
    expect(await service.deleteRole(role.value.id)).toEqual({ ok: true, value: null });
    expect(read().roles).toEqual([]);
  });

  it("404s an update/delete of an unknown role", async () => {
    const { service } = await build();
    expect(await service.updateRole("nope", { name: "x", capabilities: [] })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await service.deleteRole("nope")).toEqual({ ok: false, error: "not_found" });
  });

  it("updates a role in place, re-normalizing its capabilities", async () => {
    const { service, read } = await build();
    const role = await service.createRole({ name: "Ops", capabilities: [] });
    if (!role.ok) throw new Error("setup");
    const updated = await service.updateRole(role.value.id, {
      name: "Ops2",
      capabilities: ["notify:read", "alerts:ack"],
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { id: role.value.id, name: "Ops2", capabilities: ["alerts:ack", "notify:read"] },
    });
    expect(read().roles.map((r) => r.name)).toEqual(["Ops2"]);
  });

  it("refuses renaming a role onto another role's name, but allows keeping its own", async () => {
    const { service } = await build();
    await service.createRole({ name: "A", capabilities: [] });
    const b = await service.createRole({ name: "B", capabilities: [] });
    if (!b.ok) throw new Error("setup");
    expect(await service.updateRole(b.value.id, { name: "A", capabilities: [] })).toEqual({
      ok: false,
      error: "conflict",
    });
    expect((await service.updateRole(b.value.id, { name: "B", capabilities: [] })).ok).toBe(true);
  });
});

describe("RbacService — persist failure", () => {
  it("rolls the cache back and rethrows when saveRbacState fails", async () => {
    const { service } = await build();
    await service.createRole({ name: "Kept", capabilities: [] });
    const failing = service as unknown as { persistence: { saveRbacState: () => Promise<void> } };
    failing.persistence.saveRbacState = () => Promise.reject(new Error("disk full"));

    await expect(service.createRole({ name: "Lost", capabilities: [] })).rejects.toThrow(
      "disk full",
    );
    // Memory must not run ahead of disk: the failed role is gone, the earlier one survives.
    expect(service.getRoles().map((role) => role.name)).toEqual(["Kept"]);
  });
});

describe("RbacService — groups + capability resolution", () => {
  it("adds a group's role capabilities to a member's base role", async () => {
    const { service } = await build();
    const role = await service.createRole({ name: "Ackers", capabilities: ["alerts:ack"] });
    if (!role.ok) throw new Error("setup");
    await service.createGroup({
      name: "Shift",
      roleIds: [role.value.id],
      memberUsernames: ["bob"],
    });
    // A plain viewer has no capabilities; the same viewer in the group gains exactly the ack cap.
    expect(service.resolveCapabilities({ username: "alice", role: "viewer" })).toEqual([]);
    expect(service.resolveCapabilities({ username: "bob", role: "viewer" })).toEqual([
      "alerts:ack",
    ]);
  });

  it("never augments a kiosk account through groups (stays read-only)", async () => {
    const { service } = await build();
    const role = await service.createRole({ name: "Writers", capabilities: ["scenes:write"] });
    if (!role.ok) throw new Error("setup");
    await service.createGroup({
      name: "Wall",
      roleIds: [role.value.id],
      memberUsernames: ["kioskbob"],
    });
    expect(
      service.resolveCapabilities({ username: "kioskbob", role: "viewer", kiosk: true }),
    ).toEqual([]);
  });

  it("refuses a group referencing an unknown role", async () => {
    const { service } = await build();
    expect(
      await service.createGroup({ name: "Bad", roleIds: ["ghost"], memberUsernames: [] }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("updates a group, deduping roles and members", async () => {
    const { service } = await build();
    const role = await service.createRole({ name: "R", capabilities: ["alerts:ack"] });
    const group = await service.createGroup({ name: "G", roleIds: [], memberUsernames: [] });
    if (!role.ok || !group.ok) throw new Error("setup");
    const updated = await service.updateGroup(group.value.id, {
      name: "G2",
      description: "night shift",
      roleIds: [role.value.id, role.value.id],
      memberUsernames: ["bob", "bob"],
    });
    expect(updated).toMatchObject({
      ok: true,
      value: {
        name: "G2",
        description: "night shift",
        roleIds: [role.value.id],
        memberUsernames: ["bob"],
      },
    });
    expect(service.resolveCapabilities({ username: "bob", role: "viewer" })).toEqual([
      "alerts:ack",
    ]);
  });

  it("refuses a group update that is unknown, name-colliding, or references an unknown role", async () => {
    const { service } = await build();
    await service.createGroup({ name: "A", roleIds: [], memberUsernames: [] });
    const b = await service.createGroup({ name: "B", roleIds: [], memberUsernames: [] });
    if (!b.ok) throw new Error("setup");
    const input = { roleIds: [], memberUsernames: [] };
    expect(await service.updateGroup("nope", { name: "X", ...input })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await service.updateGroup(b.value.id, { name: "A", ...input })).toEqual({
      ok: false,
      error: "conflict",
    });
    expect(
      await service.updateGroup(b.value.id, { name: "B", roleIds: ["ghost"], memberUsernames: [] }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("deletes a group (and 404s an unknown one)", async () => {
    const { service, read } = await build();
    const group = await service.createGroup({ name: "G", roleIds: [], memberUsernames: ["bob"] });
    if (!group.ok) throw new Error("setup");
    expect(await service.deleteGroup(group.value.id)).toEqual({ ok: true, value: null });
    expect(read().groups).toEqual([]);
    expect(await service.deleteGroup(group.value.id)).toEqual({ ok: false, error: "not_found" });
  });

  it("removeMemberFromAllGroups drops a user from every group and revokes its added caps", async () => {
    const { service, read } = await build();
    const role = await service.createRole({ name: "Ackers", capabilities: ["alerts:ack"] });
    if (!role.ok) throw new Error("setup");
    await service.createGroup({
      name: "A",
      roleIds: [role.value.id],
      memberUsernames: ["bob", "amy"],
    });
    await service.createGroup({ name: "B", roleIds: [role.value.id], memberUsernames: ["bob"] });
    // Precondition: the groups lift bob to alerts:ack.
    expect(service.resolveCapabilities({ username: "bob", role: "viewer" })).toEqual([
      "alerts:ack",
    ]);

    expect(await service.removeMemberFromAllGroups("bob")).toEqual({ ok: true, value: null });

    // bob is gone from both groups (so recreating the name inherits nothing); amy is untouched.
    expect(service.resolveCapabilities({ username: "bob", role: "viewer" })).toEqual([]);
    expect(service.resolveCapabilities({ username: "amy", role: "viewer" })).toEqual([
      "alerts:ack",
    ]);
    expect(read().groups.flatMap((group) => group.memberUsernames)).toEqual(["amy"]);
  });

  it("removeMemberFromAllGroups is a no-op (no write) when the name is in no group", async () => {
    const { service, read } = await build();
    await service.createGroup({ name: "A", roleIds: [], memberUsernames: ["amy"] });
    const before = read().groups;
    expect(await service.removeMemberFromAllGroups("ghost")).toEqual({ ok: true, value: null });
    // Same array reference proves saveRbacState was never called for a name that changed nothing.
    expect(read().groups).toBe(before);
  });
});
