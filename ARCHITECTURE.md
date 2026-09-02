# NavFleet 项目架构说明

## 1. 项目定位

NavFleet（智能车队监控平台）是一个面向 AGV、巡检车、无人搬运车等设备的实时运行态监控系统。系统目标是把设备接入、实时展示、历史追踪、地图资源和运行配置统一到一套可部署、可维护的工程中。

系统提供：

- MQTT 设备接入。
- 车辆实时状态归一化。
- 最新快照和历史遥测存储。
- WebSocket 实时推送。
- 车辆、编队、告警、GPS 地图、场景地图和点云地图展示。
- Lanelet2 OSM 文件服务端解析。
- Docker Compose 一键部署。

## 2. 技术栈

### 前端

- Vue 3（`<script setup>`，渐进式 TypeScript 迁移）
- Vite
- vue-router（hash 路由）+ Pinia（状态库）
- 原生 CSS（明暗双主题，CSS 变量令牌 + `data-theme`）
- 高德地图 JS API，需要配置浏览器 Key
- 自定义点云、场景地图和路网渲染逻辑
- Vitest 单元测试

### 后端

- Node.js 20+
- TypeScript
- Express
- `ws` WebSocket 服务
- `mqtt` MQTT 客户端
- `mongodb` 官方驱动
- `chokidar` 监听运行期配置变化
- `pino` 日志

### 部署组件

- Nginx：统一 HTTP 入口和反向代理
- Mosquitto：MQTT Broker
- MongoDB：最新快照、时序遥测和告警存储
- Docker Compose：单机部署编排

## 3. 总体架构

```mermaid
flowchart LR
  Vehicle["车辆/模拟器"] -->|/fleet/+/vehicle_info| Broker["Mosquitto MQTT Broker"]
  Vehicle -->|/fleet/+/status| Broker
  Broker --> BackendMqtt["Backend MQTT Client"]
  BackendMqtt --> Normalize["normalize.ts 消息归一化"]
  Normalize --> Store["DashboardStore 内存快照"]
  Store --> MongoLatest["Mongo device_latest"]
  Store --> MongoTs["Mongo telemetry_ts"]
  Store --> MongoAlerts["Mongo alerts"]
  Config["config-runtime"] --> Registry["ConfigRegistry"]
  Registry --> Store
  Store --> Rest["REST API"]
  Store --> Ws["WebSocket /ws"]
  Registry --> Overlay["Lanelet2 OSM overlay"]
  Rest --> Nginx["Nginx"]
  Ws --> Nginx
  Overlay --> Nginx
  Nginx --> Frontend["Vue Frontend"]
```

架构边界：

- 设备只需要接入 MQTT，不需要知道前端和数据库。
- 前端只访问后端，不直接连接 MQTT Broker。
- 后端负责配置合并、数据归一化、告警生成、持久化和实时推送。
- MongoDB 负责恢复和查询，不承担前端实时推送职责。
- `config-runtime/` 是运行时配置源，镜像构建物不包含业务配置的最终版本。

## 4. 目录职责

