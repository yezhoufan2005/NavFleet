/**
 * Backend REST access for fleet data.
 *
 * Centralizes fetch calls that were previously scattered inside the dashboard
 * composable: consistent credentials, no-store caching, and a single place that
 * throws on non-2xx so callers can handle failure uniformly. Cookies (httpOnly
 * JWT) ride along automatically on same-origin requests; `credentials:"include"`
 * keeps that explicit and future-proofs a split-origin deployment.
 */

import type { DeviceSnapshot } from "../types";

export interface FleetSnapshotResponse {
  fleetName?: string;
  topicPattern?: string;
  updatedAt?: string;
  devices?: unknown[];
  formations?: unknown[];
  summary?: unknown;
  [key: string]: unknown;
}

export interface SceneDefinition {
  sceneId: string;
  [key: string]: unknown;
}

/** One persisted telemetry sample as returned by the history endpoint. */
export interface HistorySample {
  ts: string;
  meta?: { deviceId?: string; [key: string]: unknown };
  measurements?: Partial<DeviceSnapshot> & { [key: string]: unknown };
  [key: string]: unknown;
}

export interface AlertRecord {
  id?: string;
  deviceId?: string;
  deviceName?: string;
  severity: "critical" | "warning" | "notice";
  source?: string;
  title?: string;
  detail?: string;
  info?: string;
  code?: number;
  active?: boolean;
  ts?: string;
  clearedAt?: string | null;
  [key: string]: unknown;
}

export interface HistoryQueryParams {
  from?: string;
  to?: string;
  limit?: number;
}

export interface AlertsQueryParams {
  severity?: "critical" | "warning" | "notice";
  deviceId?: string;
  status?: "active" | "cleared";
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

// Generic over the param bag: interfaces have no implicit index signature, so a
// `Record<string, ...>` parameter would reject `HistoryQueryParams` et al.
function buildQuery<T extends object>(params: T): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const fleetApi = {
  getSnapshot(): Promise<FleetSnapshotResponse> {
    return requestJson<FleetSnapshotResponse>("/api/v1/fleet/snapshot");
  },

  getScenes(): Promise<{ items: SceneDefinition[] }> {
    return requestJson<{ items: SceneDefinition[] }>("/api/v1/scenes");
  },

  getScene(sceneId: string): Promise<SceneDefinition> {
    return requestJson<SceneDefinition>(`/api/v1/scenes/${encodeURIComponent(sceneId)}`);
  },

  getHistory(
    deviceId: string,
    params: HistoryQueryParams = {},
  ): Promise<{ deviceId: string; items: HistorySample[] }> {
    return requestJson<{ deviceId: string; items: HistorySample[] }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/history${buildQuery(params)}`,
    );
  },

  getAlerts(params: AlertsQueryParams = {}): Promise<{ items: AlertRecord[] }> {
    return requestJson<{ items: AlertRecord[] }>(`/api/v1/alerts${buildQuery(params)}`);
  },
};
