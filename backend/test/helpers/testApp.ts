import http from "node:http";
import type { Express } from "express";
import { afterAll, beforeEach, vi, type Mock } from "vitest";
import { createApp } from "../../src/app";
import { parseConfig, type AppConfig } from "../../src/config";
import { createRuntimeState, type RuntimeState } from "../../src/runtimeState";
import { ACCESS_COOKIE } from "../../src/auth/middleware";
import { signAccessToken } from "../../src/auth/tokens";
import type { AuthService, AdminActionResult, AuthResult } from "../../src/auth/service";
import type { AuditService } from "../../src/audit/service";
import type { NotifyService } from "../../src/notify/service";
import type { Persistence } from "../../src/persistence";
import type { DashboardStore } from "../../src/store";
import { DEFAULT_REPORT_CODES } from "@navfleet/shared";
import type {
  AdminUserView,
  AuditEntry,
  FleetSnapshot,
  FormationSnapshot,
  LaneletOverlay,
  NotifyChannelView,
  NotifySendRecord,
  SceneMapDefinition,
  SessionRecord,
  UserRecord,
  UserRole,
  ReportCodeEntry,
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
  getScene: Mock<(sceneId: string) => SceneMapDefinition | null>;
  getSceneOverlay: Mock<(sceneId: string) => LaneletOverlay | null>;
  getCodebook: Mock<() => ReportCodeEntry[]>;
  importCodebook: Mock<(rawEntries: unknown) => Promise<ReportCodeEntry[]>>;
  getHistory: Mock<
    (deviceId: string, from?: string, to?: string, limit?: number) => Promise<unknown[]>
  >;
  getAlerts: Mock<(filters: Record<string, string | undefined>) => Promise<unknown[]>>;
  applyPayload: Mock<(payload: unknown, source?: string) => Promise<FleetSnapshot>>;
  broadcastAlertAck: Mock<
    (payload: { deviceId: string; alertId: string; ackedBy: string; ackedAt: string }) => void
  >;
  broadcastAlertUnack: Mock<(payload: { deviceId: string; alertId: string }) => void>;
  ingestQueueStats: Mock<() => { depth: number; dropped: number; limit: number }>;
  deviceAdmissionStats: Mock<
    () => { rejected: number; capped: number; evicted: number; limit: number }
  >;
}

/**
 * `getScene` / `getSceneOverlay` are **synchronous** on `DashboardStore`, and these stubs
 * now say so.
 *
 * They used to be typed promise-returning, with a comment admitting the mismatch: the
 * routes awaited them, and `mockRejectedValue` was convenient for the error-middleware
 * tests. So the double modelled a contract the doubled thing does not have, and the
 * route's pointless `await` is what made the two look compatible — `await-thenable`
 * (P0-f 第 3 批) is what named it.
 *
 * The error-middleware test now provokes a **synchronous throw**, which is the only way a
 * synchronous method can fail — i.e. it now exercises the path that actually exists.
 */
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
  getScene: vi.fn((sceneId: string) => (sceneId === SCENE_ID ? sampleScene() : null)),
  getSceneOverlay: vi.fn((sceneId: string) => (sceneId === SCENE_ID ? sampleOverlay() : null)),
  getCodebook: vi.fn(() => [...DEFAULT_REPORT_CODES]),
  importCodebook: vi.fn(() => Promise.resolve([...DEFAULT_REPORT_CODES])),
  getHistory: vi.fn(() => Promise.resolve([sampleHistoryPoint()])),
  getAlerts: vi.fn(() => Promise.resolve([sampleAlert()])),
  applyPayload: vi.fn(() => Promise.resolve(sampleSnapshot())),
  broadcastAlertAck: vi.fn(() => undefined),
  broadcastAlertUnack: vi.fn(() => undefined),
  ingestQueueStats: vi.fn(() => ({ depth: 0, dropped: 0, limit: 1000 })),
  deviceAdmissionStats: vi.fn(() => ({ rejected: 0, capped: 0, evicted: 0, limit: 1000 })),
});

