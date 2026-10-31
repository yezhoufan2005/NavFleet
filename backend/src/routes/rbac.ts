import express from "express";
import { requireCapability } from "../auth/middleware";
import type { RbacService, RbacError } from "../rbac/service";
import type { AuditService } from "../audit/service";
import { rbacGroupSchema, rbacRoleSchema } from "../validation";
import { makeActionErrorResponder, respondValidationError } from "./helpers";

/** Map a service-layer refusal to an HTTP status; stable `error` code goes in the body. */
const STATUS_BY_ERROR: Record<RbacError, number> = {
  not_found: 404,
  conflict: 409,
  role_in_use: 409,
  unknown_member: 400,
};

const respondActionError = makeActionErrorResponder(STATUS_BY_ERROR);

/** `after` minus `before`, as a set difference that keeps `after`'s order. */
const without = (after: readonly string[], before: readonly string[]): string[] =>
  after.filter((item) => !before.includes(item));

/**
 * Keep only the change lists that have something in them, so a rename-only save does not log
 * four empty arrays.
 */
const nonEmpty = (lists: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0));

const renamed = (before: { name: string } | undefined, name: string) =>
  before && before.name !== name ? { renamedFrom: before.name } : {};

/**
 * Custom roles + user groups management API (1.6.1 RBAC). Gated by `users:manage` — administering
 * who-can-do-what is part of user administration — on top of the session gate in `app.ts`.
 * Validate-first (zod 400 that writes nothing); the service owns semantic refusals (duplicate
 * name → 409, unknown id → 404, deleting a role a group still uses → 409 role_in_use).
 */
export const buildRbacRouter = (rbac: RbacService, audit: AuditService): express.Router => {
  const router = express.Router();

  // The audit rows name what changed. `target` stays the stable id; the detail carries the name
  // and what was added or removed, which is what someone asking "who gave this group users:manage"
  // needs. Before, a group or role row held only its UUID.
  const roleById = (id: string) => rbac.getRoles().find((role) => role.id === id);
  const groupById = (id: string) => rbac.getGroups().find((group) => group.id === id);
  const roleNames = (ids: readonly string[]): string[] => ids.map((id) => roleById(id)?.name ?? id);
  router.use("/rbac", requireCapability("users:manage"));

  // ── Custom roles ──────────────────────────────────────────────────────────────
  router.get("/rbac/roles", (_request, response) => {
    response.json({ roles: rbac.getRoles() });
  });

  router.post("/rbac/roles", async (request, response) => {
    const parsed = rbacRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const result = await rbac.createRole(parsed.data);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "role_create",
      target: result.value.id,
      requestId: request.requestId,
      detail: { name: result.value.name, capabilities: result.value.capabilities },
    });
    response.status(201).json({ role: result.value });
  });
  router.patch("/rbac/roles/:id", async (request, response) => {
    const parsed = rbacRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const before = roleById(String(request.params.id));
    const result = await rbac.updateRole(String(request.params.id), parsed.data);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "role_update",
      target: result.value.id,
      requestId: request.requestId,
      detail: {
        name: result.value.name,
        ...renamed(before, result.value.name),
        ...nonEmpty({
          added: without(result.value.capabilities, before?.capabilities ?? []),
          removed: without(before?.capabilities ?? [], result.value.capabilities),
        }),
      },
    });
    response.json({ role: result.value });
  });

  router.delete("/rbac/roles/:id", async (request, response) => {
    const id = String(request.params.id);
    const before = roleById(id);
    const result = await rbac.deleteRole(id);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "role_delete",
      target: id,
      requestId: request.requestId,
      ...(before ? { detail: { name: before.name } } : {}),
    });
    response.status(204).end();
  });
  // ── User groups ─────────────────────────────────────────────────────────────────
  router.get("/rbac/groups", (_request, response) => {
    response.json({ groups: rbac.getGroups() });
  });

  router.post("/rbac/groups", async (request, response) => {
    const parsed = rbacGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const result = await rbac.createGroup(parsed.data);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "group_create",
      target: result.value.id,
      requestId: request.requestId,
      detail: {
        name: result.value.name,
        roles: roleNames(result.value.roleIds),
        members: result.value.memberUsernames,
      },
    });
    response.status(201).json({ group: result.value });
  });

  router.patch("/rbac/groups/:id", async (request, response) => {
    const parsed = rbacGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const before = groupById(String(request.params.id));
    const result = await rbac.updateGroup(String(request.params.id), parsed.data);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "group_update",
      target: result.value.id,
      requestId: request.requestId,
      detail: {
        name: result.value.name,
        ...renamed(before, result.value.name),
        ...nonEmpty({
          rolesAdded: roleNames(without(result.value.roleIds, before?.roleIds ?? [])),
          rolesRemoved: roleNames(without(before?.roleIds ?? [], result.value.roleIds)),
          membersAdded: without(result.value.memberUsernames, before?.memberUsernames ?? []),
          membersRemoved: without(before?.memberUsernames ?? [], result.value.memberUsernames),
        }),
      },
    });
    response.json({ group: result.value });
  });
  router.delete("/rbac/groups/:id", async (request, response) => {
    const id = String(request.params.id);
    const before = groupById(id);
    const result = await rbac.deleteGroup(id);
    if (!result.ok) {
      respondActionError(response, result.error);
      return;
    }
    void audit.record({
      actor: request.user!.username,
      action: "group_delete",
      target: id,
      requestId: request.requestId,
      ...(before ? { detail: { name: before.name } } : {}),
    });
    response.status(204).end();
  });
  return router;
};
