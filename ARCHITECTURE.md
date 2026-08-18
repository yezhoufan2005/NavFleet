# NavFleet 项目架构说明

## 1. 项目定位

NavFleet 是一个多智能车实时监控平台，主要面向 AGV、巡检车、无人搬运车等设备的运行态监控。系统目标是把设备接入、实时展示、历史追踪、地图资源和运行配置统一到一套可部署、可维护的工程中。

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

- Vue 3
- Vite
- 原生 CSS
- 高德地图 JS API，需要配置浏览器 Key
- 自定义点云、场景地图和路网渲染逻辑

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
mqtt/
├─ backend/
│  ├─ src/
│  │  ├─ config.ts
│  │  ├─ configRegistry.ts
│  │  ├─ index.ts
│  │  ├─ laneletOsm.ts
│  │  ├─ normalize.ts
│  │  ├─ persistence.ts
│  │  ├─ store.ts
│  │  └─ types.ts
│  ├─ scripts/mock-mqtt.ts
│  ├─ package.json
│  └─ Dockerfile
├─ frontend/
│  ├─ src/
│  │  ├─ components/
│  │  ├─ composables/
│  │  ├─ utils/
│  │  ├─ App.vue
│  │  └─ main.js
│  ├─ package.json
│  └─ Dockerfile
├─ config-runtime/
│  ├─ fleet.json
│  ├─ vehicles.json
│  ├─ formations.json
│  ├─ scenes.json
│  └─ scene-maps/
└─ deploy/
   ├─ docker-compose.yml
   ├─ .env.example
   ├─ nginx/default.conf
   ├─ mosquitto/mosquitto.conf
   ├─ docs/
   └─ tools/
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

### `src/index.ts`

职责：

- 创建 Express 服务。
- 提供 REST API。
- 暴露 `/scene-maps/**` 静态资源。
- 创建 WebSocket `/ws`。
- 连接 MQTT Broker。
- 订阅 `/fleet/+/vehicle_info` 和 `/fleet/+/status`。
- 定期执行离线检测。

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
- 初始化时从 MongoDB 恢复 `device_latest`。
- 在没有恢复数据且配置了 `SEED_FILE` 时加载种子数据。
- 接收 MQTT/API 输入并更新快照。
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

### `src/composables/useDashboard.js`

职责：

- 管理页面状态。
- 拉取 `/api/scenes` 和 `/api/fleet/snapshot`。
- 建立 WebSocket 连接。
- 处理 `fleet.snapshot` 和 `fleet.delta`。
- 管理选中车辆、选中编队、地图模式和路径编辑状态。
- 对后端数据做前端兜底归一化。

### `src/components/GpsMap.vue`

职责：

- 加载高德地图 JS API。
- 展示启用 GPS 且有坐标的车辆。
- 点击车辆 marker 后切换当前车辆。
- 在缺少高德 Key 时显示配置提示。

### `src/components/RosSceneMap.vue`

职责：

- 展示当前车辆或编队所在的场景地图。
- 支持普通底图、点云 topdown 视图、Lanelet2 overlay。
- 支持缩放、拖拽、视角重置。
- 展示 fusion/lidar 位姿、车辆连线和编队成员。
- 支持规划路径点编辑。

### `src/data-defaults.js`

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

### `GET /health`

健康检查。

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
- 默认 Mosquitto 允许匿名连接，只适合内网验收或开发环境；生产环境建议开启账号、密码、ACL 和 TLS。
- 默认 MongoDB 密码是示例值，生产环境必须修改。
