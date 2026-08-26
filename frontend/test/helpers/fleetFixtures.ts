/**
 * Shared test doubles + payload fixtures for the fleet store.
 *
 * The store owns a WebSocket link and REST bootstrap, so both store test files
 * need a deterministic socket/fetch stand-in. Payload builders mirror the shapes
 * the backend actually sends (`/api/fleet/snapshot`, `fleet.delta`, …).
 */

import { vi } from "vitest";

/** Minimal event shape the store's listeners read (`event.data` only). */
type FakeSocketEvent = { data?: string };
type FakeSocketListener = (event: FakeSocketEvent) => void;

/**
 * Hand-driven WebSocket: records outbound frames and only fires lifecycle
 * events when a test asks it to, so no real connection is ever opened.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCount = 0;

  private readonly listeners = new Map<string, FakeSocketListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: FakeSocketListener): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Real `close()` is async: it records intent, the "close" event comes later. */
  close(): void {
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSING;
  }

  private dispatch(type: string, event: FakeSocketEvent = {}): void {
    [...(this.listeners.get(type) ?? [])].forEach((handler) => handler(event));
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  emitRaw(data: string): void {
    this.dispatch("message", { data });
  }

  emitMessage(message: unknown): void {
    this.emitRaw(JSON.stringify(message));
  }

  emitError(): void {
    this.dispatch("error");
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close");
  }
}

/** Swap the global WebSocket for the fake; undone by `vi.unstubAllGlobals()`. */
export const installFakeWebSocket = (): void => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
};

export const lastSocket = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) {
    throw new Error("no WebSocket was created");
  }
  return socket;
};

export interface StubbedRoute {
  status?: number;
  body?: unknown;
}

export interface StubbedFetch {
  paths: string[];
  inits: Array<RequestInit | undefined>;
}

/**
 * Route-table `fetch` stub. Unlisted paths answer 404 so the store's
 * "keep the local fallback" branches are exercised instead of hitting network.
 */
export const stubFetchRoutes = (routes: Record<string, StubbedRoute>): StubbedFetch => {
  const calls: StubbedFetch = { paths: [], inits: [] };
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.paths.push(url);
    calls.inits.push(init);
    const route = routes[url.split("?")[0]] ?? { status: 404 };
    const status = route.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body),
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
};

/** The `window.vehicleDashboard` bridge installed by `registerWindowApi()`. */
export interface WindowFleetApi {
  updateFromPayload(payload: unknown): void;
  selectDevice(deviceId: string, options?: { preserveFormation?: boolean }): void;
  selectFormation(formationId: string): void;
  clearFormationSelection(): void;
  getSnapshot(): unknown;
  getBackendStatus(): { apiReady: boolean; wsReady: boolean; source: string };
}

export const windowFleetApi = (): WindowFleetApi =>
  (globalThis as unknown as { vehicleDashboard: WindowFleetApi }).vehicleDashboard;

export const FIXTURE_STAMP = "2026-08-26T10:00:00.000Z";

/**
 * A device as the backend snapshot serializes it. Carrying `fusionLoc`/`infoCode`
 * makes the normalizer treat it as an already-normalized snapshot, so the
 * fixture's `alerts` array is used verbatim instead of being re-derived.
 */
export const rawDevice = (
  deviceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  deviceId,
  deviceName: `车 ${deviceId}`,
  topic: `/fleet/${deviceId}/vehicle_info`,
  online: true,
  stamp: FIXTURE_STAMP,
  sceneId: "yard",
  runtimeSceneId: "yard",
  defaultSceneId: "yard",
  mapProfile: "lanelet",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: [],
  formationIds: [],
  gps: { lat: 31.2, lng: 121.4, heading: 0 },
  fusionLoc: { x: 0, y: 0, yaw: 0 },
  lidarLoc: { x: null, y: null, yaw: null },
  vehicleInfo: { controlMode: 1, gear: 1, speed: 1, omega: 0, soc: 80 },
  infoCode: { code: 0, info: "", stamp: null },
  warningCode: { code: 0, info: "", stamp: null },
  errorCode: { code: 0, info: "", stamp: null },
  alerts: [],
  ...overrides,
});

export const rawAlert = (
  id: string,
  severity: "critical" | "warning" | "notice",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  severity,
  source: "snapshot",
  title: `告警 ${id}`,
  detail: "",
  code: 0,
  info: "",
  ts: FIXTURE_STAMP,
  ...overrides,
});

export const rawFormation = (
  formationId: string,
  deviceIds: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  formationId,
  formationName: `编队 ${formationId}`,
  deviceIds,
  ...overrides,
});

export const snapshotPayload = (
  devices: unknown[],
  formations?: unknown[],
): Record<string, unknown> => ({
  fleetName: "测试车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  updatedAt: FIXTURE_STAMP,
  devices,
  ...(formations ? { formations } : {}),
});
