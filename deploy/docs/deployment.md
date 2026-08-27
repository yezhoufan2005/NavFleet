# NavFleet 部署说明

本文档说明如何把 NavFleet 作为 Docker 服务部署、更新、验证和维护。配置字段含义见 [config-reference.md](./config-reference.md)。

## 1. 部署目标

默认 Docker Compose 会启动完整闭环：

- `nginx`：统一 Web 入口。
- `frontend`：前端静态页面。
- `backend`：后端 API、WebSocket、MQTT 客户端和配置热加载。
- `mongo`：历史遥测、最新快照、告警存储。
- `mosquitto`：MQTT Broker。

默认访问：

```text
Web:  http://127.0.0.1:8080
MQTT: mqtt://127.0.0.1:1883   # 仅宿主机本机可达，且需要凭据
```

## 2. 推荐目录结构

服务器上推荐放在：

```text
/opt/navfleet/
├─ backend/
├─ frontend/
├─ config-runtime/
│  ├─ fleet.json
│  ├─ vehicles.json
│  ├─ formations.json
│  ├─ scenes.json
│  └─ scene-maps/
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ .env
│  ├─ nginx/default.conf
│  └─ mosquitto/mosquitto.conf
└─ README.md
```

`config-runtime/` 是运行期配置目录。后端容器会把它挂载为 `/runtime-config`。

## 3. 环境要求

服务器需要安装：

- Docker Engine
- Docker Compose v2

检查：

```bash
docker version
docker compose version
```

## 4. 首次部署

### 4.1 上传项目

把完整项目上传到服务器，例如：

```text
/opt/navfleet
```

至少需要包含：

- `backend/`
- `frontend/`
- `config-runtime/`
- `deploy/`
- 根目录 `README.md`、`ARCHITECTURE.md`

### 4.2 准备环境变量

```bash
cd /opt/navfleet
cp deploy/.env.example deploy/.env
```

根据现场情况编辑：

```bash
nano deploy/.env
```

默认最小可运行配置（口令为占位符，**部署前务必改**，勿沿用示例值）：

```env
HTTP_HOST_PORT=8080
MQTT_HOST_PORT=1883
MQTT_URL=mqtt://mosquitto:1883
CONFIG_ROOT_PATH=/runtime-config
CONFIG_RUNTIME_HOST_PATH=../config-runtime
MONGO_INITDB_ROOT_USERNAME=root
MONGO_INITDB_ROOT_PASSWORD=change-me-in-production
MONGO_URI=mongodb://root:change-me-in-production@mongo:27017/fleet_monitor?authSource=admin
MONGO_DB_NAME=fleet_monitor
```

生产环境必须修改：

```env
# 数据库口令
MONGO_INITDB_ROOT_PASSWORD=更强的密码
MONGO_URI=mongodb://root:更强的密码@mongo:27017/fleet_monitor?authSource=admin

# 鉴权（缺失将导致：JWT_SECRET 空→会话每次重启失效且生产启动失败；
#        ADMIN_PASSWORD 空→生产拒绝创建默认管理员）
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=一个强口令

# 经 HTTPS 提供服务时
COOKIE_SECURE=true
```

### 4.2.1 Broker 凭据（必填，否则 compose 拒绝启动）

Mosquitto 已关闭匿名访问，所以这四个变量**没有默认值**：留空时 `docker compose up`
会直接报错退出，而不是起一个谁都能连的 broker。

```env
MQTT_SUBSCRIBER_USERNAME=navfleet-backend
MQTT_SUBSCRIBER_PASSWORD=$(openssl rand -hex 16)
MQTT_PUBLISHER_USERNAME=navfleet-publisher
MQTT_PUBLISHER_PASSWORD=$(openssl rand -hex 16)
```

两个账号权限是分开的：订阅方（后端）对 `/fleet/#` **只读**，发布方（车辆或演示脚本）
**只写**。任一凭据泄露都做不了对方的事 —— 后端凭据无法伪造遥测，车辆凭据无法读取
整个车队。密码文件与 ACL 由容器启动脚本用 `mosquitto_passwd` 现场生成写入
`mosquitto-auth` 卷，不落仓库；改密码后重启即完成轮换。