```text
NavFleet/
├─ backend/
│  ├─ src/
│  │  ├─ auth/               # 登录 / JWT / RBAC 中间件
│  │  ├─ config.ts
│  │  ├─ configRegistry.ts
│  │  ├─ index.ts
│  │  ├─ laneletOsm.ts
│  │  ├─ normalize.ts
│  │  ├─ openapi.ts          # OpenAPI 3.1 文档
│  │  ├─ persistence.ts
│  │  ├─ store.ts
│  │  ├─ validation.ts       # zod 入参校验
│  │  └─ types.ts
│  ├─ scripts/               # mock-mqtt.ts, load-ingest.ts
│  ├─ test/                  # Vitest 单测
│  ├─ package.json
│  └─ Dockerfile
├─ frontend/
│  ├─ src/
│  │  ├─ components/         # GpsMap / RosSceneMap / LoginForm / SkeletonBlock 等
│  │  ├─ composables/        # useAuth / useTheme / useNotifications / useAlertAck
│  │  │                      # useSvgViewport / useSceneOverlay / useHistoryPlayback
│  │  ├─ lib/                # fleetNormalize（纯归一化）
│  │  ├─ services/           # fleetApi（REST）
│  │  ├─ stores/             # fleet（Pinia）
│  │  ├─ router/             # vue-router
│  │  ├─ views/              # Dashboard / History / Alerts / Settings / NotFound
│  │  ├─ utils/
│  │  ├─ App.vue
│  │  └─ main.ts
│  ├─ test/                  # Vitest 单测
│  ├─ package.json
│  └─ Dockerfile
├─ packages/
│  └─ shared/                # @navfleet/shared —— 领域类型单一来源，前后端共同引用
├─ e2e/                      # Playwright 端到端 + axe-core 无障碍审计
├─ config-runtime/
│  ├─ fleet.json
│  ├─ vehicles.json
│  ├─ formations.json
│  ├─ scenes.json
│  └─ scene-maps/
├─ scripts/                  # dev.sh / smoke.sh
└─ deploy/
   ├─ docker-compose.yml     # 基础编排
   ├─ docker-compose.tls.yml # TLS 叠加
   ├─ docker-compose.monitoring.yml  # Prometheus + Grafana 叠加
   ├─ docker-compose.backup.yml      # 定时备份叠加
   ├─ .env.example
   ├─ nginx/                 # default.conf / locations.conf / tls.conf
   ├─ mosquitto/             # mosquitto.conf + 生成账号与 ACL 的 entrypoint
   ├─ prometheus/            # 抓取配置 + 告警规则
   ├─ grafana/               # 预置数据源与面板
   ├─ docs/                  # 部署 / 配置 / 备份恢复
   └─ tools/                 # 备份恢复、自签证书、点云导入等脚本
```

## 5. 后端模块

### `src/config.ts`

职责：

- 加载 `.env.local` 和 `.env`。
- 读取环境变量。
- 推导运行期配置目录。
- 输出 `config` 和 `runtimePaths`。

重要路径：

- `runtimePaths.fleetFilePath`
- `runtimePaths.vehiclesFilePath`
- `runtimePaths.formationsFilePath`
- `runtimePaths.scenesFilePath`
- `runtimePaths.sceneMapsPath`

### `src/configRegistry.ts`

职责：

- 读取 `fleet.json`、`vehicles.json`、`formations.json`、`scenes.json`。
- 校验车辆 ID、编队 ID、场景 ID。
- 把车辆静态配置套用到实时快照。
- 根据编队配置生成编队快照。
- 解析 `osmUrl` 对应的 Lanelet2 OSM 文件并生成 overlay。
- 监听运行期配置变化并热加载。

热加载监听范围：

- `fleet.json`
- `vehicles.json`
- `formations.json`
- `scenes.json`
- `scene-maps/**/*.osm`

### `src/index.ts` 与它拆出的模块

`index.ts` 只负责**组装运行时并启动**（约 115 行）；此前它是一个 548 行的 god-file，
PR #28 按职责拆开：

| 模块                 | 职责                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `app.ts`             | 组装 Express：中间件顺序、鉴权闸门、`/api/v1` 与 `/api` 双挂载、404/错误处理 |
| `routes/ops.ts`      | 公开运维端点：`/health`、`/health/ready`、`/metrics`、`/openapi.json`        |
| `routes/fleet.ts`    | 车队快照、编队、历史、告警                                                   |
| `routes/scenes.ts`   | 场景定义与 Lanelet2 overlay                                                  |
| `routes/debug.ts`    | `/debug/ingest`（仅在显式开启且非生产时挂载）                                |
| `routes/docs.ts`     | 同源自带的 Swagger UI                                                        |
| `websocket.ts`       | `/ws` 升级握手（只认 cookie 里的 token）、心跳、广播                         |
| `mqtt.ts`            | Broker 连接、订阅、zod 校验后的摄入                                          |
| `metrics.ts`         | `prom-client` 注册表与 per-route 请求直方图                                  |
| `logger.ts`          | pino 根 logger + 脱敏路径 + `moduleLogger()`                                 |
| `requestContext.ts`  | request-id 贯穿日志与 500 响应                                               |
| `runtimeState.ts`    | 跨模块共享的运行时状态（连接状态、启动时间等）                               |
| `startupChecks.ts`   | 生产配置审计，危险组合 fail-fast                                             |
| `mongoConnection.ts` | Mongo 连接、重连退避与真实健康探测                                           |

静态资源 `/scene-maps/**` 与离线检测定时器仍在 `app.ts` / `index.ts` 中装配。

### `src/normalize.ts`

职责：

