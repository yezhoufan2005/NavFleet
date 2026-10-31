/**
 * OpenAPI 3.1 description of the NavFleet backend API.
 *
 * Hand-maintained (no code generation) and served as JSON at GET /openapi.json.
 * View it with any OpenAPI tool — e.g. paste into https://editor.swagger.io or
 * point Redoc/Swagger UI at the served URL. Kept intentionally pragmatic: the
 * common request/response shapes are typed; free-form telemetry payloads are
 * described as generic objects (the normalizer accepts many shapes).
 *
 * Paths are documented under `/api/v1`, the surface new clients should use.
 * Every domain path is also served at bare `/api` for existing callers (see
 * API_PREFIXES in app.ts); the document describes one of the two rather than
 * listing every path twice. Authentication is deliberately unversioned.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  alertAckSchema,
  alertUnackSchema,
  alertsQuerySchema,
  auditQuerySchema,
  createUserSchema,
  deviceIdParamSchema,
  changePasswordSchema,
  historyQuerySchema,
  ingestBodySchema,
  loginSchema,
  notifyLogQuerySchema,
  rbacGroupSchema,
  rbacRoleSchema,
  reportAvailabilityQuerySchema,
  reportRangeSchema,
  resetPasswordSchema,
  sceneIdParamSchema,
  updateUserSchema,
} from "./validation";
import { SEVERITIES } from "@navfleet/shared";
import { AUDIT_ACTIONS } from "./types";

/**
 * A validator, rendered as the JSON Schema that describes it.
 *
 * This is the anti-drift mechanism: the constraints in the document are the ones
 * the server actually enforces, because they come from the same zod schema. The
 * hand-written `LoginRequest` this replaced had already drifted — it omitted the
 * `minLength: 1` both fields require, so the doc promised empty strings were
 * acceptable.
 *
 * `io: "input"` matters for anything with a transform (query `limit` is coerced
 * from a string): the request shape is what a caller sends, not what the handler
 * receives. The `$schema` key is dropped because OpenAPI 3.1 supplies its own
 * dialect and repeating it in every component is noise.
 */
const fromValidator = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
};

/** One query parameter per property of a validator object, descriptions merged in. */
const queryParameters = (
  schema: z.ZodType,
  descriptions: Record<string, string> = {},
): Array<Record<string, unknown>> => {
  const generated = fromValidator(schema);
  const properties = (generated.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((generated.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propertySchema,
    ...(descriptions[name] ? { description: descriptions[name] } : {}),
  }));
};

const errorSchema = {
  type: "object",
  properties: {
    /** The stable code a client branches on (`invalid_request`, `config_conflict`, …). */
    error: { type: "string" },
    /**
     * The human sentence for that code — which field, which reference, what to change. Every
     * refusal that has one names it `detail`; the body-parser path used to call it `message`,
     * the one exception, so a client had to look in two places.
     */
    detail: { type: "string" },
    /**
     * The three fields the server actually sends and this schema did not mention, so
     * a client generated from the spec could not read any of them:
     *
     * - `issues` — the zod issue list, on every 400 that goes through
     *   `respondValidationError` (routes/helpers.ts).
     * - `requiredCapability` — what the RBAC middleware answers a 403 with
     *   (auth/middleware.ts `requireCapability`), i.e. the only machine-readable hint about *why*.
     * - `requestId` — on every 500 (app.ts), and the whole point of it is that a
     *   caller can quote it when reporting the failure.
     */
    issues: { type: "array", items: { type: "object", additionalProperties: true } },
    requiredCapability: { type: "string" },
    requestId: { type: "string" },
  },
} as const;

/**
 * The API version reported by `/openapi.json`, read from the repository manifest
 * rather than written out here.
 *
 * It was hardcoded `0.1.0` and had been wrong since the first release — a third
 * version number nobody would think to update, in the one place a client actually
 * reads it from. The **root** manifest is the source of truth: that is the version
 * release-please tags and the GHCR image carries, whereas the workspace manifests
 * only follow a major by hand (see CONTRIBUTING). Reading the root one means the
 * API version cannot depend on someone remembering.
 *
 * Read with `fs` rather than `import`/`require`: a static import of a file above
 * `rootDir: "src"` breaks the build layout, and `require()` is banned by lint.
 * `src/openapi.ts` and `dist/openapi.js` sit at the same depth under `backend/`,
 * so `../../package.json` resolves to the repo root from both, and the runtime
 * image stage copies that file to `/app/package.json`. The fallback exists so a
 * missing manifest degrades to an obviously-unset value instead of throwing at
 * import time.
 */
