/**
 * Backend REST access for fleet data.
 *
 * Centralizes fetch calls that were previously scattered inside the dashboard
 * composable: consistent credentials, no-store caching, and a single place that
 * throws on non-2xx so callers can handle failure uniformly. Cookies (httpOnly
 * JWT) ride along automatically on same-origin requests; `credentials:"include"`
 * keeps that explicit and future-proofs a split-origin deployment.
 */

import type {
  AlertStatsReport,
  AvailabilityReport,
  DeviceSnapshot,
  NotifyChannelView,
  NotifySendRecord,
  ReportBucketUnit,
  ReportCodeEntry,
} from "@navfleet/shared";

export interface FleetSnapshotResponse {
  fleetName?: string;
  topicPattern?: string;
  updatedAt?: string;
  devices?: unknown[];
  formations?: unknown[];
  summary?: unknown;
  [key: string]: unknown;
}

/**
 * A scene as the **API returns it** — deliberately loose, and deliberately not
 * `SceneMapDefinition`.
 *
 * The two are easy to confuse (a store can hold both, and one used to import both in
 * the same file), so the distinction is worth stating: `SceneMapDefinition` in
 * `@navfleet/shared` is the *configured* shape, every field known and typed;
 * this is the *wire* shape, where the backend merges in dynamically-derived parts
 * (bounds from the OSM parse, an `overlayUrl` it mints itself) and a consumer has to
 * narrow before trusting anything beyond `sceneId`.
 *
 * There used to be a third name for this idea — `SceneConfig`, an empty
 * `extends SceneMapDefinition {}` in `@navfleet/shared` — which was a second name for
 * one type rather than a second type. It is gone; the backend uses
 * `SceneMapDefinition` directly.
 */
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
  eventKey?: string;
  alertId?: string;
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
  // Lifecycle timestamps carried on rows read back from the alerts collection (Phase 16A/16B).
  // Serialized as ISO strings over HTTP even though Mongo stores them as Date.
  firstSeenAt?: string;
  lastSeenAt?: string;
  // Acknowledgement (Phase 16A). Present on rows read back from the alerts collection.
  ackedBy?: string | null;
  ackedAt?: string | null;
  comment?: string | null;
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

/** Range for the server-side report aggregation (Phase 17A). Both optional; the aggregate spans
 * the whole retention window when neither is given. */
export interface ReportRangeParams {
  from?: string;
  to?: string;
}

/** Query for the availability/battery time-series (Phase 17A-2). `deviceId` narrows to one vehicle;
 * `bucket` defaults server-side to day when omitted. */
export interface AvailabilityQueryParams {
  from?: string;
  to?: string;
  deviceId?: string;
  bucket?: ReportBucketUnit;
}

export type UserRoleName = "admin" | "operator" | "viewer";

/** A user as the admin API returns it (management view, never carries `passwordHash`). */
export interface AdminUser {
  username: string;
  role: UserRoleName;
  enabled: boolean;
  tokenVersion: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  passwordUpdatedAt: string;
  failedAttempts: number;
  lockedUntil: string | null;
  [key: string]: unknown;
}

/** One audit-log row as `GET /api/v1/audit` returns it. */
export interface AuditRecord {
  ts: string;
  actor: string;
  action: string;
  target?: string;
  outcome: "success" | "failure";
  requestId?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A tracked login session (own or, for an admin, another user's). */
export interface SessionRecordView {
  sessionId: string;
  username: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  current?: boolean;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  role: UserRoleName;
  displayName?: string;
  email?: string | null;
  phone?: string | null;
}

export interface UpdateUserPayload {
  role?: UserRoleName;
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  enabled?: boolean;
}

export interface AuditQueryParams {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
}

/** Query filters for the outbound-notification send log (`GET /api/v1/notify/log`, admin). */
export interface NotifyLogQueryParams {
  deviceId?: string;
  channelId?: string;
  status?: "sent" | "failed";
  from?: string;
  to?: string;
}

/**
 * Turn a failed response into an Error whose `message` is the backend's stable error *code*
 * (`conflict`, `last_admin`, `self_forbidden`, `not_found`, …) when the body carries one, so a
 * caller can map it to a message — several admin refusals share HTTP 409 and only the code
 * tells them apart. Falls back to `HTTP <status>` when there is no JSON `error` field.
 */
async function failureError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string } | null;
    if (body && typeof body.error === "string" && body.error) {
      return new Error(body.error);
    }
  } catch {
    // Non-JSON or empty body — fall through to the status.
  }
  return new Error(`HTTP ${response.status}`);
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    throw await failureError(response);
  }
  return (await response.json()) as T;
}

/** Like `requestJson`, for endpoints that answer 204 with no body (delete / reset / logout). */
async function requestVoid(
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    throw await failureError(response);
  }
}