- 把设备原始 payload 转换为统一 `DeviceSnapshot`。
- 兼容 snake_case 和 camelCase 字段。
- 从 MQTT topic 中提取 `deviceId`。
- 合并历史值，避免增量上报导致字段丢失。
- 根据 `info_code`、`warning_code`、`error_code` 生成报码告警。
- 根据低电量、离线等规则生成服务端告警。

### `src/store.ts`

职责：

- 保存内存中的原始快照和配置后快照。
- 初始化时从 MongoDB 恢复 `device_latest`（限保留窗口内、最多 `MAX_DEVICES` 台）。
- 在没有恢复数据且配置了 `SEED_FILE` 时加载种子数据。
- 接收 MQTT/API 输入并更新快照。所有写操作串行排在一条**有界**摄入队列上；队列满时丢弃最旧的
  可丢帧（仅 MQTT 遥测可丢），深度与丢弃数上 `/metrics`。
- 准入与淘汰：拒绝不可用的设备 ID，对新设备施加 `MAX_DEVICES` 上限，并淘汰
  `DEVICE_RETENTION_SECONDS` 内未上报过的未声明设备（`vehicles.json` 声明过的不受这两条约束）。
- 写入 MongoDB。
- 广播 WebSocket 事件。
- 根据配置重建车辆和编队状态。

### `src/persistence.ts`

职责：

- 连接 MongoDB。
- 创建集合和索引。
- 写入最新设备快照。
- 写入时序遥测。
- 写入和清理告警。
- 查询历史轨迹和告警。

主要集合：

- `device_latest`
- `telemetry_ts`
- `alerts`

### `src/laneletOsm.ts`

职责：

- 读取 Lanelet2 风格 `.osm` 文件。
- 解析 node、way、relation。
- 提取 `type=lanelet` 的 relation。
- 计算局部坐标、边界和 centerline。
- 输出前端可直接渲染的 `LaneletOverlay`。

## 6. 前端模块

前端为多页 SPA（vue-router hash 路由 + Pinia），入口 `src/main.ts` 装载 Pinia 与
router。原先的单体 `useDashboard` 组合式函数已拆分为 store + 服务层 + 纯归一化模块。

### `src/stores/fleet.ts`（Pinia store）

职责：

- 持有响应式车队状态与派生视图（排序/筛选设备、编队、分组告警、每设备轨迹）。
- 建立并维护有韧性的 WebSocket 连接（指数退避重连、应用层心跳）。
- 处理 `fleet.snapshot` / `fleet.delta`，管理选中车辆/编队、地图模式与每设备轨迹。
- 作为单例，跨路由视图共享，避免重复建连或状态分裂。

### `src/services/fleetApi.ts`

- 集中的 REST 访问层（snapshot/scenes/history/alerts），统一 `credentials` 与非 2xx 抛错。

### `src/lib/fleetNormalize.ts`

- 纯归一化 / 塑形函数（多格式遥测归一、告警派生、lidar→fusion 回退、场景合并、轨迹）。无 Vue 依赖，可单测。

### `src/router/index.ts` 与 `src/views/`

- 路由：`/` 实时监控（`DashboardView.vue`）、`/history` 历史回放（`HistoryView.vue`，时间轴回放，复用 `RosSceneMap`）、`/alerts` 告警中心（`AlertsView.vue`，筛选/确认/分页）、`/settings` 设置（`SettingsView.vue`，主题偏好 + 清除本地数据 + 连接诊断，只读监控范围内不含任何改变车队行为的开关）。
- `App.vue` 为鉴权门 + 外壳（品牌、导航、主题切换、会话、离线横幅、skip-link、唯一的 `<main>` 地标、`<RouterView>`）。视图内部只用 `<div>`/`<section>` 布局：再嵌一层 `<main>` 属于非法 HTML，也会让辅助技术看到两个「主内容」区域。
- 首屏快照到达前，`bootstrapPending` 让受影响区域渲染骨架屏而不是空态文案 —— 「还没到」和「筛选后没有」是两回事，后者会误导操作员去改筛选条件。

### `src/composables/`

- `useAuth.ts`（模块单例，登录/会话/自动续签）、`useTheme.ts`（明暗双主题）、`useNotifications.ts`（toast）、`useAlertAck.ts`（告警确认，localStorage 持久化）、`useHistoryPlayback.ts`（时间轴回放，`samples` 只读 + `setSamples` 修改器）。

### `src/components/GpsMap.vue`

