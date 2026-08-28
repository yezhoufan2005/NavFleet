import http from "node:http";
import type { Express } from "express";
import { afterAll, beforeEach, vi, type Mock } from "vitest";
import { createApp } from "../../src/app";
import { parseConfig, type AppConfig } from "../../src/config";
import { createRuntimeState, type RuntimeState } from "../../src/runtimeState";
import { ACCESS_COOKIE } from "../../src/auth/middleware";
import { signAccessToken } from "../../src/auth/tokens";
import type { AuthService } from "../../src/auth/service";
import type { Persistence } from "../../src/persistence";
import type { DashboardStore } from "../../src/store";
import type {
  FleetSnapshot,
  FormationSnapshot,
  LaneletOverlay,
  SceneMapDefinition,
  UserRecord,
  UserRole,
} from "../../src/types";
import {
  SCENE_ID,
  UPDATED_AT,
  sampleAlert,
  sampleFormation,
  sampleHistoryPoint,
  sampleOverlay,
  sampleScene,
  sampleSnapshot,
} from "./fixtures";

/**
 * Shared scaffolding for the HTTP integration tests: fake collaborators plus a
 * real Express app built through createApp(), so route order, the auth gate, the
 * JSON 404 and the error handler are all exercised end to end. Nothing here
 * touches MongoDB, MQTT or the filesystem.
 */

export * from "./fixtures";

export interface StoreStub {
  buildSummary: Mock<() => Record<string, unknown>>;
  snapshot: Mock<() => FleetSnapshot>;
  getFormations: Mock<() => FormationSnapshot[]>;
  getScenes: Mock<() => SceneMapDefinition[]>;
  getScene: Mock<(sceneId: string) => Promise<SceneMapDefinition | null>>;
  getSceneOverlay: Mock<(sceneId: string) => Promise<LaneletOverlay | null>>;
  getHistory: Mock<
    (deviceId: string, from?: string, to?: string, limit?: number) => Promise<unknown[]>
  >;
  getAlerts: Mock<(filters: Record<string, string | undefined>) => Promise<unknown[]>>;
  applyPayload: Mock<(payload: unknown, source?: string) => Promise<FleetSnapshot>>;
}

// getScene/getSceneOverlay are synchronous on DashboardStore but the routes
// await them, so the stubs are typed as promise-returning: that keeps
// mockRejectedValue available for the error-middleware tests.
export const createStoreStub = (): StoreStub => ({
  buildSummary: vi.fn(() => ({
    fleetName: "测试车队",
    deviceCount: 1,
    onlineCount: 1,
    alertCount: 0,
    gpsCount: 0,
    updatedAt: UPDATED_AT,
  })),
  snapshot: vi.fn(() => sampleSnapshot()),
  getFormations: vi.fn(() => [sampleFormation()]),
  getScenes: vi.fn(() => [sampleScene()]),
  getScene: vi.fn((sceneId: string) =>
    Promise.resolve(sceneId === SCENE_ID ? sampleScene() : null),
  ),
  getSceneOverlay: vi.fn((sceneId: string) =>
    Promise.resolve(sceneId === SCENE_ID ? sampleOverlay() : null),
  ),
  getHistory: vi.fn(() => Promise.resolve([sampleHistoryPoint()])),
  getAlerts: vi.fn(() => Promise.resolve([sampleAlert()])),
  applyPayload: vi.fn(() => Promise.resolve(sampleSnapshot())),
});

export interface PersistenceStub {
  isMongoConnected: Mock<() => boolean>;
  pendingTelemetryCount: Mock<() => number>;
}

export const createPersistenceStub = (): PersistenceStub => ({
  isMongoConnected: vi.fn(() => false),
  pendingTelemetryCount: vi.fn(() => 0),
});

export interface AuthServiceStub {
  authenticate: Mock<(username: string, password: string) => Promise<UserRecord | null>>;
  findByUsername: Mock<(username: string) => Promise<UserRecord | null>>;
}

export const createAuthServiceStub = (): AuthServiceStub => ({
  authenticate: vi.fn(() => Promise.resolve<UserRecord | null>(null)),
  findByUsername: vi.fn(() => Promise.resolve<UserRecord | null>(null)),
});

