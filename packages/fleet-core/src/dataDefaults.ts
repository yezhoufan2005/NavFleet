import type { DeviceSnapshot, SceneMapDefinition } from "@navfleet/shared";

/**
 * Offline demo defaults used when the backend is unreachable, so the shell has
 * something to render instead of an empty screen. Intentionally minimal.
 */
export const sceneCatalog: Record<string, SceneMapDefinition> = {};

export interface FallbackFleetPayload {
  fleetName: string;
  topicPattern: string;
  updatedAt: string;
  devices: DeviceSnapshot[];
}

export const fallbackFleetPayload: FallbackFleetPayload = {
  fleetName: "智能车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  updatedAt: "",
  devices: [],
};