职责：

- 加载高德地图 JS API（按主题切换 darkblue/whitesmoke 样式）。
- 展示启用 GPS 且有坐标的车辆。
- 点击车辆 marker 后切换当前车辆。
- 在缺少高德 Key 时显示配置提示。

### `src/components/RosSceneMap.vue`

职责：

- 展示当前车辆或编队所在的场景地图。
- 支持普通底图、点云 topdown 视图、Lanelet2 overlay。
- 支持缩放、拖拽、视角重置。
- 展示 fusion/lidar 位姿、车辆连线和编队成员，并叠加历史轨迹线（只读监控，不含路径下发/编辑）。

### `src/data-defaults.ts`

职责：

- 提供前端离线兜底场景定义。
- 后端可用时以后端返回为准。

## 7. 数据链路

### 7.1 启动流程

1. 后端读取运行期配置。
2. 后端连接 MongoDB。
3. 后端从 `device_latest` 恢复最新车辆快照。
4. 后端启动 HTTP、WebSocket 和 MQTT 客户端。
5. 后端订阅 MQTT 主题。
6. 前端请求 `/api/scenes`。
7. 前端请求 `/api/fleet/snapshot`。
8. 前端建立 `/ws` 实时连接。

### 7.2 遥测处理流程

1. 车辆发布 `/fleet/{deviceId}/vehicle_info`。
2. Mosquitto 转发给后端。
3. 后端解析 JSON。
4. `normalize.ts` 转换为统一快照。
5. `ConfigRegistry` 套用车辆静态配置。
6. `DashboardStore` 更新内存状态。
7. `Persistence` 写入 `device_latest` 和 `telemetry_ts`。
8. `Persistence` 更新 `alerts`。
9. WebSocket 广播 `fleet.delta`。
10. 前端增量更新页面。

### 7.3 状态处理流程

1. 车辆发布 `/fleet/{deviceId}/status`。
2. 后端解析在线状态。
3. 后端更新对应设备的 `online`。
4. 后端写入最新快照和遥测。
5. 后端广播 `device.online` 或 `device.offline`，同时广播 `fleet.delta`。

### 7.4 离线检测流程

1. 后端每 15 秒扫描一次内存快照。
2. 当前时间与设备 `stamp` 差值超过 `OFFLINE_AFTER_SECONDS`。
3. 后端把设备标记为离线。
4. 后端生成 `offline` 告警。
5. 后端写入 MongoDB 并推送 WebSocket。
6. 同一次扫描顺带淘汰静默超过 `DEVICE_RETENTION_SECONDS` 的未声明设备；有淘汰发生时广播一次
   `fleet.snapshot`，让长驻页面同步移除。

## 8. 配置体系

配置根目录由 `CONFIG_ROOT_PATH` 指定，Docker 中固定为 `/runtime-config`。

```text
config-runtime/
├─ fleet.json
├─ vehicles.json
├─ formations.json
├─ scenes.json
└─ scene-maps/
```

### `fleet.json`

车队级默认配置，包含：

- `fleetName`
- `topicPattern`
- `defaultSceneId`
- `defaultMapProfile`
- `defaultGpsEnabled`
- `defaultRosMapEnabled`

### `vehicles.json`

车辆配置数组，包含：

- `deviceId`
- `deviceName`
- `defaultSceneId`
- `mapProfile`
- `gpsEnabled`
- `rosMapEnabled`
- `tags`

车辆配置不会凭空创建车辆。页面中的车辆来自 MQTT、调试 API 或 MongoDB 恢复数据。

### `formations.json`

编队配置数组，包含：

- `formationId`
- `formationName`
- `deviceIds`
- `sceneId`
- `description`
- `color`

`deviceIds` 必须引用 `vehicles.json` 中存在的车辆。

### `scenes.json`

场景配置数组，支持：

- 普通底图：`imageUrl`
- Lanelet2 OSM：`osmUrl`
- 点云：`pointCloudUrl`、`pointCloudMetaUrl`

场景必须包含坐标换算所需的基础字段：

- `sceneId`
- `sceneName`
- `mapFrame`
- `resolution`
- `origin`
- `width`
- `height`

## 9. MongoDB 存储设计

### `device_latest`

保存每台设备的最新快照。服务重启后，后端会从这里恢复页面状态。

索引：

- `{ deviceId: 1 }` 唯一索引
- `{ stamp: -1 }`

