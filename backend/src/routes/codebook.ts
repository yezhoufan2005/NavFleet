import express from "express";
import { parseCodebook } from "@navfleet/shared";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";
import { expectedConfigVersion, parseOrRespond, sendConfigVersion } from "./helpers";

/**
 * Report-code dictionary API.
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
    sendConfigVersion(response, store.getConfigVersion("codebook"));
    response.json({ items: store.getCodebook() });
  });

  router.put("/codebook", requireCapability("codebook:write"), async (request, response) => {
    // The body may be a bare array or `{ items: [...] }`; `parseCodebook` wants the array.
    const body: unknown = request.body;
    const rawEntries =
      body && typeof body === "object" && !Array.isArray(body) && "items" in body
        ? body.items
        : body;

    // Validate up front so an invalid payload is a 400 and nothing is written; a genuine
    // write/reload failure below rejects into the error middleware (500) rather than reading as a 400.
    if (parseOrRespond(response, "invalid_codebook", () => parseCodebook(rawEntries)) === undefined)
      return;

    const items = await store.importCodebook(rawEntries, expectedConfigVersion(request));
    void audit.record({
      actor: request.user!.username,
      action: "codebook_import",
      requestId: request.requestId,
      detail: { entryCount: items.length },
    });
    sendConfigVersion(response, store.getConfigVersion("codebook"));
    response.json({ items });
  });

  return router;
};
