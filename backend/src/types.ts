export type Severity = "critical" | "warning" | "notice";
export type MapProfile = "lanelet" | "pointCloud" | "rosRaster+lanelet" | string;

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

export interface SceneConfig extends SceneMapDefinition {}

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