> 后端读取的仍是 `MQTT_USERNAME` / `MQTT_PASSWORD`，compose 会把
> `MQTT_SUBSCRIBER_*` 映射过去，无需重复填写。

> `NODE_ENV=production`（compose 默认）下，后端在 `AUTH_ENABLED=true` 且 `JWT_SECRET` 为空时会**拒绝启动**；`ADMIN_PASSWORD` 为空时会跳过管理员种子并记录错误日志。务必在首次启动前设置二者。
> 同样在生产下，`DEBUG_INGEST_ENABLED=true` 或 `CORS_ORIGINS` 含 `*` 会**拒绝启动**；`COOKIE_SECURE=false`、`AUTH_ENABLED=false` 只告警。

如果需要 80 端口：

```env
HTTP_HOST_PORT=80
```

如果使用外部 MQTT Broker，把 `MQTT_URL` 改为现场地址：

```env
MQTT_URL=mqtt://10.0.0.10:1883
MQTT_SUBSCRIBER_USERNAME=现场用户名
MQTT_SUBSCRIBER_PASSWORD=现场密码
```

这时内置 Mosquitto 仍会启动，但后端会连接外部 Broker。

### 4.3 启动

```bash
cd /opt/navfleet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

查看状态：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

查看日志：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f nginx
```

## 5. 验证

### 5.1 HTTP 接口

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/scenes
curl http://127.0.0.1:8080/api/fleet/snapshot
```

如果使用 80 端口：

```bash
curl http://127.0.0.1/health
```

### 5.2 MQTT 接入

如果本机安装了 `mosquitto-clients`：

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -t /fleet/agv-a01/status -m '{"online":true}'
```

也可以运行项目自带 mock：

```bash
cd /opt/navfleet/backend
npm install
npm run mock:mqtt -- --broker mqtt://127.0.0.1:1883 --device-prefix agv --count 4
```

然后打开：

```text
http://服务器IP:8080
```

页面应出现模拟车辆。

### 5.3 OSM overlay

当前示例场景：

```bash
curl http://127.0.0.1:8080/api/scenes/kangcheng-airy/overlay
```

能返回 `lanelets` 数据说明 OSM 解析正常。

## 6. 更新

### 6.1 只更新配置或地图

直接修改：

```text
config-runtime/fleet.json
config-runtime/vehicles.json
config-runtime/formations.json
config-runtime/scenes.json
config-runtime/scene-maps/**
```

生效规则：

- JSON 配置：后端自动热加载。
- `.osm`：后端自动重新解析。
- 图片、点云、普通 JSON 元数据：刷新浏览器即可。

不需要执行 `docker compose up --build`。

### 6.2 更新代码

修改前端、后端、Dockerfile 或 Nginx 配置后执行：

```bash
cd /opt/navfleet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

### 6.3 停止服务

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down
```

如果需要连 MongoDB 和 Mosquitto 数据卷一起删除：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v
```

## 7. 运行期配置目录初始化

如果服务器使用独立配置目录，可以用脚本从项目默认配置初始化：

```bash
cd /opt/navfleet
sh deploy/tools/init-runtime-assets.sh /opt/navfleet/config-runtime
```

脚本会创建：

- `fleet.json`
- `vehicles.json`
- `formations.json`
- `scenes.json`
- `scene-maps/`

如果目标文件已存在，脚本不会覆盖 JSON 配置；地图资源会按缺失文件补齐。

## 8. 高德地图配置

GPS 地图需要高德地图浏览器 Key。编辑 `deploy/.env`：

```env
VITE_AMAP_KEY=你的Key
VITE_AMAP_SECURITY_JS_CODE=你的安全密钥
```

前端构建时会把这两个值写入静态资源，所以修改后需要重新构建：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build frontend nginx
```

## 9. Nginx 路由

`deploy/nginx/default.conf` 负责：

- `/` 代理到前端容器（并注入 SPA 安全响应头与高德地图作用域的 CSP）。
- `/api/` 代理到后端（边缘限流 ~30r/s）。
- `/health` 代理到后端存活探针。
- `/openapi.json` 代理到后端 OpenAPI 文档（后端侧已要求登录会话）。
- `/ws` 代理到后端 WebSocket。
- `/scene-maps/` 代理到后端静态资源。

