import express from "express";
import { parseScenes } from "@navfleet/shared";
import { requireCapability } from "../auth/middleware";
import type { DashboardStore } from "../store";
import type { AuditService } from "../audit/service";
import type { SceneAssetKind } from "../configRegistry";
import { sceneIdParamSchema } from "../validation";
import { respondValidationError } from "./helpers";

/**
 * Scene endpoints: read (list / single / Lanelet2 overlay, viewer+), and the Phase 18
 * scene-map management writes (admin-only): a full-array `scenes.json` write and a per-scene
 * backdrop upload. Writing scene config is operator/deployment domain — the console renders
 * these backdrops, it does not push maps to vehicles — so the read-only red line holds, the
 * same reasoning as the codebook import and the device-onboarding wizard.
 */
const SCENE_ASSET_KINDS: readonly SceneAssetKind[] = [
  "image",
  "pointcloud",
  "osm",
  "pointcloudmeta",
];
/** Per-kind upload caps. Point clouds run to tens of MB; everything else is small. The raw body
 *  parser is capped at the largest of these, and the handler enforces the tighter per-kind cap. */
const MAX_ASSET_BYTES: Record<SceneAssetKind, number> = {
  image: 8 * 1024 * 1024,
  pointcloud: 64 * 1024 * 1024,
  osm: 16 * 1024 * 1024,
  pointcloudmeta: 8 * 1024 * 1024,
};
const RAW_LIMIT = "64mb";

export const buildScenesRouter = (store: DashboardStore, audit: AuditService): express.Router => {
  const router = express.Router();

  router.get("/scenes", (_request, response) => {
    response.json({ items: store.getScenes() });
  });

  router.get("/scenes/:sceneId", (request, response, next) => {
    try {
      const parsed = sceneIdParamSchema.safeParse(request.params.sceneId);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const definition = store.getScene(parsed.data);
      if (!definition) {
        response.status(404).json({ error: "scene_not_found" });
        return;
      }
      response.json(definition);
    } catch (error) {
      next(error);
    }
  });

  router.get("/scenes/:sceneId/overlay", (request, response, next) => {
    try {
      const parsed = sceneIdParamSchema.safeParse(request.params.sceneId);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const overlay = store.getSceneOverlay(parsed.data);
      if (!overlay) {
        response.status(404).json({ error: "scene_overlay_not_found" });
        return;
      }
      response.json(overlay);
    } catch (error) {
      next(error);
    }
  });

  // Full-array write of scenes.json (create / edit / remove entries), validate-first like the
  // codebook and device-config writes: an invalid body is a 400 that writes nothing.
  router.put("/scenes", requireCapability("scenes:write"), async (request, response, next) => {
    const body: unknown = request.body;
    const raw =
      body && typeof body === "object" && !Array.isArray(body) && "scenes" in body
        ? (body as Record<string, unknown>).scenes
        : body;
    try {
      parseScenes(raw);
    } catch (validationError) {
      response.status(400).json({
        error: "invalid_scenes",
        detail: validationError instanceof Error ? validationError.message : "invalid scenes",
      });
      return;
    }
    try {
      const saved = await store.writeScenes(raw);
      void audit.record({
        actor: request.user!.username,
        action: "scenes_write",
        requestId: request.requestId,
        detail: { sceneCount: saved.length },
      });
      response.json({ items: saved });
    } catch (error) {
      next(error);
    }
  });

  // Upload one backdrop file for a scene. The body is the raw file bytes; the kind is in the
  // path and the filename is chosen server-side, so nothing client-supplied reaches the path.
  router.put(
    "/scenes/:sceneId/asset/:kind",
    requireCapability("scenes:write"),
    express.raw({ type: () => true, limit: RAW_LIMIT }),
    async (request, response, next) => {
      const parsedId = sceneIdParamSchema.safeParse(request.params.sceneId);
      if (!parsedId.success) {
        respondValidationError(response, parsedId.error);
        return;
      }
      const kind = request.params.kind as SceneAssetKind;
      if (!SCENE_ASSET_KINDS.includes(kind)) {
        response.status(400).json({ error: "invalid_asset_kind" });
        return;
      }
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        response.status(400).json({ error: "empty_upload" });
        return;
      }
      if (body.length > MAX_ASSET_BYTES[kind]) {
        response.status(413).json({ error: "asset_too_large" });
        return;
      }
      try {
        const url = await store.writeSceneAsset(parsedId.data, kind, body);
        void audit.record({
          actor: request.user!.username,
          action: "scene_asset_upload",
          target: parsedId.data,
          requestId: request.requestId,
          detail: { kind, bytes: body.length, url },
        });
        response.json({ url });
      } catch (error) {
        // A content-validation failure (not an SVG/PCD/OSM/JSON) is the caller's problem, a 400;
        // anything else (disk, reload) is a genuine 500 via the error middleware.
        const message = error instanceof Error ? error.message : "";
        if (
          /must be|does not look like|not contain any nodes|valid JSON|invalid sceneId|empty/i.test(
            message,
          )
        ) {
          response.status(400).json({ error: "invalid_asset", detail: message });
          return;
        }
        next(error);
      }
    },
  );

  return router;
};
