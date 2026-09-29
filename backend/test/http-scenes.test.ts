import { describe, it, expect } from "vitest";
import request from "supertest";
import type { SceneMapDefinition } from "@navfleet/shared";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * Scene-map management API (Phase 18). The admin-only gate is pinned in http-rbac; here we cover
 * the router → store wiring: a valid scenes PUT validates + writes + audits, an invalid body is a
 * 400 that never touches the store, and the backdrop upload passes the raw bytes through with the
 * kind/size guards (empty, unknown kind, over the per-kind cap). Content validation itself lives
 * in the config registry and is covered against a real temp dir in config-registry.test.ts.
 */
const ADMIN = sessionCookie("admin", "admin-1");

const SCENE: SceneMapDefinition = {
  sceneId: "yard",
  sceneName: "北区堆场",
  mapFrame: "map",
  resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
  width: 800,
  height: 600,
};

describe("PUT /api/scenes", () => {
  it("validates, writes, audits, and returns the scenes", async () => {
    const context = createTestApp();
    context.store.writeScenes.mockResolvedValue([SCENE]);

    const response = await request(context.app)
      .put("/api/scenes")
      .set("Cookie", ADMIN)
      .send({ scenes: [SCENE] });

    expect(response.status).toBe(200);
    expect((response.body as { items: unknown[] }).items).toEqual([SCENE]);
    expect(context.store.writeScenes).toHaveBeenCalledWith([SCENE]);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin-1", action: "scenes_write" }),
    );
  });

  it("400s an invalid scenes payload without writing or auditing", async () => {
    const context = createTestApp();

    const response = await request(context.app)
      .put("/api/scenes")
      .set("Cookie", ADMIN)
      .send({ scenes: [{ ...SCENE, resolution: 0 }] });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_scenes");
    expect(context.store.writeScenes).not.toHaveBeenCalled();
    expect(context.auditService.record).not.toHaveBeenCalled();
  });

  it("400s a path-unsafe sceneId", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .put("/api/scenes")
      .set("Cookie", ADMIN)
      .send({ scenes: [{ ...SCENE, sceneId: "../etc/passwd" }] });

    expect(response.status).toBe(400);
    expect(context.store.writeScenes).not.toHaveBeenCalled();
  });
});

describe("PUT /api/scenes/:sceneId/asset/:kind", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");

  it("stores an uploaded backdrop, audits, and returns its URL", async () => {
    const context = createTestApp();
    context.store.writeSceneAsset.mockResolvedValue("/scene-maps/yard/image.svg");

    const response = await request(context.app)
      .put("/api/scenes/yard/asset/image")
      .set("Cookie", ADMIN)
      .set("Content-Type", "image/svg+xml")
      .send(svg);

    expect(response.status).toBe(200);
    expect((response.body as { url: string }).url).toBe("/scene-maps/yard/image.svg");
    expect(context.store.writeSceneAsset).toHaveBeenCalledWith("yard", "image", expect.any(Buffer));
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin-1", action: "scene_asset_upload", target: "yard" }),
    );
  });

  it("400s an unknown asset kind", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .put("/api/scenes/yard/asset/bogus")
      .set("Cookie", ADMIN)
      .set("Content-Type", "application/octet-stream")
      .send(svg);

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_asset_kind");
    expect(context.store.writeSceneAsset).not.toHaveBeenCalled();
  });

  it("400s an empty upload", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .put("/api/scenes/yard/asset/image")
      .set("Cookie", ADMIN)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("empty_upload");
    expect(context.store.writeSceneAsset).not.toHaveBeenCalled();
  });

  it("413s an image over the per-kind cap before touching the store", async () => {
    const context = createTestApp();
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1);
    const response = await request(context.app)
      .put("/api/scenes/yard/asset/image")
      .set("Cookie", ADMIN)
      .set("Content-Type", "application/octet-stream")
      .send(tooBig);

    expect(response.status).toBe(413);
    expect((response.body as { error: string }).error).toBe("asset_too_large");
    expect(context.store.writeSceneAsset).not.toHaveBeenCalled();
  });
});