const apiVersion = ((): string => {
  try {
    const manifestPath = path.join(__dirname, "..", "..", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "NavFleet API",
    version: apiVersion,
    description:
      "AGV/智能车队实时监控后端。只读监控范围：设备/编队快照、历史轨迹、告警、场景地图，" +
      "以及登录鉴权与可观测性探针。除公开探针外，接口需 httpOnly Cookie 会话。",
  },
  servers: [{ url: "/", description: "Same-origin (behind nginx)" }],
  tags: [
    { name: "auth", description: "登录 / 会话" },
    { name: "fleet", description: "车队快照与设备" },
    { name: "alerts", description: "消息（告警 / 预警 / 提示）" },
    { name: "reports", description: "报表聚合" },
    { name: "scenes", description: "场景地图" },
    { name: "codebook", description: "报码字典" },
    { name: "ops", description: "健康探针与指标" },
    { name: "debug", description: "调试注入（受限）" },
    { name: "users", description: "用户管理（需 admin）" },
    { name: "audit", description: "审计日志（需 admin）" },
    { name: "notify", description: "消息外发：发送记录与生效渠道（需 admin）" },
    {
      name: "config",
      description: "控制台可编辑的配置文件（读 + 校验后整份写入，带版本防并发覆盖）",
    },
    { name: "rbac", description: "自定义角色与用户组（需 users:manage）" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "access_token",
        description: "登录后由服务端下发的 httpOnly access token cookie。",
      },
    },
    schemas: {
      Error: errorSchema,
      // `CodeState` used to sit here and was referenced by nothing — no response
      // pointed at it, so a client could see the shape and not learn where it
      // applies. An unreferenced component in a published spec is a claim with no
      // subject; the report-code fields are described where they are returned.
      LoginRequest: fromValidator(loginSchema),
      PublicUser: {
        type: "object",
        properties: {
          username: { type: "string" },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
        },
      },
      AdminUserView: {
        type: "object",
        description: "用户记录（管理视图，不含 passwordHash）",
        properties: {
          username: { type: "string" },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
          enabled: { type: "boolean" },
          tokenVersion: { type: "number" },
          kiosk: {
            type: "boolean",
            description: "长期只读大屏账号；普通账号缺省不带此字段",
          },
          displayName: { type: "string" },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          lastLoginAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          passwordUpdatedAt: { type: "string", format: "date-time" },
          failedAttempts: { type: "integer", description: "连续登录失败次数，成功登录后清零" },
          lockedUntil: {
            type: ["string", "null"],
            format: "date-time",
            description: "账号锁定到何时；未锁定为 null",
          },
        },
      },
      AuditEntry: {
        type: "object",
        description: "审计日志条目（鉴权与用户管理事件）",
        properties: {
          ts: { type: "string", format: "date-time" },
          actor: { type: "string" },
          // Drawn straight from the server's `AUDIT_ACTIONS` tuple so the published enum can never
          // drift behind it again (it had fallen 13 behind — every config-write and RBAC action was
          // missing, so a client generated from this spec rejected those rows).
          action: {
            type: "string",
            enum: [...AUDIT_ACTIONS],
          },
          target: { type: "string" },
          outcome: { type: "string", enum: ["success", "failure"] },
          requestId: { type: "string" },
          detail: { type: "object", additionalProperties: true },
        },
      },
      Alert: {
        type: "object",
        properties: {
          eventKey: { type: "string" },
          deviceId: { type: "string" },
          alertId: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          source: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          info: { type: "string" },
          code: { type: ["number", "null"] },
          active: { type: "boolean" },
          ts: { type: "string" },
          firstSeenAt: { type: "string", format: "date-time" },
          lastSeenAt: { type: "string", format: "date-time" },
          clearedAt: { type: ["string", "null"], format: "date-time" },
          ackedBy: { type: ["string", "null"] },
          ackedAt: { type: ["string", "null"], format: "date-time" },
          comment: { type: ["string", "null"] },
        },
      },
      HistorySample: {
        type: "object",
        properties: {
          ts: { type: "string", format: "date-time" },
          meta: { type: "object", additionalProperties: true },
          measurements: { type: "object", additionalProperties: true },
        },
      },
      NotifySendRecord: {
        type: "object",
        description: "一条告警外发记录",
        properties: {
          ts: { type: "string", format: "date-time" },
          eventKey: { type: "string" },
          channelId: { type: "string" },
          channelType: { type: "string", enum: ["webhook", "wecom", "dingtalk", "email"] },
          deviceId: { type: "string" },
          alertId: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          title: { type: "string" },
          status: { type: "string", enum: ["sent", "failed"] },
          httpStatus: { type: ["number", "null"] },
          attempts: { type: "number" },
          latencyMs: { type: ["number", "null"] },
          error: { type: ["string", "null"] },
        },
      },
      NotifyChannelView: {
        type: "object",
        description: "生效渠道视图（不含端点 URL；configured 表示其端点环境变量是否已配）",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["webhook", "wecom", "dingtalk", "email"] },
          enabled: { type: "boolean" },
          severities: {
            type: "array",
            items: { type: "string", enum: [...SEVERITIES] },
          },
          scope: { type: "object", additionalProperties: true },
          configured: { type: "boolean" },
        },
      },
      SessionView: {
        type: "object",
        description: "调用者自己的一个活跃会话，current 标出当前请求所在会话",
        properties: {
          sessionId: { type: "string" },
          username: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          lastSeenAt: { type: "string", format: "date-time" },
          userAgent: { type: "string" },
          ip: { type: "string" },
          current: { type: "boolean" },
        },
      },
      AlertStatsReport: {
        type: "object",
        description:
          "告警统计（服务端聚合，不受 /alerts 的 500 条上限约束）。" +
          "available:false 表示该部署无 Mongo、无历史可聚合——其余字段是零值而非'确无告警'。",
        properties: {
          total: { type: "number" },
          bySeverity: {
            type: "object",
            properties: {
              critical: { type: "number" },
              warning: { type: "number" },
              notice: { type: "number" },
            },
          },
          topDevices: {
            type: "array",
            description:
              "按告警条数降序的设备 Top-N（只带 deviceId；名字由前端用在线设备列表映射）",
            items: {
              type: "object",
              properties: {
                deviceId: { type: "string" },
                count: { type: "number" },
              },
            },
          },
          daily: {
            type: "array",
            description: "按天频次（按部署时区切日界），升序",
            items: {
              type: "object",
              properties: {
                day: { type: "string" },
                count: { type: "number" },
              },
            },
          },
          ackRate: { type: ["number", "null"] },
          duration: {
            type: "object",
            description: "已清除告警的处理时长（毫秒）；count 为算得出时长的样本数",
            properties: {
              count: { type: "number" },
              meanMs: { type: ["number", "null"] },
              p50Ms: { type: ["number", "null"] },
            },
          },
          available: { type: "boolean" },
        },
      },
      AvailabilityReport: {
        type: "object",
        description:
          "可用率/电量时序（telemetry_ts 按时/日 $dateTrunc 降采样）。" +
          "available:false 表示无 Mongo、无历史可聚合。",
        properties: {
          bucket: { type: "string", enum: ["hour", "day", "month"] },
          devices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                deviceId: { type: "string" },
                buckets: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      bucketStart: { type: "string", format: "date-time" },
                      onlineSamples: { type: "number" },
                      totalSamples: { type: "number" },
                      onlineSeconds: { type: "number" },
                      spanSeconds: { type: "number" },
                      onlineRatio: { type: "number" },
                      socMean: { type: ["number", "null"] },
                      socMin: { type: ["number", "null"] },
                    },
                  },
                },
              },
            },
          },
          available: { type: "boolean" },
        },
      },
    },
  },
  security: [{ cookieAuth: [] }],
  // Assigned below, once the response helpers it needs are in scope. It used to be
  // `paths: {}` followed by a `// PLACEHOLDER_PATHS` marker that referred to no
  // mechanism — the empty object was unconditionally overwritten twenty lines later.
} as Record<string, unknown>;