两个 nginx 容器（边缘与前端）都用 `nginxinc/nginx-unprivileged` 镜像，以 uid 101
运行、容器内监听 8080；宿主机端口仍由 `HTTP_HOST_PORT` 决定，对外不变。

> **`/metrics` 不再由边缘代理。** 该端点未鉴权，而「只放行内网 IP」在内网部署里是
> 自欺欺人 —— 所有客户端本来就都是内网地址。抓取方应在 compose 网络内直接访问
> `backend:3000/metrics`。若原先在用 `http://主机:8080/metrics`，升级后会返回 404。

### 9.1 网络分段

compose 不再使用单一默认网络，而是三段：

| 网络   | 成员                     | 说明                                   |
| ------ | ------------------------ | -------------------------------------- |
| `edge` | nginx、frontend、backend | 唯一有宿主机端口映射的一段             |
| `data` | backend、mongo           | `internal: true`，mongo 无任何出网能力 |
| `bus`  | backend、mosquitto       | broker 段                              |

backend 是唯一同时在三段上的服务。实测：nginx 与 frontend **连 `mongo` /
`mosquitto` 的域名都解析不了**，backend 两者都能连通。

`bus` 没有设 `internal: true`：docker 会静默丢弃 internal 网络上的端口映射，而文档
里的本机演示要用 `127.0.0.1:1883`。若现场发布端都是远程车辆，删掉 mosquitto 的
`ports` 段并给 `bus` 加上 `internal: true` 即可。

## 10. MQTT 部署策略

### 使用内置 Mosquitto

默认：

```env
MQTT_URL=mqtt://mosquitto:1883
MQTT_HOST_PORT=1883
```

**broker 已关闭匿名访问**，凭据见 [4.2.1](#421-broker-凭据必填否则-compose-拒绝启动)。
端口只绑定在宿主机 `127.0.0.1`（此前是 `0.0.0.0`），所以局域网内的设备**不能**直接
用 `mqtt://服务器IP:1883` 接入；需要现场车辆直连时，把 mosquitto 的 `ports` 改回
`"${MQTT_HOST_PORT}:1883"`，并为车辆单独发一套发布凭据。

设备接入（改回全网段绑定后）：

```text
mqtt://服务器IP:1883   # 用户名/口令 = MQTT_PUBLISHER_*
```

### 使用外部 Broker

把后端连接改成外部地址：

```env
MQTT_URL=mqtt://外部BrokerIP:1883
MQTT_SUBSCRIBER_USERNAME=用户名
MQTT_SUBSCRIBER_PASSWORD=密码
```

内置 Mosquitto 仍会启动（compose 仍会校验它自己的四个凭据变量）。彻底不需要时，把
`mosquitto` 服务从 compose 中移除，或用 `docker compose up -d --scale mosquitto=0`。

## 11. 常见问题

### 页面打开但没有车辆

这是正常空状态。车辆不会由 `vehicles.json` 自动生成，必须有 MQTT 数据、调试注入或 MongoDB 恢复数据。

### 修改车辆名称后页面没变

检查后端日志是否有配置重载记录：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend
```

如果配置 JSON 写坏，后端会保留上一份可用配置并在日志中输出错误。

### 修改 OSM 后页面没变

后端会重新解析，但浏览器不会自动重新拉取 overlay。保存 `.osm` 后刷新页面。

### 宿主机 1883 被占用

修改 `deploy/.env`：

```env
MQTT_HOST_PORT=1884
```

然后重启：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

设备改连：

```text
mqtt://服务器IP:1884
```

### 宿主机 8080 被占用

修改：

```env
HTTP_HOST_PORT=8081
```

然后重启 compose。

### MongoDB 密码改了以后后端连不上

`MONGO_INITDB_ROOT_PASSWORD` 只在 Mongo 数据卷首次初始化时生效。如果已经创建过数据卷，再改密码需要同步更新 Mongo 用户，或清空数据卷重新初始化：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

清空数据卷会删除历史数据。
