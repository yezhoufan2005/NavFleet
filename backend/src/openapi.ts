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
  alertsQuerySchema,
  deviceIdParamSchema,
  historyQuerySchema,
  ingestBodySchema,
  loginSchema,
  sceneIdParamSchema,
} from "./validation";

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
      LoginRequest: fromValidator(loginSchema),
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
  "/api/v1/fleet/snapshot": {
    get: {
      tags: ["fleet"],
      summary: "车队快照（设备/编队/汇总）",
      responses: { "200": ok("快照"), "401": unauthorized },
    },
  },
  "/api/v1/formations": {
    get: {
      tags: ["fleet"],
      summary: "编队列表",
      responses: { "200": ok("编队"), "401": unauthorized },
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
          from: "ISO-8601 或 epoch",
          to: "ISO-8601 或 epoch",
          limit: "返回的最大采样数",
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
  "/api/v1/scenes": {
    get: {
      tags: ["scenes"],
      summary: "场景地图目录",
      responses: { "200": ok("场景列表"), "401": unauthorized },
    },
  },
  "/api/v1/scenes/{sceneId}": {
    get: {
      tags: ["scenes"],
      summary: "单个场景定义",
      parameters: [
        { name: "sceneId", in: "path", required: true, schema: fromValidator(sceneIdParamSchema) },
      ],
      responses: { "200": ok("场景"), "401": unauthorized, "404": ok("未找到") },
    },
  },
  "/api/v1/scenes/{sceneId}/overlay": {
    get: {
      tags: ["scenes"],
      summary: "场景 lanelet 叠加层",
      parameters: [
        { name: "sceneId", in: "path", required: true, schema: fromValidator(sceneIdParamSchema) },
      ],
      responses: { "200": ok("叠加层"), "401": unauthorized, "404": ok("未找到") },
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
        "403": ok("权限不足"),
        "404": ok("未启用"),
      },
    },
  },
};