### `telemetry_ts`

MongoDB time series collection，用于保存遥测历史。默认保留时间由 `TELEMETRY_RETENTION_SECONDS` 控制。

主要内容：

- `ts`
- `meta.deviceId`
- `measurements.gps`
- `measurements.fusionLoc`
- `measurements.lidarLoc`
- `measurements.vehicleInfo`
- `measurements.taskStatus`
- `measurements.platformTaskStatus`
- `measurements.infoCode`
- `measurements.warningCode`
- `measurements.errorCode`
- `measurements.speedLimit`

### `alerts`

保存活动告警和已清除告警。默认保留时间由 `ALERTS_RETENTION_SECONDS` 控制。

索引：

- `{ deviceId: 1, ts: -1 }`
- `{ severity: 1, active: 1, ts: -1 }`
- TTL：`lastSeenAt`

## 10. API

除公开探针（`/health`、`/health/ready`、`/metrics`、`/openapi.json`）与
`/api/auth/login|refresh|logout` 外，其余接口需登录会话（httpOnly Cookie）。
机器可读定义见 `backend/src/openapi.ts`，运行时由 `GET /openapi.json` 提供。

### 鉴权与运维探针

- `POST /api/auth/login`、`POST /api/auth/refresh`、`POST /api/auth/logout`、`GET /api/auth/me`
- `GET /health`（liveness）、`GET /health/ready`（readiness：store/mongo/mqtt 分项）
- `GET /metrics`（Prometheus 文本，`METRICS_ENABLED` 开关）
- `GET /openapi.json`（OpenAPI 3.1）

### `GET /health`

健康检查（liveness）。

### `GET /api/fleet/snapshot`

返回当前车队快照：

- `summary`
- `fleetName`
- `topicPattern`
- `updatedAt`
- `devices`
- `formations`

### `GET /api/formations`

返回编队快照列表。

### `GET /api/devices/:deviceId/history`

查询单车历史遥测。

查询参数：

- `from`：ISO 时间，可选
- `to`：ISO 时间，可选
- `limit`：数量限制，可选

### `GET /api/alerts`

查询告警。

查询参数：

- `severity`
- `deviceId`
- `status=active|cleared`

### `GET /api/scenes`

返回场景列表。

### `GET /api/scenes/:sceneId`

返回单个场景。

### `GET /api/scenes/:sceneId/overlay`

返回 Lanelet2 OSM 解析后的 overlay。只有配置了 `osmUrl` 的场景才有该接口。

### `POST /api/debug/ingest`

调试注入接口。可直接向后端注入一条设备 payload，用于本地排查。

### `GET /scene-maps/**`

后端静态提供 `config-runtime/scene-maps/` 下的资源。

## 11. WebSocket

路径：

```text
/ws
```

事件：

- `fleet.snapshot`：建立连接后发送全量快照。
- `fleet.delta`：单设备增量变化。
- `alert.created`：新告警。
- `alert.cleared`：告警清除。
- `device.online`：设备上线。
- `device.offline`：设备离线。

## 12. Docker 部署架构

Compose 服务：

- `nginx`
- `frontend`
- `backend`
- `mongo`
- `mosquitto`

默认端口：

- `HTTP_HOST_PORT=8080`
- `MQTT_HOST_PORT=1883`

默认内部连接：

- Backend 到 Mosquitto：`mqtt://mosquitto:1883`
- Backend 到 Mongo：`mongodb://root:example@mongo:27017/fleet_monitor?authSource=admin`
- Nginx 到 Backend：`http://backend:3000`
- Nginx 到 Frontend：`http://frontend:80`

## 13. 注意事项

- 高德地图需填写API Key 才可正常渲染。
- 修改代码后需要重新构建 Docker 镜像。
- 修改 `config-runtime` 中的 JSON 配置不需要重新构建。
- 修改 `.osm` 文件不需要重新构建，但浏览器需要刷新。
- Mosquitto **默认关闭匿名连接**（`allow_anonymous false` + 双向 ACL），compose 用
  `${MQTT_SUBSCRIBER_PASSWORD:?}` 强制必填：口令留空时 `up` 直接报错退出，而不是起一个
  谁都能连的 broker。1883 端口只绑 `127.0.0.1`。生产环境仍建议在此之上加 TLS。
- `deploy/.env.example` 里的 MongoDB 口令是占位值，部署前必须替换。
