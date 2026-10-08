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
};

const respondActionError = makeActionErrorResponder(STATUS_BY_ERROR);

/**
 * Custom roles + user groups management API (1.6.1 RBAC). Gated by `users:manage` — administering
 * who-can-do-what is part of user administration — on top of the session gate in `app.ts`.
 * Validate-first (zod 400 that writes nothing); the service owns semantic refusals (duplicate
 * name → 409, unknown id → 404, deleting a role a group still uses → 409 role_in_use).
 */
export const buildRbacRouter = (rbac: RbacService, audit: AuditService): express.Router => {
  const router = express.Router();
  router.use("/rbac", requireCapability("users:manage"));

  // ── Custom roles ──────────────────────────────────────────────────────────────
  router.get("/rbac/roles", (_request, response) => {
    response.json({ roles: rbac.getRoles() });
  });

  router.post("/rbac/roles", async (request, response, next) => {
    try {
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
      });
      response.status(201).json({ role: result.value });
    } catch (error) {
      next(error);
    }
  });
  router.patch("/rbac/roles/:id", async (request, response, next) => {
    try {
      const parsed = rbacRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
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
      });
      response.json({ role: result.value });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/rbac/roles/:id", async (request, response, next) => {
    try {
      const id = String(request.params.id);
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
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  // ── User groups ─────────────────────────────────────────────────────────────────
  router.get("/rbac/groups", (_request, response) => {
    response.json({ groups: rbac.getGroups() });
  });

  router.post("/rbac/groups", async (request, response, next) => {
    try {
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
      });
      response.status(201).json({ group: result.value });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/rbac/groups/:id", async (request, response, next) => {
    try {
      const parsed = rbacGroupSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
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
      });
      response.json({ group: result.value });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/rbac/groups/:id", async (request, response, next) => {
    try {
      const id = String(request.params.id);
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
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
};