export interface PersistenceStub {
  isMongoConnected: Mock<() => boolean>;
  telemetryBufferStats: Mock<() => { pending: number; dropped: number; limit: number }>;
  ackAlert: Mock<
    (eventKey: string, ackedBy: string, comment: string | null, at: Date) => Promise<boolean>
  >;
  unackAlert: Mock<(eventKey: string) => Promise<boolean>>;
}

export const createPersistenceStub = (): PersistenceStub => ({
  isMongoConnected: vi.fn(() => false),
  telemetryBufferStats: vi.fn(() => ({ pending: 0, dropped: 0, limit: 2000 })),
  // Default to "no such active alert" (→ 404); the ack behaviour tests override to true.
  ackAlert: vi.fn(() => Promise.resolve(false)),
  unackAlert: vi.fn(() => Promise.resolve(false)),
});

export interface AuthServiceStub {
  authenticate: Mock<(username: string, password: string) => Promise<AuthResult>>;
  findByUsername: Mock<(username: string) => Promise<UserRecord | null>>;
  recordLogin: Mock<(username: string) => Promise<void>>;
  changePassword: Mock<
    (username: string, oldPassword: string, newPassword: string) => Promise<UserRecord | null>
  >;
  listUsers: Mock<() => Promise<AdminUserView[]>>;
  getUser: Mock<(username: string) => Promise<AdminUserView | null>>;
  createUser: Mock<(input: unknown) => Promise<AdminActionResult<AdminUserView>>>;
  updateUser: Mock<
    (actor: string, username: string, fields: unknown) => Promise<AdminActionResult<AdminUserView>>
  >;
  resetPassword: Mock<
    (username: string, newPassword: string) => Promise<AdminActionResult<AdminUserView>>
  >;
  deleteUser: Mock<(actor: string, username: string) => Promise<AdminActionResult<void>>>;
  forceLogout: Mock<(username: string) => Promise<AdminActionResult<void>>>;
  // Sessions (Phase 15E).
  createSession: Mock<(input: unknown) => Promise<void>>;
  touchSession: Mock<(sessionId: string) => Promise<void>>;
  isSessionActive: Mock<(username: string, sessionId: string) => Promise<boolean>>;
  listSessions: Mock<(username: string) => Promise<SessionRecord[]>>;
  revokeSession: Mock<(username: string, sessionId: string) => Promise<boolean>>;
}

/** A full stored user with the Phase 15B/15E fields, for stubbing `findByUsername`. */
const stubUser = (username: string, role: UserRole = "viewer"): UserRecord => ({
  username,
  passwordHash: "stub",
  role,
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
  enabled: true,
  tokenVersion: 0,
  displayName: username,
  email: null,
  phone: null,
  lastLoginAt: null,
  passwordUpdatedAt: UPDATED_AT,
  failedAttempts: 0,
  lockedUntil: null,
});

/** Strip `passwordHash`, mirroring the service's `toAdminUserView`. */
const adminView = ({ passwordHash: _passwordHash, ...view }: UserRecord): AdminUserView => view;

