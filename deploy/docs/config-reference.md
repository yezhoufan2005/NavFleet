# NavFleet 配置参考

本文档说明运行期配置、环境变量、MQTT payload 和地图资源的写法。部署流程见 [deployment.md](./deployment.md)。

## 1. 配置目录

后端只读取一个运行期配置根目录，由 `CONFIG_ROOT_PATH` 指定。

Docker 默认：

```text
CONFIG_ROOT_PATH=/runtime-config
```

本地开发示例（相对仓库根运行，或用绝对路径）：

```text
CONFIG_ROOT_PATH=./config-runtime
```

目录结构：

```text
config-runtime/
├─ fleet.json
├─ vehicles.json
├─ formations.json
├─ scenes.json
└─ scene-maps/
```

职责：

- `fleet.json`：车队级默认值。
- `vehicles.json`：车辆静态配置。
- `formations.json`：编队配置。
- `scenes.json`：场景地图配置。
- `scene-maps/`：图片、点云、OSM、元数据等资源。

## 2. 热加载规则

后端启动时读取全部配置文件。运行时监听：

- `fleet.json`
- `vehicles.json`
- `formations.json`
- `scenes.json`
- `scene-maps/**/*.osm`

生效规则：

- 修改四个 JSON 配置文件：自动热加载。
- 修改 `.osm`：自动重新解析 Lanelet2 overlay。
- 修改图片、点云、普通 JSON 元数据：浏览器刷新后生效。

如果 JSON 写坏或配置校验失败，后端会保留上一份可用配置，并在日志输出错误。

## 3. `fleet.json`

示例：

```json
{
  "fleetName": "综合示范车队",
  "topicPattern": "/fleet/{deviceId}/vehicle_info",
  "defaultSceneId": "kangcheng-airy",
  "defaultMapProfile": "lanelet",
  "defaultGpsEnabled": true,
  "defaultRosMapEnabled": true
}
```

字段：

| 字段                   | 类型      | 必填 | 说明                       |
| ---------------------- | --------- | ---- | -------------------------- |
| `fleetName`            | `string`  | 是   | 页面显示的车队名称         |
| `topicPattern`         | `string`  | 是   | 页面展示用 MQTT topic 模板 |
| `defaultSceneId`       | `string`  | 否   | 默认场景 ID                |
| `defaultMapProfile`    | `string`  | 是   | 默认地图类型               |
| `defaultGpsEnabled`    | `boolean` | 是   | 默认是否启用 GPS 视图      |
| `defaultRosMapEnabled` | `boolean` | 是   | 默认是否启用场景地图       |

常见 `defaultMapProfile`：

- `lanelet`
- `pointCloud`
- `rosRaster+lanelet`

## 4. `vehicles.json`

顶层必须是数组。

示例：

```json
[
  {
    "deviceId": "agv-a01",
    "deviceName": "A01 巡检车",
    "defaultSceneId": "kangcheng-airy",
    "mapProfile": "lanelet",
    "gpsEnabled": true,
    "rosMapEnabled": true,
    "tags": ["巡检"]
  }
]
```

字段：

| 字段             | 类型       | 必填 | 说明                                                  |
| ---------------- | ---------- | ---- | ----------------------------------------------------- |
| `deviceId`       | `string`   | 是   | 设备唯一 ID，必须和 MQTT topic 中的 `{deviceId}` 一致 |
| `deviceName`     | `string`   | 是   | 页面显示名称                                          |
| `defaultSceneId` | `string`   | 否   | 设备未上报场景时使用的场景                            |
| `mapProfile`     | `string`   | 否   | 设备地图类型                                          |
| `gpsEnabled`     | `boolean`  | 否   | 是否在 GPS 地图中显示                                 |
| `rosMapEnabled`  | `boolean`  | 否   | 是否在场景地图中显示                                  |
| `tags`           | `string[]` | 否   | 页面展示标签                                          |

规则：

- `deviceId` 不能重复。
- `vehicles.json` 只提供配置覆盖，不会自动创建车辆。
- 车辆至少收到一次 MQTT 上报、调试注入或从 MongoDB 恢复后，才会出现在页面。
- 设备名称优先使用 `vehicles.json`，不会被 MQTT payload 中的名称覆盖。

## 5. `formations.json`

顶层必须是数组。

示例：