/** JSON body + header for a write; spread into the `init` of a POST/PATCH. */
function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
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

  // ── Report-code dictionary (Phase 16C-2) ────────────────────────────────────
  // The table in effect (built-in ⊕ deployment codebook). Read-for-everyone (viewer+),
  // so the device-detail card can describe codes against the deployment's own meanings.
  getCodebook(): Promise<{ items: ReportCodeEntry[] }> {
    return requestJson<{ items: ReportCodeEntry[] }>("/api/v1/codebook");
  },

  // Replace the deployment codebook (admin). Returns the merged table the backend now serves.
  importCodebook(
    items: ReportCodeEntry[],
  ): Promise<{ items: ReportCodeEntry[] }> {
    return requestJson<{ items: ReportCodeEntry[] }>(
      "/api/v1/codebook",
      jsonBody("PUT", { items }),
    );
  },

  getScene(sceneId: string): Promise<SceneDefinition> {
    return requestJson<SceneDefinition>(
      `/api/v1/scenes/${encodeURIComponent(sceneId)}`,
    );
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
    return requestJson<{ items: AlertRecord[] }>(
      `/api/v1/alerts${buildQuery(params)}`,
    );
  },

  // ── Report aggregation (viewer+, Phase 17A) ─────────────────────────────────
  // Server-side alert statistics over the whole retention window — not bounded by the 500-row
  // cap on getAlerts. `available:false` means the deployment has no Mongo/history to aggregate.
  getAlertStatsReport(
    params: ReportRangeParams = {},
  ): Promise<AlertStatsReport> {
    return requestJson<AlertStatsReport>(
      `/api/v1/reports/alerts${buildQuery(params)}`,
    );
  },

  // Availability + battery time-series, downsampled server-side by hour/day (Phase 17A-2).
  getAvailabilityReport(
    params: AvailabilityQueryParams = {},
  ): Promise<AvailabilityReport> {
    return requestJson<AvailabilityReport>(
      `/api/v1/reports/availability${buildQuery(params)}`,
    );
  },

  // ── Alert acknowledgement (operator+, Phase 16A) ────────────────────────────
  // eventKey (deviceId:alertId) is assembled server-side from the body, so deviceId
  // — which can hold arbitrary vendor characters — never enters a path segment.
  ackAlert(deviceId: string, alertId: string, comment?: string): Promise<void> {
    return requestVoid(
      "/api/v1/alerts/ack",
      jsonBody(
        "POST",
        comment ? { deviceId, alertId, comment } : { deviceId, alertId },
      ),
    );
  },

  unackAlert(deviceId: string, alertId: string): Promise<void> {
    return requestVoid(
      "/api/v1/alerts/unack",
      jsonBody("POST", { deviceId, alertId }),
    );
  },

  // ── User management (admin, Phase 15E-2) ────────────────────────────────────
  getUsers(): Promise<{ users: AdminUser[] }> {
    return requestJson<{ users: AdminUser[] }>("/api/v1/users");
  },

  getUser(username: string): Promise<{ user: AdminUser }> {
    return requestJson<{ user: AdminUser }>(
      `/api/v1/users/${encodeURIComponent(username)}`,
    );
  },

  createUser(payload: CreateUserPayload): Promise<{ user: AdminUser }> {
    return requestJson<{ user: AdminUser }>(
      "/api/v1/users",
      jsonBody("POST", payload),
    );
  },

  updateUser(
    username: string,
    payload: UpdateUserPayload,
  ): Promise<{ user: AdminUser }> {
    return requestJson<{ user: AdminUser }>(
      `/api/v1/users/${encodeURIComponent(username)}`,
      jsonBody("PATCH", payload),
    );
  },

  resetPassword(username: string, newPassword: string): Promise<void> {
    return requestVoid(
      `/api/v1/users/${encodeURIComponent(username)}/reset-password`,
      jsonBody("POST", { newPassword }),
    );
  },

  deleteUser(username: string): Promise<void> {
    return requestVoid(`/api/v1/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
    });
  },

  forceLogout(username: string): Promise<void> {
    return requestVoid(`/api/v1/users/${encodeURIComponent(username)}/logout`, {
      method: "POST",
    });
  },

  getUserSessions(
    username: string,
  ): Promise<{ sessions: SessionRecordView[] }> {
    return requestJson<{ sessions: SessionRecordView[] }>(
      `/api/v1/users/${encodeURIComponent(username)}/sessions`,
    );
  },

  revokeUserSession(username: string, sessionId: string): Promise<void> {
    return requestVoid(
      `/api/v1/users/${encodeURIComponent(username)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  },

  // ── Audit log (admin, Phase 15E-2) ──────────────────────────────────────────
  getAuditLog(
    params: AuditQueryParams = {},
  ): Promise<{ entries: AuditRecord[] }> {
    return requestJson<{ entries: AuditRecord[] }>(
      `/api/v1/audit${buildQuery(params)}`,
    );
  },

  // ── Outbound notifications (admin, Phase 16D) ───────────────────────────────
  // Recent send records (newest first, server-capped), and the effective channels with
  // secrets redacted (`configured` says whether each channel's endpoint env is set; the URL
  // is never returned). Both are read-only — channels/routing are file-managed in notify.json.
  getNotifyLog(
    params: NotifyLogQueryParams = {},
  ): Promise<{ items: NotifySendRecord[] }> {
    return requestJson<{ items: NotifySendRecord[] }>(
      `/api/v1/notify/log${buildQuery(params)}`,
    );
  },

  getNotifyConfig(): Promise<{ channels: NotifyChannelView[] }> {
    return requestJson<{ channels: NotifyChannelView[] }>(
      "/api/v1/notify/config",
    );
  },
};
