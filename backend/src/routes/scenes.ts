import express from "express";
import type { DashboardStore } from "../store";
import { sceneIdParamSchema } from "../validation";
import { respondValidationError } from "./helpers";

/** Scene endpoints: list, single definition, and Lanelet2 overlay. */
export const buildScenesRouter = (store: DashboardStore): express.Router => {
  const router = express.Router();

  router.get("/scenes", (_request, response) => {
    response.json({ items: store.getScenes() });
  });

  router.get("/scenes/:sceneId", async (request, response, next) => {
    try {
      const parsed = sceneIdParamSchema.safeParse(request.params.sceneId);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const definition = await store.getScene(parsed.data);
      if (!definition) {
        response.status(404).json({ error: "scene_not_found" });
        return;
      }
      response.json(definition);
    } catch (error) {
      next(error);
    }
  });

  router.get("/scenes/:sceneId/overlay", async (request, response, next) => {
    try {
      const parsed = sceneIdParamSchema.safeParse(request.params.sceneId);
      if (!parsed.success) {
        respondValidationError(response, parsed.error);
        return;
      }
      const overlay = await store.getSceneOverlay(parsed.data);
      if (!overlay) {
        response.status(404).json({ error: "scene_overlay_not_found" });
        return;
      }
      response.json(overlay);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