```json
[
  {
    "formationId": "inspection-alpha",
    "formationName": "巡检编队 Alpha",
    "deviceIds": ["agv-a01", "agv-b07", "agv-c12"],
    "sceneId": "kangcheng-airy",
    "description": "康城 Airy 巡检编队",
    "color": "#46d7c3"
  }
]
```

字段：

| 字段            | 类型       | 必填 | 说明             |
| --------------- | ---------- | ---- | ---------------- |
| `formationId`   | `string`   | 是   | 编队唯一 ID      |
| `formationName` | `string`   | 是   | 页面显示名称     |
| `deviceIds`     | `string[]` | 是   | 编队车辆 ID 列表 |
| `sceneId`       | `string`   | 否   | 编队默认场景     |
| `description`   | `string`   | 否   | 描述             |
| `color`         | `string`   | 否   | 页面展示颜色     |

规则：

- `formationId` 不能重复。
- `deviceIds` 必须引用 `vehicles.json` 中存在的车辆。
- 编队不会创建车辆，只影响页面聚合、筛选和地图展示。

## 6. `scenes.json`

顶层必须是数组。

### 6.1 通用示例

```json
[
  {
    "sceneId": "kangcheng-airy",
    "sceneName": "康城 Airy 路网",
    "osmUrl": "/scene-maps/kangcheng-airy/kangcheng_airy.osm",
    "mapFrame": "map",
    "resolution": 1,
    "origin": { "x": 0, "y": 0, "yaw": 0 },
    "occupiedThresh": 0.65,
    "freeThresh": 0.2,
    "negate": 0,
    "width": 1000,
    "height": 620,
    "bounds": { "minX": 0, "maxX": 74.007, "minY": 0, "maxY": 88.082 },
    "defaultView": { "zoom": 1, "centerX": 37.0035, "centerY": 44.041 },
    "minZoom": 0.7,
    "maxZoom": 8
  }
]
```

### 6.2 通用字段

| 字段             | 类型     | 必填 | 说明                             |
| ---------------- | -------- | ---- | -------------------------------- |
| `sceneId`        | `string` | 是   | 场景唯一 ID                      |
| `sceneName`      | `string` | 是   | 页面显示名称                     |
| `mapFrame`       | `string` | 是   | 坐标系名称，通常为 `map`         |
| `resolution`     | `number` | 是   | 地图分辨率                       |
| `origin`         | `object` | 是   | 世界坐标原点，含 `x`、`y`、`yaw` |
| `occupiedThresh` | `number` | 否   | ROS 栅格占用阈值                 |
| `freeThresh`     | `number` | 否   | ROS 栅格空闲阈值                 |
| `negate`         | `0       | 1`   | 否                               | ROS 地图是否反色 |
| `width`          | `number` | 是   | 地图画布宽度                     |
| `height`         | `number` | 是   | 地图画布高度                     |
| `bounds`         | `object` | 否   | 世界坐标边界                     |
| `defaultView`    | `object` | 否   | 默认视角                         |
| `minZoom`        | `number` | 否   | 最小缩放                         |
| `maxZoom`        | `number` | 否   | 最大缩放                         |

`origin`：

```json
{ "x": 0, "y": 0, "yaw": 0 }
```

`bounds`：

```json
{ "minX": 0, "maxX": 120, "minY": 0, "maxY": 74.4 }
```

`defaultView`：

```json
{ "zoom": 1, "centerX": 60, "centerY": 37.2 }
```

### 6.3 普通图片场景

```json
{
  "sceneId": "warehouse-a",
  "sceneName": "一号仓储区",
  "imageUrl": "/scene-maps/warehouse-a.svg",
  "mapFrame": "map",
  "resolution": 0.12,
  "origin": { "x": 0, "y": 0, "yaw": 0 },
  "width": 1000,
  "height": 620
}
```

`imageUrl` 必须以 `/scene-maps/` 开头，对应文件放在：

```text
config-runtime/scene-maps/warehouse-a.svg
```

### 6.4 Lanelet2 OSM 场景

```json
{
  "sceneId": "kangcheng-airy",
  "sceneName": "康城 Airy 路网",
  "osmUrl": "/scene-maps/kangcheng-airy/kangcheng_airy.osm",
  "mapFrame": "map",
  "resolution": 1,
  "origin": { "x": 0, "y": 0, "yaw": 0 },
  "width": 1200,
  "height": 800
}
```

文件位置：

```text
config-runtime/scene-maps/kangcheng-airy/kangcheng_airy.osm
```

