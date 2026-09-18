import express from "express";
import { parseCodebook } from "@navfleet/shared";
import { requireRole } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";

/**
 * Report-code dictionary API (Phase 16C-2).
 *
 * `GET /codebook` is read-for-everyone (viewer+, via the session check in `app.ts`): it
 * returns the table **in effect** — the built-in reference table with the deployment's
 * `codebook.json` layered over it — which the device-detail card and the admin reference
 * page render.
 *
 * `PUT /codebook` is `admin`-only: it replaces the deployment codebook. The body is a JSON
 * array of entries (the shape `GET` returns), or `{ items: [...] }`, validated by the shared
 * `parseCodebook` — an invalid payload is a 400 and nothing is written. On success the store
 * persists `codebook.json`, reloads, and returns the merged table; the write needs the
 * config volume to be writable (deploy/docker-compose.yml).
 */
export const buildCodebookRouter = (store: DashboardStore, audit: AuditService): express.Router => {
  const router = express.Router();

  router.get("/codebook", (_request, response) => {
    response.json({ items: store.getCodebook() });
  });

  router.put("/codebook", requireRole("admin"), async (request, response, next) => {
    // The body may be a bare array or `{ items: [...] }`; `parseCodebook` wants the array.
    const body: unknown = request.body;
    const rawEntries =
      body && typeof body === "object" && !Array.isArray(body) && "items" in body
        ? body.items
        : body;

    // Validate up front so an invalid payload is a 400 and nothing is written; a genuine
    // write/reload failure below falls through to `next` (500) rather than reading as a 400.
    try {
      parseCodebook(rawEntries);
    } catch (validationError) {
      response.status(400).json({
        error: "invalid_codebook",
        detail: validationError instanceof Error ? validationError.message : "invalid codebook",
      });
      return;
    }

    try {
      const items = await store.importCodebook(rawEntries);
      void audit.record({
        actor: request.user!.username,
        action: "codebook_import",
        requestId: request.requestId,
        detail: { entryCount: items.length },
      });
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
