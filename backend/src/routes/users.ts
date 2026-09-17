import express from "express";
import { requireRole } from "../auth/middleware";
import type { AuthService, AdminActionError } from "../auth/service";
import type { AuditService } from "../audit/service";
import { createUserSchema, resetPasswordSchema, updateUserSchema } from "../validation";
import { respondValidationError } from "./helpers";

/** Map a service-layer refusal to an HTTP status + stable error code. */
const STATUS_BY_ERROR: Record<AdminActionError, number> = {
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  self_forbidden: 409,
};

const respondActionError = (response: express.Response, error: AdminActionError): void => {
  response.status(STATUS_BY_ERROR[error]).json({ error });
};

/**
 * Admin user management API. Every route is admin-only (`requireRole("admin")`), on top of
 * the session gate already applied in `app.ts`. Lockout protection (last admin / self) lives
 * in the service; the router only translates its result to a status code.
 */
export const buildUsersRouter = (authService: AuthService, audit: AuditService): express.Router => {
  const router = express.Router();
  router.use("/users", requireRole("admin"));

  router.get("/users", async (_request, response, next) => {
    try {
      response.json({ users: await authService.listUsers() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/users", async (request, response, next) => {
    try {
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const result = await authService.createUser(parsed.data);
      if (!result.ok) {
        respondActionError(response, result.error);
        return;
      }
      void audit.record({
        actor: request.user!.username,
        action: "user_create",
        target: parsed.data.username,
        requestId: request.requestId,
        detail: { role: parsed.data.role },
      });
      response.status(201).json({ user: result.value });
    } catch (error) {
      next(error);
    }
  });

  router.get("/users/:username", async (request, response, next) => {
    try {
      const user = await authService.getUser(request.params.username);
      if (!user) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      response.json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/users/:username", async (request, response, next) => {
    try {
      const parsed = updateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      // `requireRole` guarantees request.user.
      const result = await authService.updateUser(
        request.user!.username,
        request.params.username,
        parsed.data,
      );
      if (!result.ok) {
        respondActionError(response, result.error);
        return;
      }
      void audit.record({
        actor: request.user!.username,
        action: "user_update",
        target: request.params.username,
        requestId: request.requestId,
        detail: { fields: Object.keys(parsed.data) },
      });
      response.json({ user: result.value });
    } catch (error) {
      next(error);
    }
  });

  router.post("/users/:username/reset-password", async (request, response, next) => {
    try {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const result = await authService.resetPassword(
        request.params.username,
        parsed.data.newPassword,
      );
      if (!result.ok) {
        respondActionError(response, result.error);
        return;
      }
      void audit.record({
        actor: request.user!.username,
        action: "password_reset",
        target: request.params.username,
        requestId: request.requestId,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/users/:username", async (request, response, next) => {
    try {
      const result = await authService.deleteUser(request.user!.username, request.params.username);
      if (!result.ok) {
        respondActionError(response, result.error);
        return;
      }
      void audit.record({
        actor: request.user!.username,
        action: "user_delete",
        target: request.params.username,
        requestId: request.requestId,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