后端会自动：

1. 读取 `.osm`。
2. 解析 Lanelet2 relation。
3. 生成 `bounds` 和 `lanelets`。
4. 把 `overlayUrl` 设置为 `/api/scenes/{sceneId}/overlay`。

新项目推荐直接使用 `osmUrl`，不需要手工生成 `lanelet-overlay.json`。

### 6.5 点云场景

```json
{
  "sceneId": "cloudpoint-demo",
  "sceneName": "CloudPoint 点云地图示例",
  "pointCloudUrl": "/scene-maps/cloudpoint-demo/zhuangyi.pcd",
  "pointCloudMetaUrl": "/scene-maps/cloudpoint-demo/zhuangyi_indoor_map.json",
  "pointCloudMode": "topdown",
  "mapFrame": "map",
  "resolution": 0.2,
  "origin": { "x": -106.62, "y": -59.16, "yaw": 0 },
  "width": 602,
  "height": 654
}
```

字段：

- `pointCloudUrl`：PCD 文件路径。
- `pointCloudMetaUrl`：点云元数据路径。
- `pointCloudMode`：当前推荐 `topdown`。

### 6.6 从 CloudPoint 离线成果导入栅格场景

CloudPoint 产出的是一张占据栅格图 + 它自己格式的元数据。
`deploy/tools/import-cloudpoint-map.py` 负责把图拷进 `scene-maps/`，并按本章的
schema 生成 `scenes.json` 条目 —— 关键是 `bounds` 必须是**米**为单位的图幅范围
（`origin + 尺寸 × resolution`），前端整个世界坐标系都由它推导。

```bash
# 先看一眼生成的条目
python3 deploy/tools/import-cloudpoint-map.py \
    --scene-id plant-b --scene-name "B 厂区" \
    --source-dir ~/cloudpoint/out/plant-b

# 确认无误后直接写入场景注册表（同 sceneId 会被替换）
python3 deploy/tools/import-cloudpoint-map.py \
    --scene-id plant-b --scene-name "B 厂区" \
    --source-dir ~/cloudpoint/out/plant-b \
    --write-scenes config-runtime/scenes.json
```

`--variant full` 取未裁剪的整幅地图；`--min-zoom` / `--max-zoom` / `--default-zoom`
覆盖缩放默认值。写入后无需重启：后端监听 `scenes.json` 并热加载。

Lanelet2 路网**不要**用这个脚本 —— 直接配 `osmUrl`（见 6.4）。脚本的 `--overlay`
只为兼容早期流水线预生成的 overlay JSON 而保留。

## 7. `scene-maps/` 资源目录

支持文件：

- `.svg`
- `.png`
- `.jpg`
- `.json`
- `.pcd`
- `.osm`

推荐组织：

```text
scene-maps/
├─ warehouse-a.svg
├─ yard-north.svg
├─ kangcheng-airy/
│  └─ kangcheng_airy.osm
└─ cloudpoint-demo/
   ├─ zhuangyi.pcd
   └─ zhuangyi_indoor_map.json
```

浏览器访问路径统一是：

```text
/scene-maps/**
```

## 8. 环境变量

### 8.1 部署入口变量

| 变量                       | 默认值              | 说明                               |
| -------------------------- | ------------------- | ---------------------------------- |
| `HTTP_HOST_PORT`           | `8080`              | Nginx 映射到宿主机的 HTTP 端口     |
| `MQTT_HOST_PORT`           | `1883`              | Mosquitto 映射到宿主机的 MQTT 端口 |
| `CONFIG_RUNTIME_HOST_PATH` | `../config-runtime` | 宿主机运行期配置目录               |

### 8.2 后端变量

