# NavFleet 验收清单

本清单对照「demo → 成熟系统」分阶段计划，逐项记录验收状态与验证方式。
图例：✅ 已验证 · ⏳ 待 docker 环境验证 · ⛔ 范围外（明确不做）。

验证基线（本机，Node 20）：
- 后端 `cd backend && npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` → **52 测试通过**，全绿。
- 前端 `cd frontend && npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` → **29 测试通过**，全绿。
- 契约冒烟 `scripts/smoke.sh` → **21/21 通过**（鉴权、探针、历史端到端等）。

## 工程化基线（Phase 0）
- ✅ git 化 + GitHub 远端；前后端 ESLint/Prettier/Vitest + `.github/workflows/ci.yml`。
- ✅ 前端引入 TypeScript 工具链（vue-tsc，渐进迁移）。

## 正确性与功能补齐（Phase 1）
- ✅ 枚举文案（控制模式/挡位/任务状态）中文映射。
- ✅ 历史轨迹渲染；三类场景地图（图片/点云/OSM）。
- ✅ MQTT 主题由 `topicPattern` 派生；zod 入参校验 + 4xx。

## 安全与鉴权（Phase 2）
- ✅ JWT(access+refresh) + httpOnly Cookie；RBAC（admin/operator/viewer）。
- ✅ 种子管理员（`ADMIN_USERNAME`/`ADMIN_PASSWORD`，Mongo + 内存兜底）。
- ✅ helmet/CORS/登录限流；REST 全保护 + WS 握手校验。
- ✅ `POST /api/debug/ingest` 需 admin 且 `DEBUG_INGEST_ENABLED=true`（否则 404）。
- 验证：`scripts/smoke.sh`（未登录 401、错误密码 401、登录 200、越权注入受限）。

## 功能完善与 UX（Phase 3）
- ✅ vue-router（hash）+ Pinia；多页：实时监控 / 历史回放 / 告警中心。
- ✅ 907 行 `useDashboard` 拆为 store + 服务层 + 纯归一化模块（`lib/fleetNormalize` 单测）。
- ✅ 统一错误反馈（toast）、离线横幅 + 重试；WS 指数退避重连 + 心跳。
- ✅ 历史回放（时间轴 scrubber + 播放/倍速，复用 ROS 场景地图）。
- ✅ 告警中心：按严重度/设备/搜索筛选、确认/取消/清除（localStorage）、分页。
- ✅ 明暗双主题（`data-theme` + CSS 令牌；GPS 地图随主题切换）。
- 验证：浏览器实测登录→仪表盘→路由切换→回放 scrub→告警确认；历史端到端见 smoke。
- ⛔ 控制下发、多租户（范围外）。

## 可观测性与生产化（Phase 4）
- ✅ 分级探针：`/health`（liveness）、`/health/ready`（readiness，分项 store/mongo/mqtt）。
- ✅ `/metrics`（Prometheus 文本，`METRICS_ENABLED` 开关）；请求日志 + `LOG_LEVEL`。
- ✅ nginx 安全响应头（X-Frame-Options/X-Content-Type-Options/Referrer-Policy/CSP）、`/api` 限流、TLS 模板。
- ✅ docker-compose 资源限制 + 日志轮转 + 各服务健康检查；补全 backend 鉴权 env 透传。
- ✅ Mongo 备份/恢复脚本 + 文档（含索引/TTL 复核）。
- ✅ OpenAPI 3.1（`GET /openapi.json`）。
- ✅ **compose 起停健康 + 备份恢复演练（已在本机 Docker Desktop 验证）**：`docker compose up -d` 五服务全部 healthy；就绪探针 `degraded:false`（store/mongo/mqtt 全绿）；`/metrics`、`/openapi.json` 经边缘 nginx 200；MQTT mock→broker→后端→Mongo 全链路（4 设备、210 消息、告警、历史持久化）；备份→删除 telemetry_ts（0 条）→恢复（100 条）往返成功。
- ⛔ 水平扩展 / Redis pub-sub（范围外）；`/api/v1` 版本前缀（刻意推迟）。

## 端到端 / 性能 / 验收（Phase 5）
- ✅ E2E（无浏览器）：`scripts/smoke.sh` 覆盖鉴权/探针/编队/场景/告警/续签/历史端到端，21/21。
- ✅ 性能压测：`cd backend && npm run load:ingest`（免 broker）。本机基线：
  - 1000 请求 / 并发 25 → ~2300 req/s，p95 19ms，0 错误。
  - 5000 请求 / 并发 50、200 设备 → ~760 req/s，p95 113ms，0 错误。
  - 说明：每次 ingest 触发 O(设备数) 的快照广播，故设备越多单请求越重；如需更高吞吐可加广播节流/削峰（当前范围未做）。
- ✅ 文档同步：README、ARCHITECTURE、deploy/docs 与实现一致。
- ✅ 全量回归：见顶部基线。

## 待办 / 遗留（非阻塞）
- 前端 UI 由使用者手动验证（`http://127.0.0.1:8080`，登录后查看仪表盘/历史回放/告警中心/地图）。
- 部署验证中发现并修复：`backend/Dockerfile` 缺 `tsconfig.build.json`（构建失败）、边缘 nginx 未暴露 `/metrics` 与 `/openapi.json`（已补 location）。
- 可选：离线 demo 数据填充 `frontend/src/data-defaults.js`；i18n 文案抽离；真·UI 无头 E2E（@playwright/test）。
