import { randomUUID } from "node:crypto";
import type { Persistence } from "../persistence";
import {
  CAPABILITIES,
  resolveEffectiveCapabilities,
  type Capability,
  type RbacGroup,
  type RbacRole,
  type UserRole,
} from "@navfleet/shared";

export type RbacError = "not_found" | "conflict" | "role_in_use";
export type RbacResult<T> = { ok: true; value: T } | { ok: false; error: RbacError };

export interface RoleInput {
  name: string;
  capabilities: Capability[];
}
export interface GroupInput {
  name: string;
  description?: string;
  roleIds: string[];
  memberUsernames: string[];
}

const ok = <T>(value: T): RbacResult<T> => ({ ok: true, value });
const fail = <T>(error: RbacError): RbacResult<T> => ({ ok: false, error });

/** Dedupe + order by the canonical capability order, so stored roles are deterministic. */
const orderedCaps = (caps: Capability[]): Capability[] =>
  CAPABILITIES.filter((capability) => caps.includes(capability));
const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * Custom roles + user groups (1.6.1 RBAC). Holds the whole state in memory — low-cardinality and
 * single-instance — so the per-request capability resolver never hits the DB. Every mutation
 * validates against the cache, applies the change, then persists — rolling the cache back if the
 * write fails, so the in-memory state never drifts ahead of disk.
 *
 * Users keep their built-in base `role`; these only **add** capabilities via group membership, so
 * the `UserRole` closed enum (validated front and back) is untouched.
 */
export class RbacService {
  private roles: RbacRole[] = [];
  private groups: RbacGroup[] = [];

  constructor(private readonly persistence: Persistence) {}

  async init(): Promise<void> {
    const state = await this.persistence.loadRbacState();
    this.roles = state.roles;
    this.groups = state.groups;
  }

  getRoles(): RbacRole[] {
    return this.roles.map((role) => ({ ...role }));
  }
  getGroups(): RbacGroup[] {
    return this.groups.map((group) => ({ ...group }));
  }

  /** Effective capabilities = base role preset ∪ (non-kiosk) its groups' roles' capabilities. */
  resolveCapabilities(user: { username: string; role: UserRole; kiosk?: boolean }): Capability[] {
    return resolveEffectiveCapabilities(user, this.roles, this.groups);
  }

  private async persist(): Promise<void> {
    await this.persistence.saveRbacState({ roles: this.roles, groups: this.groups });
  }

  /**
   * Persist the whole state, restoring the pre-mutation snapshot if the write throws. The cache is
   * mutated optimistically (the resolver reads it on the hot path), so without this a failed
   * `saveRbacState` would leave memory ahead of disk until the next restart silently reverted it;
   * callers propagate the rethrow as a 500. `roles`/`groups` are only ever replaced wholesale
   * (never mutated in place), so holding the old array references is a sound snapshot.
   */
  private async persistWithRollback(snapshot: {
    roles: RbacRole[];
    groups: RbacGroup[];
  }): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      this.roles = snapshot.roles;
      this.groups = snapshot.groups;
      throw error;
    }
  }

  // ── Custom roles ──────────────────────────────────────────────────────────────
  async createRole(input: RoleInput): Promise<RbacResult<RbacRole>> {
    if (this.roles.some((role) => role.name === input.name)) return fail("conflict");
    const now = new Date().toISOString();
    const role: RbacRole = {
      id: randomUUID(),
      name: input.name,
      capabilities: orderedCaps(input.capabilities),
      createdAt: now,
      updatedAt: now,
    };
    const snapshot = { roles: this.roles, groups: this.groups };
    this.roles = [...this.roles, role];
    await this.persistWithRollback(snapshot);
    return ok(role);
  }

  async updateRole(id: string, input: RoleInput): Promise<RbacResult<RbacRole>> {
    const existing = this.roles.find((role) => role.id === id);
    if (!existing) return fail("not_found");
    if (this.roles.some((role) => role.id !== id && role.name === input.name))
      return fail("conflict");
    const updated: RbacRole = {
      ...existing,
      name: input.name,
      capabilities: orderedCaps(input.capabilities),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = { roles: this.roles, groups: this.groups };
    this.roles = this.roles.map((role) => (role.id === id ? updated : role));
    await this.persistWithRollback(snapshot);
    return ok(updated);
  }

  async deleteRole(id: string): Promise<RbacResult<null>> {
    if (!this.roles.some((role) => role.id === id)) return fail("not_found");
    // Refuse while a group still references it — the admin removes it from the group first, so a
    // delete can never silently strip capabilities from a group's members.
    if (this.groups.some((group) => group.roleIds.includes(id))) return fail("role_in_use");
    const snapshot = { roles: this.roles, groups: this.groups };
    this.roles = this.roles.filter((role) => role.id !== id);
    await this.persistWithRollback(snapshot);
    return ok(null);
  }

  // ── User groups ─────────────────────────────────────────────────────────────────
  async createGroup(input: GroupInput): Promise<RbacResult<RbacGroup>> {
    if (this.groups.some((group) => group.name === input.name)) return fail("conflict");
    if (input.roleIds.some((roleId) => !this.roles.some((role) => role.id === roleId)))
      return fail("not_found");
    const now = new Date().toISOString();
    const group: RbacGroup = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      roleIds: unique(input.roleIds),
      memberUsernames: unique(input.memberUsernames),
      createdAt: now,
      updatedAt: now,
    };
    const snapshot = { roles: this.roles, groups: this.groups };
    this.groups = [...this.groups, group];
    await this.persistWithRollback(snapshot);
    return ok(group);
  }

  async updateGroup(id: string, input: GroupInput): Promise<RbacResult<RbacGroup>> {
    const existing = this.groups.find((group) => group.id === id);
    if (!existing) return fail("not_found");
    if (this.groups.some((group) => group.id !== id && group.name === input.name))
      return fail("conflict");
    if (input.roleIds.some((roleId) => !this.roles.some((role) => role.id === roleId)))
      return fail("not_found");
    const updated: RbacGroup = {
      ...existing,
      name: input.name,
      description: input.description ?? "",
      roleIds: unique(input.roleIds),
      memberUsernames: unique(input.memberUsernames),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = { roles: this.roles, groups: this.groups };
    this.groups = this.groups.map((group) => (group.id === id ? updated : group));
    await this.persistWithRollback(snapshot);
    return ok(updated);
  }

  async deleteGroup(id: string): Promise<RbacResult<null>> {
    if (!this.groups.some((group) => group.id === id)) return fail("not_found");
    const snapshot = { roles: this.roles, groups: this.groups };
    this.groups = this.groups.filter((group) => group.id !== id);
    await this.persistWithRollback(snapshot);
    return ok(null);
  }
}
