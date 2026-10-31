/**
 * NavFleet shared domain contracts.
 *
 * This is the SINGLE SOURCE OF TRUTH for the data model shared between the
 * backend (MQTT ingestion, REST, WebSocket) and the frontends (Vue store,
 * services, components). It is consumed as TypeScript source, not a built package.
 *
 * The types in this file are erased at compile time. The modules re-exported below also
 * carry runtime code both sides run — the rule evaluator, the code table and its lookup,
 * the config parsers, scene geometry, the capability presets, CSV cells, the report CSV —
 * so a value imported from here is bundled into whichever app imports it. Keep it pure:
 * no I/O, no environment globals.
 *
 * When the data model changes, edit it here once; both apps pick it up.
 */

export type Severity = "critical" | "warning" | "notice";

export interface GpsPoint {
  lat: number | null;
  lng: number | null;
  heading: number | null;
}

export interface PosePoint {
  x: number | null;
  y: number | null;
  yaw: number | null;
}

export interface VehicleInfoState {
  controlMode: number | null;
  gear: number | null;
  speed: number | null;
  omega: number | null;
  soc: number | null;
}

export interface CodeState {
  code: number;
  info: string;
  stamp: string | null;
}

export interface SpeedLimitState {
  limit: number | null;
  slowdownTime: number | null;
  stamp: string | null;
  moduleName: string;
}

export interface DeviceAlert {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  source: string;
  /** The latest report that carried it; for a rule alert that is every frame. */
  ts: string;
  /**
   * When this occurrence began: the first frame that carried it, kept while it stays active. A
   * page opened mid-incident would otherwise date it to its own first sight, or to the latest
   * frame.
   */
  firstSeenAt?: string;
  active?: boolean;
  code?: number;
  info?: string;
}

export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  topic: string;
  online: boolean;
  stamp: string;
  sceneId: string;
  runtimeSceneId: string;
  defaultSceneId: string;
  gpsEnabled: boolean;
  rosMapEnabled: boolean;
  tags: string[];
  formationIds: string[];
  /** Identity / spec metadata merged from `DeviceConfig` (optional, display-only — see there). */
  vendor?: string;
  model?: string;
  serialNumber?: string;
  category?: string;
  maxLoadKg?: number;
  commissionedAt?: string;
  notes?: string;
  gps: GpsPoint;
  fusionLoc: PosePoint;
  lidarLoc: PosePoint;
  vehicleInfo: VehicleInfoState;
  taskStatus: number | null;
  platformTaskStatus: number | null;
  infoCode: CodeState;
  warningCode: CodeState;
  errorCode: CodeState;
  speedLimit: SpeedLimitState;
  alerts: DeviceAlert[];
  extra: Record<string, unknown>;
}

export interface FormationConfig {
  formationId: string;
  formationName: string;
  deviceIds: string[];
  sceneId?: string;
  description?: string;
  color?: string;
}

export interface FormationSnapshot {
  formationId: string;
  formationName: string;
  deviceIds: string[];
  deviceCount: number;
  onlineCount: number;
  sceneId: string;
  description: string;
  color: string;
}

export interface FleetSnapshot {
  fleetName: string;
  topicPattern: string;
  updatedAt: string;
  devices: DeviceSnapshot[];
  formations: FormationSnapshot[];
}

export interface SceneMapDefinition {
  sceneId: string;
  sceneName: string;
  /** Optional human description of the scene, mirrored on 编队 — display-only. */
  description?: string;
  imageUrl?: string;
  /**
   * External scene-metadata document to merge over the inline definition. No shipped
   * scene sets it, and the deployed v3 console does not read it — it is retained only
   * because the frozen v1.0.0 frontend still consumes it (`frontend/`'s scene overlay),
   * and the freeze forbids editing that code. Clear it when the frozen frontend is
   * finally removed. (This one field was kept for that reason.)
   */
  metadataUrl?: string;
  osmUrl?: string;
  osmProjectionOrigin?: {
    lat: number;
    lng: number;
  };
  overlayUrl?: string;
  overlayType?: "lanelet2";
  pointCloudUrl?: string;
  pointCloudMetaUrl?: string;
  mapFrame: string;
  resolution: number;
  origin: {
    x: number;
    y: number;
    yaw: number;
  };
  width: number;
  height: number;
  bounds?: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  /**
   * Set by the backend when `bounds` was not configured but computed (from the geometry, or from
   * the OSM overlay). Never part of `scenes.json`: the write parser drops a derived `bounds`, so an
   * editor that sends back what it read does not freeze the computed box into the file.
   */
  boundsDerived?: boolean;
  defaultView?: {
    zoom: number;
    centerX: number;
    centerY: number;
  };
  minZoom?: number;
  maxZoom?: number;
}

export interface LaneletOverlayProjection {
  type: "local-tangent-plane";
  originLat: number;
  originLng: number;
}

export interface LaneletOverlayBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LaneletOverlayLanelet {
  id: string;
  subtype: string;
  oneWay: string;
  left: Array<{ x: number; y: number }>;
  right: Array<{ x: number; y: number }>;
  centerline: Array<{ x: number; y: number }>;
}