| 变量                          | 默认值                                                              | 说明                                                  |
| ----------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `PORT`                        | `3000`                                                              | 后端容器监听端口                                      |
| `NODE_ENV`                    | `production`（compose）                                             | 运行环境；`production` 下缺少 `JWT_SECRET` 会启动失败 |
| `FLEET_NAME`                  | `智能车队`                                                          | 内置兜底车队名，通常会被 `fleet.json` 覆盖            |
| `MQTT_URL`                    | `mqtt://mosquitto:1883`                                             | 后端连接的 MQTT Broker                                |
| `MQTT_USERNAME`               | 空                                                                  | MQTT 用户名                                           |
| `MQTT_PASSWORD`               | 空                                                                  | MQTT 密码                                             |
| `MQTT_CLIENT_ID`              | 随机                                                                | 可选固定客户端 ID                                     |
| `MQTT_TOPIC_PATTERN`          | `/fleet/{deviceId}/vehicle_info`                                    | 遥测主题模板，`{deviceId}` 为占位符                   |
| `MONGO_URI`                   | `mongodb://root:example@mongo:27017/fleet_monitor?authSource=admin` | MongoDB 连接串                                        |
| `MONGO_DB_NAME`               | `fleet_monitor`                                                     | MongoDB 数据库名                                      |
| `SEED_FILE`                   | 空                                                                  | 可选种子数据文件                                      |
| `OFFLINE_AFTER_SECONDS`       | `60`                                                                | 设备离线判定秒数                                      |
| `TELEMETRY_RETENTION_SECONDS` | `2592000`                                                           | 遥测保留秒数，默认 30 天                              |
| `ALERTS_RETENTION_SECONDS`    | `15552000`                                                          | 告警保留秒数，默认 180 天                             |
| `MAX_HISTORY_POINTS`          | `500`                                                               | 单次历史查询最大返回点数                              |
| `MONGO_BUFFER_LIMIT`          | `2000`                                                              | Mongo 写失败时内存缓冲上限                            |
| `CONFIG_ROOT_PATH`            | `/runtime-config`                                                   | 容器内配置根目录                                      |
| `CONFIG_WATCH_USE_POLLING`    | `false`                                                             | 是否用轮询监听配置                                    |
| `CONFIG_WATCH_DEBOUNCE_MS`    | `1000`                                                              | 配置热加载防抖毫秒数                                  |

### 8.2.1 鉴权与安全变量