export const createAuthServiceStub = (): AuthServiceStub => ({
  authenticate: vi.fn(() => Promise.resolve<AuthResult>({ ok: false, lockedJustNow: false })),
  // Returns an enabled, version-0 user by default so a request bearing a `sessionCookie`
  // (signed at version 0) passes the per-request revocation check. Cases that test
  // unauthorized/disabled/stale override this.
  findByUsername: vi.fn((username: string) =>
    Promise.resolve<UserRecord | null>(stubUser(username)),
  ),
  recordLogin: vi.fn(() => Promise.resolve()),
  changePassword: vi.fn(() => Promise.resolve<UserRecord | null>(null)),
  // Admin API (15B-2). Defaults let the happy path through; guard/error cases override.
  listUsers: vi.fn(() => Promise.resolve<AdminUserView[]>([])),
  getUser: vi.fn((username: string) =>
    Promise.resolve<AdminUserView | null>(adminView(stubUser(username))),
  ),
  createUser: vi.fn((input) =>
    Promise.resolve<AdminActionResult<AdminUserView>>({
      ok: true,
      value: adminView(stubUser((input as { username: string }).username)),
    }),
  ),
  updateUser: vi.fn((_actor, username) =>
    Promise.resolve<AdminActionResult<AdminUserView>>({
      ok: true,
      value: adminView(stubUser(username)),
    }),
  ),
  resetPassword: vi.fn((username) =>
    Promise.resolve<AdminActionResult<AdminUserView>>({
      ok: true,
      value: adminView(stubUser(username)),
    }),
  ),
  deleteUser: vi.fn(() => Promise.resolve<AdminActionResult<void>>({ ok: true, value: undefined })),
  forceLogout: vi.fn(() =>
    Promise.resolve<AdminActionResult<void>>({ ok: true, value: undefined }),
  ),
  // Sessions: default to "active" so a sid-bearing cookie passes the gate; revocation cases override.
  createSession: vi.fn(() => Promise.resolve()),
  touchSession: vi.fn(() => Promise.resolve()),
  isSessionActive: vi.fn(() => Promise.resolve(true)),
  listSessions: vi.fn(() => Promise.resolve<SessionRecord[]>([])),
  revokeSession: vi.fn(() => Promise.resolve(true)),
});

export interface AuditServiceStub {
  record: Mock<(input: unknown) => Promise<void>>;
  query: Mock<(filters: unknown) => Promise<AuditEntry[]>>;
}

export const createAuditServiceStub = (): AuditServiceStub => ({
  record: vi.fn(() => Promise.resolve()),
  query: vi.fn(() => Promise.resolve<AuditEntry[]>([])),
});

export interface NotifyServiceStub {
  dispatch: Mock<(event: unknown) => Promise<void>>;
  queryLog: Mock<(filters: unknown) => Promise<NotifySendRecord[]>>;
  effectiveConfig: Mock<() => NotifyChannelView[]>;
  setSendObserver: Mock<(observer: unknown) => void>;
}

export const createNotifyServiceStub = (): NotifyServiceStub => ({
  dispatch: vi.fn(() => Promise.resolve()),
  queryLog: vi.fn(() => Promise.resolve<NotifySendRecord[]>([])),
  effectiveConfig: vi.fn(() => []),
  setSendObserver: vi.fn(() => undefined),
});

export interface TestAppOptions {
  configOverrides?: Partial<AppConfig>;
  store?: StoreStub;
  persistence?: PersistenceStub;
  authService?: AuthServiceStub;
  auditService?: AuditServiceStub;
  notifyService?: NotifyServiceStub;
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
  auditService: AuditServiceStub;
  notifyService: NotifyServiceStub;
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
  const auditService = options.auditService ?? createAuditServiceStub();
  const notifyService = options.notifyService ?? createNotifyServiceStub();
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
    auditService: auditService as unknown as AuditService,
    notifyService: notifyService as unknown as NotifyService,
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

  return {
    app: slot.server,
    store,
    persistence,
    authService,
    auditService,
    notifyService,
    state,
    config,
  };
};

/**
 * A `Cookie` header carrying a real access token, signed with the same helpers
 * and secret the production middleware verifies against.
 *
 * No `sid` by default: most tests only need to pass the auth gate, and a sid-less token is
 * governed by tokenVersion alone (the pre-15E contract the middleware still honours), so the
 * session check is skipped and the default stubs suffice. Use `sessionCookieWithSid` to exercise
 * the per-session path.
 */
export const sessionCookie = (role: UserRole = "viewer", username = "tester"): string =>
  `${ACCESS_COOKIE}=${signAccessToken({ username, role }, 0)}`;

/** A `Cookie` header whose access token names a session (`sid`), for the Phase 15E session paths. */
export const sessionCookieWithSid = (
  role: UserRole = "viewer",
  username = "tester",
  sid = "sid-1",
): string => `${ACCESS_COOKIE}=${signAccessToken({ username, role }, 0, sid)}`;

/** The uniform 400 body produced by respondValidationError(). */
export interface ValidationErrorBody {
  error: string;
  issues: Array<{ path: string; message: string }>;
}