export interface LaneletOverlay {
  sceneId: string;
  source: string;
  generator: "lanelet2";
  projection: LaneletOverlayProjection;
  bounds: LaneletOverlayBounds;
  stats: {
    nodeCount: number;
    wayCount: number;
    laneletCount: number;
  };
  lanelets: LaneletOverlayLanelet[];
}

export interface FleetConfig {
  fleetName: string;
  topicPattern: string;
  defaultSceneId?: string;
  defaultGpsEnabled: boolean;
  defaultRosMapEnabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  deviceName: string;
  defaultSceneId?: string;
  gpsEnabled?: boolean;
  rosMapEnabled?: boolean;
  tags?: string[];
  /**
   * Identity / spec metadata the deployment records about a vehicle, beyond what telemetry
   * reports — modelled on the per-vehicle static properties of VDA 5050's factsheet and the IDTA
   * "Technical Data for AGV" submodel (manufacturer / series / serial / class / load). All
   * optional and display-only: this is a read-only monitoring console, so none of it steers a
   * vehicle. `category` is free text (this fleet is patrol/inspection, not VDA's warehouse
   * forklift/tugger classes). `maxLoadKg` is the rated load in kilograms; `commissionedAt` an
   * ISO date (`YYYY-MM-DD`).
   */
  vendor?: string;
  model?: string;
  serialNumber?: string;
  category?: string;
  maxLoadKg?: number;
  commissionedAt?: string;
  notes?: string;
}

export interface SocketEvent<T = unknown> {
  type: string;
  payload: T;
}

/**
 * Payloads of the per-alert transition events. `alert.created` carries the whole alert, because
 * a console seeing it for the first time needs its severity and title; `alert.cleared` carries
 * only the id, because the alert is already gone from the snapshot and a console that wants
 * to name it uses what it kept from the `alert.created` it saw.
 */
export interface AlertCreatedPayload {
  source: string;
  deviceId: string;
  alert: DeviceAlert;
}

export interface AlertClearedPayload {
  source: string;
  deviceId: string;
  alertId: string;
}

export interface HistoryQuery {
  deviceId: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type UserRole = "admin" | "operator" | "viewer";

/**
 * The user shape the API hands to a client: `/api/auth/login`, `/refresh` and `/me` all
 * answer with `{ user: PublicUser }`, and the console stores exactly this.
 *
 * Its **stored** counterpart is deliberately not here. `UserRecord` — the `users`
 * document, `passwordHash` and all — used to sit between these two declarations with no
 * reader outside the backend. A password hash's type has no business in the package both
 * frontends import from even when nothing is emitted, because being here is what invites a
 * frontend to reach for it; it now lives in `backend/src/types.ts`.
 */
export interface PublicUser {
  username: string;
  role: UserRole;
}

/** `[lng, lat]` coordinate pair, as consumed by the AMap SDK (frontend). */
export type LngLat = [number, number];

// The alert rule engine — types, defaults, and the pure evaluator both the backend and
// the two frontends share.
export * from "./alertRules";

// The report-code dictionary — built-in table, wire type, and the pure merge/lookup the
// backend layers a deployment's codebook over and 下发s. Moved here from
// fleet-core so the backend, which does not depend on fleet-core, can reach it.
export * from "./reportCodes";

// Outbound-notification contracts: the effective-channel view and send-record shapes the
// 外发 pages render, and the zero-config default of sending nothing. Routing, bodies and
// delivery are backend-only and stay out of here.
export * from "./notify";

// Report contracts: the aggregate shapes the backend computes and the console renders, the
// range labels, and the availability CSV both write. The pipelines stay in the backend.
export * from "./reports";

// vehicles.json / formations.json validators (device onboarding): the console checks first,
// the backend is authoritative (as with parseCodebook). Also the device-id rule ingest uses.
export * from "./fleetConfig";
// scenes.json validation: geometry, a path-safe sceneId, asset URLs confined to
// /scene-maps/. overlayUrl/overlayType are minted by the backend for OSM scenes, never read.
export * from "./sceneConfig";
// Scene geometry (ROS map_server convention: origin is the lower-left corner's world pose, yaw
// turns CCW about it), shared by bounds derivation, point-cloud rasterising and the console's
// backdrop placement, so a rotated map lands the same everywhere.
export * from "./sceneGeometry";

// Capabilities and the built-in role presets: the one source for the backend gate and the
// console's can().
export * from "./rbac";

// The three severity tiers and their labels (告警 / 预警 / 提示), for the console and the
// outbound messages alike.
export * from "./severity";

// The closed audit-action tuple: the backend's query validation and the console's 动作 labels
// are both typed against it, so a missing label fails the build.
export * from "./audit";

// One CSV cell (with formula-injection defusing), shared by the console export and the
// scheduled-report email so both write the same file.
export * from "./csv";

// The pure coercions both normalisers (backend ingest, fleet-core in the consoles) apply.
export * from "./normalizeHelpers";