/**
 * A 200/201 body. `wrap` names the key the server nests the object under (`{ user: … }`), and
 * `schema` is a component name: the `#/components/schemas/` prefix is added here, because three
 * operations passed the bare name and published a `$ref` that resolved to nothing.
 */
const ok = (description: string, schema?: string, wrap?: string) => {
  const ref = schema ? { $ref: `#/components/schemas/${schema}` } : undefined;
  return {
    description,
    content: {
      "application/json": {
        schema: !ref
          ? { type: "object", additionalProperties: true }
          : wrap
            ? { type: "object", properties: { [wrap]: ref } }
            : ref,
      },
    },
  };
};

/** `{username}` in a `/users/{username}…` path. */
const usernamePath = { name: "username", in: "path", required: true, schema: { type: "string" } };

/**
 * What `markTruncation` adds to a capped list: `truncated` when older matches exist beyond the
 * server's row cap, and that cap as `limit`. A client reading only the items took the first 500
 * for the whole set.
 */
const listCap = {
  truncated: {
    type: "boolean",
    description: "还有更早的匹配记录超出服务端单次上限（只返回了最近的 limit 条）",
  },
  limit: { type: "integer", description: "服务端单次查询上限（truncated 时给出）" },
};

const unauthorized = {
  description: "未认证",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const badRequest = {
  description: "参数校验失败",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const forbidden = {
  description: "权限不足（响应体带 requiredCapability）",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const notFound = {
  description: "未找到",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const conflict = {
  description: "冲突：用户名已存在，或该操作会锁死（最后一个 admin / 对自己禁用删除降级）",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

/**
 * Answers every route under `/api` can produce, and none of them were documented.
 *
 * `429` comes from the express-rate-limit middleware mounted on the whole `/api`
 * surface (app.ts), and `500` from the error handler at the end of it — which
 * includes `requestId`. A generated client that has never been told about either
 * treats both as an unexpected response shape, which is the one case where it is
 * most likely to be logging something useless.
 */
const tooManyRequests = {
  description: "触发限流",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const serverError = {
  description: "服务端错误（响应体带 requestId）",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
/** Spread into every `/api` operation's `responses`. */
const apiWideResponses = { "429": tooManyRequests, "500": serverError } as const;

/** The content hash of a config file, sent back as `If-Match` to guard a write. */
const etagHeader = {
  ETag: {
    description: "该配置文件的版本（内容哈希），写入时作为 If-Match 带回",
    schema: { type: "string" },
  },
};
const ifMatchParameter = {
  name: "If-Match",
  in: "header",
  required: false,
  description:
    "读到的 ETag。带上时，若他人已改过文件：两人改的是不同条目则自动合并，改了同一条目则 409 config_conflict、不写入。不带则直接整份覆盖。",
  schema: { type: "string" },
};
const configWriteConflict = {
  description:
    "未写入：config_conflict（他人在编辑期间改了同一条目，需刷新后重新编辑）、config_not_applied（校验通过但与其余配置一起生效失败，已回滚；detail 为原因），或 vehicle_in_use / formation_in_use / scene_in_use（要删除的车辆、编队、场景仍被编队、规则或外发范围、车辆引用；detail 列出引用方）",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const jsonObject = { type: "object", additionalProperties: true } as const;

/**
 * The read + validate-first whole-file write pair every console-editable config file exposes
 * (vehicles / formations / scenes / rules / notify / scheduled reports). They share their whole
 * protocol — the capability gate, ETag on both sides, If-Match on the write, 400 for a body
 * that fails the file's parser, 409 for a refused write — so it is stated once.
 */
const configFileOperations = (spec: {
  noun: string;
  capability: string;
  key: string;
  invalidError: string;
}): Record<string, unknown> => {
  const body = {
    type: "object",
    required: [spec.key],
    properties: { [spec.key]: jsonObject },
  };
  const okWithVersion = (description: string) => ({
    description,
    headers: etagHeader,
    content: { "application/json": { schema: body } },
  });
  return {
    get: {
      tags: ["config"],
      summary: `读取${spec.noun}（需 ${spec.capability}）`,
      responses: {
        "200": okWithVersion(`当前${spec.noun}`),
        "401": unauthorized,
        "403": forbidden,
        ...apiWideResponses,
      },
    },
    put: {
      tags: ["config"],
      summary: `整份写入${spec.noun}（需 ${spec.capability}；先校验，不合法不落盘）`,
      parameters: [ifMatchParameter],
      requestBody: { required: true, content: { "application/json": { schema: jsonObject } } },
      responses: {
        "200": okWithVersion(`写入并生效后的${spec.noun}`),
        "400": {
          description: `校验失败（error=${spec.invalidError}，detail 指明字段或引用）`,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        "401": unauthorized,
        "403": forbidden,
        "409": configWriteConflict,
        ...apiWideResponses,
      },
    },
  };
};

/** List + create, and update + delete by id, for one RBAC entity (custom role / user group). */
const rbacOperations = (spec: {
  noun: string;
  listKey: string;
  itemKey: string;
  schema: z.ZodType;
  inUse?: string;
}): [Record<string, unknown>, Record<string, unknown>] => {
  const requestBody = {
    required: true,
    content: { "application/json": { schema: fromValidator(spec.schema) } },
  };
  const one = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { type: "object", properties: { [spec.itemKey]: jsonObject } },
      },
    },
  });
  const idParameter = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const conflictDescription = `名称重复${spec.inUse ? `，或${spec.inUse}（role_in_use）` : ""}`;
  return [
    {
      get: {
        tags: ["rbac"],
        summary: `${spec.noun}列表（需 users:manage）`,
        responses: {
          "200": {
            description: `全部${spec.noun}`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { [spec.listKey]: { type: "array", items: jsonObject } },
                },
              },
            },
          },
          "401": unauthorized,
          "403": forbidden,
          ...apiWideResponses,
        },
      },
      post: {
        tags: ["rbac"],
        summary: `新建${spec.noun}（需 users:manage）`,
        requestBody,
        responses: {
          "201": one(`已创建的${spec.noun}`),
          "400": badRequest,
          "401": unauthorized,
          "403": forbidden,
          "409": { ...conflict, description: conflictDescription },
          ...apiWideResponses,
        },
      },
    },
    {
      patch: {
        tags: ["rbac"],
        summary: `修改${spec.noun}（需 users:manage）`,
        parameters: [idParameter],
        requestBody,
        responses: {
          "200": one(`修改后的${spec.noun}`),
          "400": badRequest,
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          "409": { ...conflict, description: "名称重复" },
          ...apiWideResponses,
        },
      },
      delete: {
        tags: ["rbac"],
        summary: `删除${spec.noun}（需 users:manage）`,
        parameters: [idParameter],
        responses: {
          "204": { description: "已删除" },
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          ...(spec.inUse
            ? { "409": { ...conflict, description: `${spec.inUse}（role_in_use）` } }
            : {}),
          ...apiWideResponses,
        },
      },
    },
  ];
};

const [rbacRoles, rbacRole] = rbacOperations({
  noun: "自定义角色",
  listKey: "roles",
  itemKey: "role",
  schema: rbacRoleSchema,
  inUse: "仍有用户组引用该角色",
});
const [rbacGroups, rbacGroup] = rbacOperations({
  noun: "用户组",
  listKey: "groups",
  itemKey: "group",
  schema: rbacGroupSchema,
});

(openApiDocument as { paths: Record<string, unknown> }).paths = {
  "/health": {
    get: {
      tags: ["ops"],
      summary: "存活探针（公开）",
      security: [],
      responses: { "200": ok("存活") },
    },
  },
  "/health/ready": {
    get: {
      tags: ["ops"],
      summary: "就绪探针（公开）",
      description: "store 就绪返回 200；Mongo/MQTT 断开时仍 200 并置 degraded=true。",
      security: [],
      responses: { "200": ok("就绪"), "503": ok("未就绪") },
    },
  },
  "/metrics": {
    get: {
      tags: ["ops"],
      summary: "Prometheus 指标（公开，可由 METRICS_ENABLED 关闭）",
      security: [],
      responses: {
        "200": {
          description: "指标文本",
          content: { "text/plain": { schema: { type: "string" } } },
        },
        "404": ok("已禁用"),
      },
    },
  },
  "/api/auth/login": {
    post: {
      tags: ["auth"],
      summary: "登录，下发 httpOnly 会话 cookie",
      security: [],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
      },
      responses: {
        "200": {
          description: "登录成功",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { user: { $ref: "#/components/schemas/PublicUser" } },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["auth"],
      summary: "用 refresh cookie 续签 access token",
      security: [],
      responses: {
        "200": {
          description: "已续签，返回当前用户",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { user: { $ref: "#/components/schemas/PublicUser" } },
              },
            },
          },
        },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/auth/logout": {
    post: {
      tags: ["auth"],
      summary: "登出，清除会话 cookie",
      security: [],
      responses: { "204": { description: "已登出" }, ...apiWideResponses },
    },
  },
  "/api/auth/change-password": {
    post: {
      tags: ["auth"],
      summary: "修改自己的密码",
      description: "成功后所有设备的会话失效，当前设备换发新的会话 Cookie 继续保持登录。",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(changePasswordSchema) } },
      },
      responses: {
        "204": { description: "已修改" },
        "400": {
          description: "参数校验失败，或旧密码不对（invalid_credentials）",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/auth/me": {
    get: {
      tags: ["auth"],
      summary: "当前会话用户",
      responses: {
        "200": {
          description: "当前用户",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { user: { $ref: "#/components/schemas/PublicUser" } },
              },
            },
          },
        },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/auth/sessions": {
    get: {
      tags: ["auth"],
      summary: "列出当前用户自己的活跃会话（current 标出本次会话）",
      responses: {
        "200": {
          description: "会话列表",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  sessions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SessionView" },
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/auth/sessions/{sessionId}": {
    delete: {
      tags: ["auth"],
      summary: "下线本人某个会话（仅能删自己的；删别人的当作未找到）",
      parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": { description: "已下线" },
        "401": unauthorized,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/fleet/snapshot": {
    get: {
      tags: ["fleet"],
      summary: "车队快照（设备/编队/汇总）",
      responses: { "200": ok("快照"), "401": unauthorized, ...apiWideResponses },
    },
  },
  "/api/v1/formations": {
    get: {
      tags: ["fleet"],
      summary: "编队列表",
      responses: { "200": ok("编队"), "401": unauthorized, ...apiWideResponses },
    },
  },
  "/api/v1/devices/{deviceId}/history": {
    get: {
      tags: ["fleet"],
      summary: "设备历史轨迹（时序采样，最新在前）",
      parameters: [
        {
          name: "deviceId",
          in: "path",
          required: true,
          schema: fromValidator(deviceIdParamSchema),
        },
        ...queryParameters(historyQuerySchema, {
          from: "ISO-8601 或整数 epoch（秒或毫秒）",
          to: "ISO-8601 或整数 epoch（秒或毫秒）",
          limit: "返回的最大采样数（latest 模式）",
          sampling:
            "latest（默认）= 最新的 limit 条；even = 整个 from–to 窗口按时间均匀抽取，至多 MAX_HISTORY_POINTS 条，需同时给 from 与 to",
        }),
      ],
      responses: {
        "200": {
          description: "历史采样",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deviceId: { type: "string" },
                  items: { type: "array", items: { $ref: "#/components/schemas/HistorySample" } },
                  sampled: {
                    type: "boolean",
                    description: "仅 even 模式：窗口内采样多于上限、已按时间抽取",
                  },
                  total: { type: "integer", description: "仅 even 模式：窗口内的采样总数" },
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/alerts": {
    get: {
      tags: ["alerts"],
      summary: "告警查询",
      parameters: queryParameters(alertsQuerySchema),
      responses: {
        "200": {
          description: "告警列表",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/Alert" } },
                  ...listCap,
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/reports/alerts": {
    get: {
      tags: ["reports"],
      summary: "告警统计（服务端聚合）",
      parameters: queryParameters(reportRangeSchema, {
        from: `ISO-8601 或整数 epoch（秒或毫秒），按 firstSeenAt 过滤下界；省略时取 to（或当前）往前 REPORT_MAX_RANGE_DAYS 天`,
        to: "ISO-8601 或整数 epoch（秒或毫秒），上界",
      }),
      responses: {
        "200": {
          description: "告警统计",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AlertStatsReport" },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/reports/availability": {
    get: {
      tags: ["reports"],
      summary: "可用率/电量时序（服务端聚合）",
      parameters: queryParameters(reportAvailabilityQuerySchema, {
        from: `ISO-8601 或整数 epoch（秒或毫秒），按 ts 过滤下界；省略时取 to（或当前）往前 REPORT_MAX_RANGE_DAYS 天`,
        to: "ISO-8601 或整数 epoch（秒或毫秒），上界",
        deviceId: "逗号拼接的设备列表（如 agv-1,agv-2）；缺省为全车队",
        bucket: "分桶粒度（hour/day/month），缺省 day",
      }),
      responses: {
        "200": {
          description: "可用率/电量时序",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AvailabilityReport" },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/alerts/ack": {
    post: {
      tags: ["alerts"],
      summary: "确认一条活跃告警（需 operator 或 admin）",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(alertAckSchema) } },
      },
      responses: {
        "204": { description: "已确认" },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        // 未知或已清除（非活跃）告警。
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/alerts/unack": {
    post: {
      tags: ["alerts"],
      summary: "取消确认一条活跃告警（需 operator 或 admin）",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(alertUnackSchema) } },
      },
      responses: {
        "204": { description: "已取消确认" },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/scenes": {
    get: {
      tags: ["scenes"],
      summary: "场景地图目录",
      responses: {
        "200": { ...ok("场景列表"), headers: etagHeader },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
    put: {
      ...(
        configFileOperations({
          noun: "场景配置 scenes.json",
          capability: "scenes:write",
          key: "items",
          invalidError: "invalid_scenes",
        }) as { put: Record<string, unknown> }
      ).put,
      tags: ["scenes"],
    },
  },
  "/api/v1/scenes/{sceneId}/asset/{kind}": {
    put: {
      tags: ["scenes"],
      summary: "上传场景底图文件（需 scenes:write；请求体为文件原始字节）",
      description:
        "文件名由服务端决定，客户端只给类型。单个文件上限：image 8MB、pointcloud 64MB、osm 16MB、pointcloudmeta 8MB。",
      parameters: [
        { name: "sceneId", in: "path", required: true, schema: fromValidator(sceneIdParamSchema) },
        {
          name: "kind",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["image", "pointcloud", "osm", "pointcloudmeta"] },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      responses: {
        "200": {
          description: "已保存，返回资源地址",
          content: {
            "application/json": {
              schema: { type: "object", properties: { url: { type: "string" } } },
            },
          },
        },
        "400": {
          description:
            "invalid_asset_kind / empty_upload / invalid_asset（内容与类型不符，detail 为原因）",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        "401": unauthorized,
        "403": forbidden,
        "413": {
          description: "asset_too_large：超过该类型的大小上限",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/scenes/{sceneId}": {
    get: {
      tags: ["scenes"],
      summary: "单个场景定义",
      parameters: [
        { name: "sceneId", in: "path", required: true, schema: fromValidator(sceneIdParamSchema) },
      ],
      responses: {
        "200": ok("场景"),
        // `sceneIdParamSchema` runs on this route, so a malformed id is a 400 —
        // documented nowhere until now, which made it look like a 404 case.
        "400": badRequest,
        "401": unauthorized,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/scenes/{sceneId}/overlay": {
    get: {
      tags: ["scenes"],
      summary: "场景 lanelet 叠加层",
      parameters: [
        { name: "sceneId", in: "path", required: true, schema: fromValidator(sceneIdParamSchema) },
      ],
      responses: {
        "200": ok("叠加层"),
        "400": badRequest,
        "401": unauthorized,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/config/status": {
    get: {
      tags: ["ops"],
      summary: "配置健康状况：哪个文件未生效、为什么",
      description:
        "某个配置文件解析或校验失败时，后端沿用该文件上次的有效内容（或出厂默认）继续运行；issues 列出每个这样的文件与原因。",
      responses: {
        "200": {
          description: "配置状态",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  checkedAt: { type: ["string", "null"], format: "date-time" },
                  issues: { type: "array", items: jsonObject },
                },
              },
            },
          },
        },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/vehicles": configFileOperations({
    noun: "车辆配置 vehicles.json",
    capability: "vehicles:write",
    key: "vehicles",
    invalidError: "invalid_vehicles / unknown_scene_in_vehicle",
  }),
  "/api/v1/formation-config": configFileOperations({
    noun: "编队配置 formations.json",
    capability: "formations:write",
    key: "formations",
    invalidError: "invalid_formations / unknown_device_in_formation / unknown_scene_in_formation",
  }),
  "/api/v1/rules/config": configFileOperations({
    noun: "消息规则 rules.json",
    capability: "rules:write",
    key: "config",
    invalidError: "invalid_rules",
  }),
  "/api/v1/reports/config": configFileOperations({
    noun: "定时报表 reports.json",
    capability: "reports:write",
    key: "config",
    invalidError: "invalid_reports",
  }),
  "/api/v1/rbac/roles": rbacRoles,
  "/api/v1/rbac/roles/{id}": rbacRole,
  "/api/v1/rbac/groups": rbacGroups,
  "/api/v1/rbac/groups/{id}": rbacGroup,
  "/api/v1/codebook": {
    get: {
      tags: ["codebook"],
      summary: "生效的报码字典（内置表叠加部署侧码表）",
      responses: {
        "200": { ...ok("报码列表"), headers: etagHeader },
        "401": unauthorized,
        ...apiWideResponses,
      },
    },
    put: {
      tags: ["codebook"],
      summary: "替换部署侧报码字典（需 codebook:write）",
      parameters: [ifMatchParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: {
        "200": { ...ok("合并后的报码列表"), headers: etagHeader },
        // 校验失败（非法码表）。
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "409": configWriteConflict,
        ...apiWideResponses,
      },
    },
  },
  /**
   * Three surfaces the server has always served and this document never mentioned.
   *
   * All three sit **behind the auth gate** (`app.ts` mounts `authenticate` before
   * them) but **outside `/api`**, so the coarse rate limiter does not apply and none
   * of them can answer 429 — which is why they do not spread `apiWideResponses`.
   * Documenting them is what makes "everything this deployment serves" answerable
   * from the spec instead of from reading `app.ts`.
   */
  "/openapi.json": {
    get: {
      tags: ["ops"],
      summary: "本文档自身（需登录会话）",
      responses: {
        "200": {
          description: "OpenAPI 3.1 文档",
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/docs": {
    get: {
      tags: ["ops"],
      summary: "同源自带的 Swagger UI（无 CDN，需登录会话）",
      responses: {
        "200": {
          description: "HTML 页面",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "401": unauthorized,
      },
    },
  },
  "/docs/openapi.json": {
    get: {
      tags: ["ops"],
      summary: "Swagger UI 自己取的文档副本",
      description:
        "与 /openapi.json 内容相同，单独一条是因为这一页要用同源相对路径取它，见 routes/docs.ts。",
      responses: {
        "200": {
          description: "OpenAPI 3.1 文档",
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/scene-maps/{assetPath}": {
    get: {
      tags: ["scenes"],
      summary: "场景地图静态资源（栅格图 / 点云 / .osm / 元数据）",
      description:
        "由 config-runtime/scene-maps 提供，运行期热加载、不进镜像。响应带 Cache-Control: no-store。",
      parameters: [
        {
          name: "assetPath",
          in: "path",
          required: true,
          description: "相对 scene-maps 的资源路径，可含子目录",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": { description: "资源内容（类型随文件而定）" },
        "401": unauthorized,
        "404": notFound,
      },
    },
  },
  "/api/v1/debug/ingest": {
    post: {
      tags: ["debug"],
      summary: "调试注入遥测（需 admin，且 DEBUG_INGEST_ENABLED=true，否则 404）",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(ingestBodySchema) } },
      },
      responses: {
        "200": ok("已注入并返回快照"),
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  // Admin user management. Documented on the `/api/v1` surface (what new clients should use);
  // the unversioned `/api/users` twin exists as well, mounted the same way as every other
  // domain router, but is not enumerated separately to avoid doubling the spec.
  "/api/v1/users": {
    get: {
      tags: ["users"],
      summary: "列出用户（需 admin）",
      responses: {
        "200": {
          description: "用户列表",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  users: { type: "array", items: { $ref: "#/components/schemas/AdminUserView" } },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        ...apiWideResponses,
      },
    },
    post: {
      tags: ["users"],
      summary: "创建用户（需 admin）",
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(createUserSchema) } },
      },
      responses: {
        "201": ok("已创建", "AdminUserView", "user"),
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "409": conflict,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/users/{username}": {
    get: {
      tags: ["users"],
      summary: "获取单个用户（需 admin）",
      parameters: [usernamePath],
      responses: {
        "200": ok("用户", "AdminUserView", "user"),
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
    patch: {
      tags: ["users"],
      summary: "更新用户角色/资料/启禁用（需 admin；改角色或禁用会使已签发 token 立即失效）",
      parameters: [usernamePath],
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(updateUserSchema) } },
      },
      responses: {
        "200": ok("已更新", "AdminUserView", "user"),
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        "409": conflict,
        ...apiWideResponses,
      },
    },
    delete: {
      tags: ["users"],
      summary: "删除用户（需 admin；受锁死防护约束）",
      parameters: [usernamePath],
      responses: {
        "204": { description: "已删除" },
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        "409": conflict,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/users/{username}/reset-password": {
    post: {
      tags: ["users"],
      summary: "管理员重置用户密码（需 admin；会使该用户所有会话失效）",
      parameters: [usernamePath],
      requestBody: {
        required: true,
        content: { "application/json": { schema: fromValidator(resetPasswordSchema) } },
      },
      responses: {
        "204": { description: "已重置" },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/users/{username}/logout": {
    post: {
      tags: ["users"],
      summary: "强制下线用户所有设备（需 admin；踢掉全部会话并使已签发 token 立即失效）",
      parameters: [usernamePath],
      responses: {
        "204": { description: "已强制下线" },
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/users/{username}/sessions": {
    get: {
      tags: ["users"],
      summary: "查看某用户的活跃会话（需 admin）",
      parameters: [usernamePath],
      responses: {
        "200": {
          description: "该用户的会话列表",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  sessions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SessionView" },
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/users/{username}/sessions/{sessionId}": {
    delete: {
      tags: ["users"],
      summary: "下线某用户的某个会话（需 admin）",
      parameters: [
        usernamePath,
        { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "已下线" },
        "401": unauthorized,
        "403": forbidden,
        "404": notFound,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/audit": {
    get: {
      tags: ["audit"],
      summary: "查询审计日志（需 admin；filters: actor / action / from / to）",
      parameters: queryParameters(auditQuerySchema, {
        action: "逗号拼接的动作列表，如 user_create,user_delete（每项须属 AUDIT_ACTIONS）",
      }),
      responses: {
        "200": {
          description: "审计条目（ts 倒序，服务端夹上限）",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  entries: { type: "array", items: { $ref: "#/components/schemas/AuditEntry" } },
                  ...listCap,
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/notify/log": {
    get: {
      tags: ["notify"],
      summary: "查询告警外发记录（需 admin；filters: deviceId / channelId / status / from / to）",
      parameters: queryParameters(notifyLogQuerySchema),
      responses: {
        "200": {
          description: "发送记录（ts 倒序，服务端夹上限）",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/NotifySendRecord" },
                  },
                  ...listCap,
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
        "403": forbidden,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/notify/config": {
    put: (
      configFileOperations({
        noun: "外发配置 notify.json",
        capability: "notify:write",
        key: "config",
        invalidError: "invalid_notify",
      }) as { put: Record<string, unknown> }
    ).put,
    get: {
      tags: ["notify"],
      summary: "生效外发渠道（需 admin；不含端点 URL）",
      responses: {
        "200": {
          description: "渠道视图数组",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  channels: {
                    type: "array",
                    items: { $ref: "#/components/schemas/NotifyChannelView" },
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        ...apiWideResponses,
      },
    },
  },
  "/api/v1/notify/config/raw": {
    get: (
      configFileOperations({
        noun: "外发配置 notify.json（渠道只含 urlEnv 变量名，不含密钥）",
        capability: "notify:write",
        key: "config",
        invalidError: "invalid_notify",
      }) as { get: Record<string, unknown> }
    ).get,
  },
};