| 变量                   | 默认值                 | 说明                                                                                                                                       |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_ENABLED`         | `true`                 | 是否启用登录与 RBAC；仅本地实验可关闭                                                                                                      |
| `JWT_SECRET`           | 空                     | **生产必填**：JWT 签名密钥。留空使用进程内临时密钥（重启失效所有会话）；`NODE_ENV=production` 下留空会启动失败                             |
| `JWT_ACCESS_TTL`       | `15m`                  | access token 有效期                                                                                                                        |
| `JWT_REFRESH_TTL`      | `7d`                   | refresh token 有效期                                                                                                                       |
| `BCRYPT_ROUNDS`        | `10`                   | 密码哈希强度                                                                                                                               |
| `ADMIN_USERNAME`       | `admin`                | 初始管理员用户名                                                                                                                           |
| `ADMIN_PASSWORD`       | 空                     | **生产必填**：留空时开发环境创建 `admin/admin123` 并告警，生产环境拒绝创建默认管理员                                                       |
| `COOKIE_SECURE`        | `false`                | HTTPS 部署时设为 `true`，使鉴权 Cookie 带 Secure 标记。用 `docker-compose.tls.yml` 叠加文件时该值被硬编码为 `true`                         |
| `CORS_ORIGINS`         | 空（同源部署无需设置） | 允许的跨域来源，逗号分隔                                                                                                                   |
| `DEBUG_INGEST_ENABLED` | `false`                | 调试注入端点开关；开启后仍需 admin 角色。`NODE_ENV=production` 下开启会**拒绝启动**                                                        |
| `TRUST_PROXY`          | `0`（compose 为 `1`）  | 允许设置 `X-Forwarded-For` 的反代跳数。0 = 忽略该头（直连暴露时的安全默认）；留 0 而实际有 nginx 时，限流会把全部请求算到 nginx 一个地址上 |
| `RATE_LIMIT_WINDOW_MS` | `60000`                | `/api` 粗粒度限流窗口                                                                                                                      |
| `RATE_LIMIT_MAX`       | `600`                  | 窗口内每 IP 的 `/api` 请求上限；超限返回 `429 {"error":"too_many_requests"}`。登录路由另有 15 分钟 50 次的限制                             |

### 8.2.2 可观测性变量

| 变量              | 默认值 | 说明                                                             |
| ----------------- | ------ | ---------------------------------------------------------------- |
| `LOG_LEVEL`       | `info` | pino 日志级别：trace/debug/info/warn/error/fatal                 |
| `METRICS_ENABLED` | `true` | 是否暴露 `GET /metrics`（Prometheus 文本，未鉴权，仅供内网抓取） |

### 8.3 Mongo 变量

| 变量                         | 默认值    | 说明                   |
| ---------------------------- | --------- | ---------------------- |
| `MONGO_INITDB_ROOT_USERNAME` | `root`    | Mongo 初始化管理员用户 |
| `MONGO_INITDB_ROOT_PASSWORD` | `example` | Mongo 初始化管理员密码 |

### 8.4 前端构建变量

| 变量                         | 说明               |
| ---------------------------- | ------------------ |
| `VITE_AMAP_KEY`              | 高德地图浏览器 Key |
| `VITE_AMAP_SECURITY_JS_CODE` | 高德地图安全密钥   |

这两个变量是前端构建时变量，修改后必须重新构建前端镜像。

## 9. MQTT payload

### 9.1 主题

遥测：

```text
/fleet/{deviceId}/vehicle_info
```

在线状态：

```text
/fleet/{deviceId}/status
```

后端实际订阅：

```text
/fleet/+/vehicle_info
/fleet/+/status
```

### 9.2 遥测 payload

```json
{
  "stamp": 1712472000000,
  "scene_id": "kangcheng-airy",
  "fusion_loc": { "x": 18.6, "y": 63.1, "yaw": 0.42 },
  "lidar_loc": { "x": 18.2, "y": 62.8, "yaw": 0.39 },
  "vehicle_info": {
    "control_mode": 1,
    "gear": 1,
    "speed": 2.32,
    "omega": 0.11,
    "soc": 78.4
  },
  "task_status": 1,
  "platform_task_status": 2,
  "info_code": { "code": 0, "info": "", "stamp": 1712472000000 },
  "warning_code": { "code": 0, "info": "", "stamp": 1712472000000 },
  "error_code": { "code": 0, "info": "", "stamp": 1712472000000 },
  "speed_limit": {
    "limit": 2.5,
    "slowdown_time": 0,
    "stamp": 1712472000000,
    "module_name": "planner"
  },
  "gps": {
    "lat": 31.2316,
    "lng": 121.4722,
    "heading": 72
  }
}
```

支持 camelCase 字段，例如 `fusionLoc`、`vehicleInfo`、`sceneId`。

### 9.3 状态 payload

```json
{ "online": true, "ts": 1712472000000 }
```

也支持：

- `online`
- `offline`
- `true`
- `false`
- `1`
- `0`

## 10. 配置修改示例

### 10.1 新增车辆

在 `vehicles.json` 中加入：

```json
{
  "deviceId": "agv-x01",
  "deviceName": "X01 巡检车",
  "defaultSceneId": "kangcheng-airy",
  "mapProfile": "lanelet",
  "gpsEnabled": true,
  "rosMapEnabled": true,
  "tags": ["巡检"]
}
```

然后让设备向：

```text
/fleet/agv-x01/vehicle_info
```

发布数据。

### 10.2 新增编队

在 `formations.json` 中加入：

```json
{
  "formationId": "night-shift",
  "formationName": "夜班巡检编队",
  "deviceIds": ["agv-a01", "agv-x01"],
  "sceneId": "kangcheng-airy",
  "description": "夜班固定巡检路线",
  "color": "#7cc8ff"
}
```

### 10.3 新增 OSM 场景

放文件：

```text
config-runtime/scene-maps/kangcheng-airy/kangcheng_airy.osm
```

在 `scenes.json` 中加入：

```json
{
  "sceneId": "kangcheng-airy",
  "sceneName": "工厂 Lanelet 路网",
  "osmUrl": "/scene-maps/kangcheng-airy/kangcheng_airy.osm",
  "mapFrame": "map",
  "resolution": 1,
  "origin": { "x": 0, "y": 0, "yaw": 0 },
  "width": 1200,
  "height": 800,
  "defaultView": { "zoom": 1, "centerX": 60, "centerY": 40 },
  "minZoom": 0.6,
  "maxZoom": 10
}
```

### 10.4 禁用某车 GPS 展示

```json
{
  "deviceId": "agv-d03",
  "gpsEnabled": false
}
```

### 10.5 禁用某车场景地图展示

```json
{
  "deviceId": "agv-d03",
  "rosMapEnabled": false
}
```

## 11. 校验建议

修改配置后检查：

```bash
curl http://127.0.0.1:8080/api/scenes
curl http://127.0.0.1:8080/api/fleet/snapshot
```

查看后端日志：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend
```

如果日志中出现 `Failed to reload backend config registry`，说明新配置没有通过校验，后端仍在使用上一份可用配置。