export interface TestAppOptions {
  configOverrides?: Partial<AppConfig>;
  store?: StoreStub;
  persistence?: PersistenceStub;
  authService?: AuthServiceStub;
  state?: RuntimeState;
  wsClientCount?: () => number;
  /** Off by default so test apps do not each install process-metric hooks. */
  collectDefaultMetrics?: boolean;
}

export interface TestAppContext {
  /**
   * A *listening* server, not the bare Express app.
   *
   * supertest starts its own server per request when handed an app, and closes
   * it as soon as the response arrives — hundreds of listen/close cycles per run
   * on recycled ephemeral ports. That produced a suite that failed about one run
   * in five, in a different test each time: a request could hang until the test
   * timed out, or be delivered to another test's server (a REST assertion once
   * got `426 Upgrade Required`, which only the WebSocket harness can produce).
   *
   * Because `server.address()` is already set here, supertest reuses this server
   * and never opens or closes one of its own. The server also outlives the test:
   * it comes from the per-file pool below, so a whole file binds one port once.
   * Named `app` so call sites read the same as before.
   */
  app: http.Server;
  store: StoreStub;
  persistence: PersistenceStub;
  authService: AuthServiceStub;
  state: RuntimeState;
  config: AppConfig;
}

/**
 * A port bound once per test file, pointed at whichever app is under test.
 *
 * `createTestApp()` runs per test, so binding there meant one listen/close cycle
 * per test — the churn behind the failures described above. A slot instead keeps
 * its port bound for the whole file and swaps the handler its server delegates
 * to, which keeps every test's app, stubs and config separate while the socket
 * layer stays completely still.
 */
interface ServerSlot {
  server: http.Server;
  /** Aim the slot at another app. The port stays bound. */
  use: (app: Express) => void;
}

const openSlot = (app: Express): ServerSlot => {
  let current = app;
  // Delegating through `current` is what makes the swap possible: passing the
  // app straight to createServer() would freeze this slot on the first test's
  // app. `listen()` binds before it returns, so `address()` is populated by the
  // time supertest reads it — that is what stops supertest opening its own.
  const server = http.createServer((req, res) => {
    current(req, res);
  });
  server.listen(0);
  return {
    server,
    use: (next: Express): void => {
      current = next;
    },
  };
};

/**
 * Vitest gives each test file its own module instance, so this pool is per-file
 * (and per worker process). Slots are handed out from the top on every test, so
 * one test holding two live apps gets two servers; the pool grows to the most
 * apps any single test needs, which is one for all but the metrics file.
 */
const slots: ServerSlot[] = [];
let nextSlot = 0;

beforeEach(() => {
  nextSlot = 0;
});

afterAll(async () => {
  await Promise.all(
    slots.splice(0).map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Build the real Express app on top of stubbed collaborators. */
export const createTestApp = (options: TestAppOptions = {}): TestAppContext => {
  const store = options.store ?? createStoreStub();
  const persistence = options.persistence ?? createPersistenceStub();
  const authService = options.authService ?? createAuthServiceStub();
  const state = options.state ?? createRuntimeState();
  // Documented defaults (metrics on, debug ingest off), then per-test overrides.
  // CORS is disabled so the app under test carries no origin allowlist.
  const config: AppConfig = {
    ...parseConfig({ CORS_ORIGINS: "" }),
    ...options.configOverrides,
  };

  const expressApp = createApp({
    store: store as unknown as DashboardStore,
    persistence: persistence as unknown as Persistence,
    authService: authService as unknown as AuthService,
    config,
    state,
    wsClientCount: options.wsClientCount ?? ((): number => 0),
    collectDefaultMetrics: options.collectDefaultMetrics ?? false,
  });

  // Take the next slot of the file's pool, opening it on first use, and point it
  // at this app. No listen()/close() happens per test.
  const slot = (slots[nextSlot] ??= openSlot(expressApp));
  slot.use(expressApp);
  nextSlot += 1;

  return { app: slot.server, store, persistence, authService, state, config };
};

/**
 * A `Cookie` header carrying a real access token, signed with the same helpers
 * and secret the production middleware verifies against.
 */
export const sessionCookie = (role: UserRole = "viewer", username = "tester"): string =>
  `${ACCESS_COOKIE}=${signAccessToken({ username, role })}`;

/** The uniform 400 body produced by respondValidationError(). */
export interface ValidationErrorBody {
  error: string;
  issues: Array<{ path: string; message: string }>;
}
