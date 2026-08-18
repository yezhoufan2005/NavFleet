/**
 * Shared domain types for the NavFleet frontend.
 *
 * These mirror the canonical backend contracts in `backend/src/types.ts`
 * (the backend is the single source of truth for the data model). Kept as a
 * hand-maintained subset covering what the UI consumes; extend as the frontend
 * TypeScript migration progresses.
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
  active: boolean;
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
  mapProfile: string;
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

/** `[lng, lat]` coordinate pair, as consumed by the AMap SDK. */
export type LngLat = [number, number];
