/**
 * OpenAPI 3.1 description of the NavFleet backend API.
 *
 * Hand-maintained (no code generation) and served as JSON at GET /openapi.json.
 * View it with any OpenAPI tool — e.g. paste into https://editor.swagger.io or
 * point Redoc/Swagger UI at the served URL. Kept intentionally pragmatic: the
 * common request/response shapes are typed; free-form telemetry payloads are
 * described as generic objects (the normalizer accepts many shapes).
 *
 * Paths are unversioned (`/api/...`). A `/api/v1` prefix was consciously
 * deferred: this is an internal, single-instance, read-only monitoring tool, so
 * the version churn across frontend/nginx/tests is not yet justified.
 */

const errorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

const codeStateSchema = {
  type: "object",
  properties: {
    code: { type: "number" },
    info: { type: "string" },
    stamp: { type: "string", nullable: true },
  },
} as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "NavFleet API",
    version: "0.1.0",
    description:
      "AGV/智能车队实时监控后端。只读监控范围：设备/编队快照、历史轨迹、告警、场景地图，" +
      "以及登录鉴权与可观测性探针。除公开探针外，接口需 httpOnly Cookie 会话。",
  },
  servers: [{ url: "/", description: "Same-origin (behind nginx)" }],
  tags: [
    { name: "auth", description: "登录 / 会话" },
    { name: "fleet", description: "车队快照与设备" },
    { name: "alerts", description: "告警" },
    { name: "scenes", description: "场景地图" },
    { name: "ops", description: "健康探针与指标" },
    { name: "debug", description: "调试注入（受限）" },
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
      CodeState: codeStateSchema,
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", maxLength: 200 },
          password: { type: "string", maxLength: 200 },
        },
      },
      PublicUser: {
        type: "object",
        properties: {
          username: { type: "string" },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
        },
      },
      Alert: {
        type: "object",
        properties: {
          eventKey: { type: "string" },
          deviceId: { type: "string" },
          alertId: { type: "string" },
          severity: { type: "string", enum: ["critical", "warning", "notice"] },
          source: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          info: { type: "string" },
          code: { type: "number", nullable: true },
          active: { type: "boolean" },
          ts: { type: "string" },
          firstSeenAt: { type: "string", format: "date-time" },
          lastSeenAt: { type: "string", format: "date-time" },
          clearedAt: { type: "string", format: "date-time", nullable: true },
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
    },
  },
  security: [{ cookieAuth: [] }],
  paths: {},
} as Record<string, unknown>;

// PLACEHOLDER_PATHS
const ok = (description: string, schemaRef?: string) => ({
  description,
  content: {
    "application/json": {
      schema: schemaRef ? { $ref: schemaRef } : { type: "object", additionalProperties: true },
    },
  },
});

const unauthorized = {
  description: "未认证",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const badRequest = {
  description: "参数校验失败",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

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
      },
    },
  },
  "/api/auth/logout": {
    post: {
      tags: ["auth"],
      summary: "登出，清除会话 cookie",
      security: [],
      responses: { "204": { description: "已登出" } },
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
      },
    },
  },
  "/api/fleet/snapshot": {
    get: {
      tags: ["fleet"],
      summary: "车队快照（设备/编队/汇总）",
      responses: { "200": ok("快照"), "401": unauthorized },
    },
  },
  "/api/formations": {
    get: {
      tags: ["fleet"],
      summary: "编队列表",
      responses: { "200": ok("编队"), "401": unauthorized },
    },
  },
  "/api/devices/{deviceId}/history": {
    get: {
      tags: ["fleet"],
      summary: "设备历史轨迹（时序采样，最新在前）",
      parameters: [
        { name: "deviceId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "ISO-8601 或 epoch",
        },
        { name: "to", in: "query", required: false, schema: { type: "string" } },
        { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 5000 } },
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
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
      },
    },
  },
  "/api/alerts": {
    get: {
      tags: ["alerts"],
      summary: "告警查询",
      parameters: [
        {
          name: "severity",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["critical", "warning", "notice"] },
        },
        { name: "deviceId", in: "query", required: false, schema: { type: "string" } },
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["active", "cleared"] },
        },
      ],
      responses: {
        "200": {
          description: "告警列表",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/Alert" } },
                },
              },
            },
          },
        },
        "400": badRequest,
        "401": unauthorized,
      },
    },
  },
  "/api/scenes": {
    get: {
      tags: ["scenes"],
      summary: "场景地图目录",
      responses: { "200": ok("场景列表"), "401": unauthorized },
    },
  },
  "/api/scenes/{sceneId}": {
    get: {
      tags: ["scenes"],
      summary: "单个场景定义",
      parameters: [{ name: "sceneId", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": ok("场景"), "401": unauthorized, "404": ok("未找到") },
    },
  },
  "/api/scenes/{sceneId}/overlay": {
    get: {
      tags: ["scenes"],
      summary: "场景 lanelet 叠加层",
      parameters: [{ name: "sceneId", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": ok("叠加层"), "401": unauthorized, "404": ok("未找到") },
    },
  },
  "/api/debug/ingest": {
    post: {
      tags: ["debug"],
      summary: "调试注入遥测（需 admin，且 DEBUG_INGEST_ENABLED=true，否则 404）",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        "200": ok("已注入并返回快照"),
        "400": badRequest,
        "401": unauthorized,
        "403": ok("权限不足"),
        "404": ok("未启用"),
      },
    },
  },
};
