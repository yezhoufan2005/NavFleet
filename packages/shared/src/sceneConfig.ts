/**
 * Validator for the operator-editable `scenes.json`, used when the admin **scene-map
 * upload & management** page writes it through the API (Phase 18). Mirrors `parseVehicles`
 * / `parseCodebook`: hand-rolled, throwing a labelled message on the first problem, so an
 * invalid payload is a 400 that writes nothing, and the backend re-validates as the
 * authority even though the client validates too.
 *
 * `overlayUrl` / `overlayType` are **server-minted** for OSM scenes (the backend parses the
 * `.osm` at load and points them at `/api/scenes/:id/overlay`). They are dropped here rather
 * than trusted from the client — a caller cannot forge an overlay endpoint.
 */

import type { SceneMapDefinition } from "./index";

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

/** Same charset the on-disk asset resolver trusts (`sceneIdParamSchema`): a scene id becomes a
 *  path segment under `scene-maps/`, so it must never carry a separator or be dot-only. */
const sceneId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const id = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id) || /^\.+$/.test(id)) {
    throw new Error(
      `${label} may only contain letters, digits, dot, underscore, hyphen`,
    );
  }
  return id;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim() === "" ? undefined : value;
};

/** An asset URL the console will fetch: it must live under `/scene-maps/`, the one tree the
 *  backend serves and the traversal guard confines writes to. */
const optionalAssetUrl = (
  value: unknown,
  label: string,
): string | undefined => {
  const url = optionalString(value, label);
  if (url === undefined) return undefined;
  if (!url.startsWith("/scene-maps/")) {
    throw new Error(`${label} must start with /scene-maps/`);
  }
  return url;
};

// APPEND-MARKER

const requireFinite = (value: unknown, label: string): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
  return n;
};

const requirePositive = (value: unknown, label: string): number => {
  const n = requireFinite(value, label);
  if (n <= 0) throw new Error(`${label} must be greater than 0`);
  return n;
};

const optionalFinite = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  return requireFinite(value, label);
};

const parseOrigin = (
  value: unknown,
  label: string,
): SceneMapDefinition["origin"] => {
  if (value === undefined || value === null) return { x: 0, y: 0, yaw: 0 };
  const raw = asObject(value, label);
  return {
    x: requireFinite(raw.x, `${label}.x`),
    y: requireFinite(raw.y, `${label}.y`),
    yaw: requireFinite(raw.yaw, `${label}.yaw`),
  };
};

const parseBounds = (
  value: unknown,
  label: string,
): SceneMapDefinition["bounds"] => {
  if (value === undefined || value === null) return undefined;
  const raw = asObject(value, label);
  return {
    minX: requireFinite(raw.minX, `${label}.minX`),
    maxX: requireFinite(raw.maxX, `${label}.maxX`),
    minY: requireFinite(raw.minY, `${label}.minY`),
    maxY: requireFinite(raw.maxY, `${label}.maxY`),
  };
};

const parseDefaultView = (
  value: unknown,
  label: string,
): SceneMapDefinition["defaultView"] => {
  if (value === undefined || value === null) return undefined;
  const raw = asObject(value, label);
  return {
    zoom: requireFinite(raw.zoom, `${label}.zoom`),
    centerX: requireFinite(raw.centerX, `${label}.centerX`),
    centerY: requireFinite(raw.centerY, `${label}.centerY`),
  };
};

const parseProjectionOrigin = (
  value: unknown,
  label: string,
): SceneMapDefinition["osmProjectionOrigin"] => {
  if (value === undefined || value === null) return undefined;
  const raw = asObject(value, label);
  return {
    lat: requireFinite(raw.lat, `${label}.lat`),
    lng: requireFinite(raw.lng, `${label}.lng`),
  };
};

/**
 * Validate one scene definition. `overlayUrl`/`overlayType` are intentionally NOT read from
 * the input — the backend mints them for OSM scenes at load time.
 */
const parseScene = (value: unknown, label: string): SceneMapDefinition => {
  const raw = asObject(value, label);
  const id = sceneId(raw.sceneId, `${label}.sceneId`);
  const scene: SceneMapDefinition = {
    sceneId: id,
    sceneName: optionalString(raw.sceneName, `${label}.sceneName`) ?? id,
    mapFrame: optionalString(raw.mapFrame, `${label}.mapFrame`) ?? "map",
    resolution: requirePositive(raw.resolution, `${label}.resolution`),
    origin: parseOrigin(raw.origin, `${label}.origin`),
    width: requirePositive(raw.width, `${label}.width`),
    height: requirePositive(raw.height, `${label}.height`),
  };

  const imageUrl = optionalAssetUrl(raw.imageUrl, `${label}.imageUrl`);
  if (imageUrl) scene.imageUrl = imageUrl;
  const osmUrl = optionalAssetUrl(raw.osmUrl, `${label}.osmUrl`);
  if (osmUrl) scene.osmUrl = osmUrl;
  const pointCloudUrl = optionalAssetUrl(
    raw.pointCloudUrl,
    `${label}.pointCloudUrl`,
  );
  if (pointCloudUrl) scene.pointCloudUrl = pointCloudUrl;
  const pointCloudMetaUrl = optionalAssetUrl(
    raw.pointCloudMetaUrl,
    `${label}.pointCloudMetaUrl`,
  );
  if (pointCloudMetaUrl) scene.pointCloudMetaUrl = pointCloudMetaUrl;
  const metadataUrl = optionalAssetUrl(raw.metadataUrl, `${label}.metadataUrl`);
  if (metadataUrl) scene.metadataUrl = metadataUrl;

  const projectionOrigin = parseProjectionOrigin(
    raw.osmProjectionOrigin,
    `${label}.osmProjectionOrigin`,
  );
  if (projectionOrigin) scene.osmProjectionOrigin = projectionOrigin;
  const bounds = parseBounds(raw.bounds, `${label}.bounds`);
  if (bounds) scene.bounds = bounds;
  const defaultView = parseDefaultView(raw.defaultView, `${label}.defaultView`);
  if (defaultView) scene.defaultView = defaultView;
  const minZoom = optionalFinite(raw.minZoom, `${label}.minZoom`);
  if (minZoom !== undefined) scene.minZoom = minZoom;
  const maxZoom = optionalFinite(raw.maxZoom, `${label}.maxZoom`);
  if (maxZoom !== undefined) scene.maxZoom = maxZoom;

  const description = optionalString(raw.description, `${label}.description`);
  if (description) scene.description = description;

  return scene;
};

/** Validate `scenes.json` content into `SceneMapDefinition[]`: an array of scenes with unique,
 *  path-safe ids and finite geometry. Throws a labelled message on the first problem. */
export const parseScenes = (raw: unknown): SceneMapDefinition[] => {
  if (!Array.isArray(raw)) {
    throw new Error("scenes must be a JSON array of entries");
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const scene = parseScene(value, `scenes[${index}]`);
    if (seen.has(scene.sceneId)) {
      throw new Error(`scenes has a duplicate sceneId: ${scene.sceneId}`);
    }
    seen.add(scene.sceneId);
    return scene;
  });
};
