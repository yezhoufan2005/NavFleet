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

  it("404s an update/delete of an unknown role", async () => {
    const { service } = await build();
    expect(await service.updateRole("nope", { name: "x", capabilities: [] })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await service.deleteRole("nope")).toEqual({ ok: false, error: "not_found" });
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
});
