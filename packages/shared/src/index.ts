/**
 * NavFleet shared domain contracts.
 *
 * This is the SINGLE SOURCE OF TRUTH for the data model shared between the
 * backend (MQTT ingestion, REST, WebSocket) and the frontend (Vue store,
 * services, components). It is consumed as TypeScript source via type-only
 * imports (`import type { ... } from "@navfleet/shared"`), so nothing here is
 * emitted into either runtime bundle — the types are erased at compile time.
 *
 * When the data model changes, edit it here once; both apps pick it up.
 */

export type Severity = "critical" | "warning" | "notice";

/**
 * A device's declared map profile.
 *
 * The vocabulary is what `config-runtime/vehicles.json` actually carries. It used to
 * read `"lanelet" | "pointCloud" | "rosRaster+lanelet" | string`, which was wrong in
 * three ways at once: `"rosRaster+lanelet"` exists nowhere in the system, `"rosRaster"`
 * — which the shipped config does set, on two vehicles — was missing, and the trailing
 * `| string` collapses the whole union to `string`, so the compiler could never have
 * pointed either mistake out.
 *
 * Still open-ended, but via `(string & {})` rather than `| string`: a customer's fleet
 * config may name a vendor profile we have never seen, and the registry passes any
 * string through. The difference is that the known values stay visible to a reader and
 * to autocomplete instead of being erased.
 *
 * **Nothing branches on this today** — what a scene renders as is decided by which of
 * `imageUrl` / `osmUrl` / `pointCloudUrl` it carries. Whether to consume this field or
 * drop it is a Phase 17 decision (see ROADMAP); making the type honest in the meantime
 * is not that decision, it just stops it misdescribing the data in transit.
 */
export type MapProfile =
  | "lanelet"
  | "rosRaster"
  | "pointCloud"
  // `(string & {})` 而不是 `| string`：后者会把上面三个字面量吸收掉，于是编译器什么都不再检查，
  // 而读者与自动补全也看不到已知取值。这里曾有一条 `eslint-disable-next-line
  // @typescript-eslint/ban-types` —— 那个规则在 typescript-eslint v8 里**已经不存在**（被拆成
  // no-empty-object-type 等三条），而这个写法在 v8 下本来也不触发任何规则。它是把 shared 纳入
  // lint 之后报出来的第一件事：一条抑制着不存在规则的注释，因为这个包此前没有门禁而没人发现。
  | (string & {});

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
  ts: string;
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
  mapProfile: MapProfile;
  gpsEnabled: boolean;
  rosMapEnabled: boolean;
  tags: string[];
  formationIds: string[];
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
  imageUrl?: string;
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
  pointCloudMode?: "topdown";
  mapFrame: string;
  resolution: number;
  origin: {
    x: number;
    y: number;
    yaw: number;
  };
  occupiedThresh: number;
  freeThresh: number;
  negate: 0 | 1;
  width: number;
  height: number;
  bounds?: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
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
  defaultMapProfile: MapProfile;
  defaultGpsEnabled: boolean;
  defaultRosMapEnabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  deviceName: string;
  defaultSceneId?: string;
  mapProfile?: MapProfile;
  gpsEnabled?: boolean;
  rosMapEnabled?: boolean;
  tags?: string[];
}

export interface SocketEvent<T = unknown> {
  type: string;
  payload: T;
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
