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
   * finally removed. (Phase 17D kept this one field for that reason.)
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
// the two frontends share (Phase 16C-1). Kept in its own file because it carries runtime
// logic, and this barrel was otherwise types-only.
export * from "./alertRules";

// The report-code dictionary — built-in table, wire type, and the pure merge/lookup the
// backend layers a deployment's codebook over and 下发s (Phase 16C-2). Moved here from
// fleet-core so the backend, which does not depend on fleet-core, can reach it.
export * from "./reportCodes";

// 告警外发的共享契约（Phase 16D-1）——生效渠道视图与发送记录的形状（两个前端的只读「外发」页渲染
// 它们），以及「零配置不外发」的默认。路由/正文/发送等后端独有逻辑不在这里。
export * from "./notify";

// 报表聚合的共享契约（Phase 17A）——后端算、前端渲染的聚合结果形状（告警统计等）。
// 聚合管道的构造/执行等后端独有逻辑不在这里。
export * from "./reports";

// 车辆 / 编队配置文件的校验器（Phase 18 设备接入向导）——admin 经 API 写 vehicles.json /
// formations.json 时先校验；客户端先校验、后端为权威（同 parseCodebook）。
export * from "./fleetConfig";
// scenes.json 校验（Phase 18 场景地图上传与管理）：几何 + 路径安全的 sceneId + 资源 URL 限定在
// /scene-maps/ 下；overlayUrl/overlayType 由后端为 OSM 场景铸造，不从输入读取。
export * from "./sceneConfig";

// 细粒度能力项与内置角色预设（1.6.1 RBAC 基座）——后端门禁、前端 can() 的单一来源。运行时值，
// 故独立成文件（本 barrel 其余多为类型）。
export * from "./rbac";
