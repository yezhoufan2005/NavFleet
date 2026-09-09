# NavFleet 部署说明

本文档说明如何把 NavFleet 作为 Docker 服务部署、更新、验证和维护。配置字段含义见 [config-reference.md](./config-reference.md)。

## 1. 部署目标

默认 Docker Compose 会启动完整闭环：

- `nginx`：统一 Web 入口。
- `web`：前端静态页面，由 `frontend-next/`（v3 控制台）构建。服务名取的是**角色**而不是
  某一版实现，所以换用哪一套控制台只是一行 `dockerfile:`，见 [9.6 前端切换与回滚](#96-前端切换与回滚)。
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
├─ frontend/              # v1.0.0 控制台，回滚用
├─ frontend-next/         # v3 控制台，默认部署的这一套
├─ packages/              # shared / fleet-core，两个前端和后端都要用
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

三个镜像都以**仓库根**为构建上下文（npm workspaces 单一 lockfile），所以 `packages/`
与根 `package.json` / `package-lock.json` 必须一起上传，缺一个 `npm ci` 就会判定
lockfile 不同步而失败。

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

### 3.1 宿主内核：MongoDB 8 与 Linux 6.19–7.0.13 不兼容

**这一条会直接导致 `mongo` 容器起不来，且报错不提 Docker、只提内核。** MongoDB 8.0 及以上
自带的 TCMalloc 与 Linux 内核 6.19 到 7.0.13 冲突，`mongod` 在启动时崩溃并循环重启，日志是：

```text
MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility
with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912
```

先看宿主（或 Docker Desktop 虚拟机）的内核：

```bash
docker info --format '{{.KernelVersion}}'
```

落在 `6.19` ～ `7.0.13` 之间就会中招，**升到 7.0.14 或更高即可**（这是 MongoDB 官方给的解法，
见 8.0 发行说明）。注意 compose 里 `backend` 对 `mongo` 是 `condition: service_healthy`，
所以 mongo 起不来时后端也不会启动 —— 症状是整栈只有 nginx 与前端在跑。

## 4. 首次部署

### 4.1 上传项目

把完整项目上传到服务器，例如：

```text
/opt/navfleet
```

至少需要包含：

- `backend/`
- `frontend/`（回滚用）与 `frontend-next/`（默认部署）
- `packages/`、根 `package.json` 与 `package-lock.json`
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
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build web nginx
```

## 9. Nginx 路由

`deploy/nginx/default.conf` 负责：

- `/` 代理到 `web` 容器（并注入 SPA 安全响应头与高德地图作用域的 CSP）。
- `/api/` 代理到后端（边缘限流 ~30r/s）。
- `/health` 代理到后端存活探针。
- `/openapi.json` 代理到后端 OpenAPI 文档（后端侧已要求登录会话）。
- `/docs` 交互式 API 文档（Swagger UI，同源自带资源、无 CDN；同样要求登录会话）。
- `/ws` 代理到后端 WebSocket。
- `/scene-maps/` 代理到后端静态资源。

两个 nginx 容器（边缘与 `web`）都用 `nginxinc/nginx-unprivileged` 镜像，以 uid 101
运行、容器内监听 8080；宿主机端口仍由 `HTTP_HOST_PORT` 决定，对外不变。

四个安全响应头（`X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` / CSP）
只挂在 `location /` 内部，因为 nginx 的 `add_header` **不跨 location 继承** —— 加新路由时
要连头一起加，不能指望从 server 段继承下来。`web` 镜像自己也设前三个（这样它不挂在边缘
后面时依然正确），边缘用 `proxy_hide_header` 把上游那三个摘掉：否则客户端会各收到两遍，
而两处都不再是唯一权威，之后改其中一处会**看起来生效、实际没有**。`Cache-Control`
故意不摘 —— 镜像对 `/assets/` 发 `immutable`、对入口文档发 `no-store`，这个区分比边缘能
表达的更细。

> **`/metrics` 不再由边缘代理。** 该端点未鉴权，而「只放行内网 IP」在内网部署里是
> 自欺欺人 —— 所有客户端本来就都是内网地址。抓取方应在 compose 网络内直接访问
> `backend:3000/metrics`。
>
> **口径更正（v3 控制台切换后）**：`http://主机:8080/metrics` 现在返回的是 **200 + SPA 的
> index.html**，不再是 404 —— v3 用 web history，任何未知路径都由 `try_files` 兜给
> index.html。抓取端看到的是「解析失败」而不是干净的 404，排查时容易看错方向。判断
> 是否指错的办法是看响应体：是 HTML 就说明请求根本没到后端。

### 9.1 网络分段

compose 不再使用单一默认网络，而是三段：

| 网络   | 成员                | 说明                                   |
| ------ | ------------------- | -------------------------------------- |
| `edge` | nginx、web、backend | 唯一有宿主机端口映射的一段             |
| `data` | backend、mongo      | `internal: true`，mongo 无任何出网能力 |
| `bus`  | backend、mosquitto  | broker 段                              |

backend 是唯一同时在三段上的服务。实测：nginx 与 web **连 `mongo` /
`mosquitto` 的域名都解析不了**，backend 两者都能连通。

`bus` 没有设 `internal: true`：docker 会静默丢弃 internal 网络上的端口映射，而文档
里的本机演示要用 `127.0.0.1:1883`。若现场发布端都是远程车辆，删掉 mosquitto 的
`ports` 段并给 `bus` 加上 `internal: true` 即可。

### 9.2 启用 TLS

TLS 是一个**叠加文件**，不改动基础编排：

```bash
# 1) 准备证书：deploy/nginx/certs/{fullchain.pem,privkey.pem}
#    实验环境可生成自签名（浏览器会告警，仅供本地/内网试跑）：
sh deploy/tools/generate-dev-certs.sh navfleet.local

# 2) 带叠加文件启动
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.tls.yml up -d
```

生效后：

| 项                               | 行为                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `https://主机/`（宿主 443）      | 正常提供服务，HTTP/2                                                                                       |
| `http://主机:${HTTP_HOST_PORT}/` | **308** 重定向到 https（308 而非 301：保留方法与请求体，被重定向的 `POST /api/auth/login` 不会退化成 GET） |
| 会话 Cookie                      | 带 `Secure`（叠加文件把 `COOKIE_SECURE` **硬编码**为 true，不受 `.env` 里的旧值影响）                      |
| HSTS                             | 仅在 TLS 响应上出现（`map $scheme $hsts`），明文 HTTP 上不发送 —— RFC 6797 要求如此                        |
| TLS 版本                         | 只接受 1.2 / 1.3；1.1 及以下被拒（实测返回 `alert protocol version`）                                      |

想要经典的 80 → 443 跳转，把 `.env` 里的 `HTTP_HOST_PORT` 设为 `80`。
HTTPS 宿主端口可用 `HTTPS_HOST_PORT` 覆盖。

路由表只有一份：`deploy/nginx/locations.conf` 被明文入口与 TLS 入口共同 `include`，
所以不会出现「HTTP 加了一条路由、HTTPS 忘了加」这种没人会立刻发现的差异。

> 证书目录 `deploy/nginx/certs/` 已在 `.gitignore` 中：私钥不进仓库。生产请用组织
> CA 或 Let's Encrypt 签发的证书替换自签名文件 —— 自签名只提供加密、不提供身份
> 认证，能中间人劫持的一方同样能拿出一张自签证书。

### 9.3 监控栈（Prometheus + Grafana）

同样是叠加文件，默认不启动：

```bash
# deploy/.env 里先设 GRAFANA_ADMIN_PASSWORD（留空则 compose 拒绝启动）
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.monitoring.yml up -d
```

| 组件       | 地址               | 说明                                                 |
| ---------- | ------------------ | ---------------------------------------------------- |
| Grafana    | `http://主机:3001` | 已预置数据源与「NavFleet 车队监控」面板（14 个面板） |
| Prometheus | `127.0.0.1:9090`   | **仅本机**：查询接口未鉴权                           |

两者与 backend 同处一个 `monitoring` 网段，**够不到 mongo 和 mosquitto**。Prometheus
在网络内抓 `backend:3000/metrics` —— 这正是 9C 里边缘 nginx 不再代理 `/metrics` 的原因。

告警规则在 `deploy/prometheus/alerts.yml`，9 条，全部写在本项目**真实暴露**的指标上：
后端失联、Mongo/MQTT 断开、遥测写入积压、摄入校验持续拒绝、「连着 broker 但十分钟
没消息」、过半车辆离线、5xx 比例 >5%、p95 延迟 >1s。`for:` 都不为零 —— MQTT 与 Mongo
本身带有界退避重连，几秒钟的断开是正常运行而不是该叫人起床的事。

面板与数据源都是 **provisioned**：UI 里改了不会存活（`allowUiUpdates: false`），仓库里的
JSON 是唯一来源，否则新部署拿到的会是一个坏掉的面板。

### 9.4 备份自动化与恢复演练

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.backup.yml up -d
```

`mongo-backup` 容器按 `BACKUP_INTERVAL_SECONDS` 循环 `mongodump`，按
`BACKUP_RETENTION_DAYS` 清理旧档，只删自己命名规则的文件（目录是宿主机挂载，可能有
别的东西）。它只接在 `data` 网段上，既碰不到 Web 层也没有出网能力。

「有备份」和「能恢复」是两件事。`deploy/tools/restore-drill.sh` 只证明后者：

```bash
deploy/tools/restore-drill.sh            # 默认取 deploy/backups 里最新的归档
```

它把归档用 `--nsFrom/--nsTo` 恢复到**临时库** `fleet_monitor_restore_drill`，逐集合对比
文档数，然后把临时库删掉 —— 全程不写生产库。只有「恢复成功且每个集合都非空」才返回 0。

实测输出：

```text
collection            restored     live
users                        1        1
alerts                      22       22
telemetry_ts            987532   987767
device_latest                6        6
DRILL PASSED: 4 collection(s) restored, none empty.
```

`telemetry_ts` 少 235 条是正常的：dump 期间车队还在继续上报。

### 9.5 GHCR 镜像发布

合并 release-please 的 release PR 后，`Release` workflow 会在打完 tag 之后直接调用
`publish-images.yml`，把 `navfleet-backend` 与 `navfleet-console` 推到
`ghcr.io/<owner>/`，标签为 `<x.y.z>`、`<x.y>`、`latest` 与短 sha。

**`navfleet-frontend` 不再发布，停在 1.0.x。** 它装的是 v1.0.0 那套控制台，而 1.1.0 起
部署的是 v3；继续用同一个名字推 1.1.0 会让 registry 里的标签说谎 —— 名字承诺的是这一版
的界面，内容是上一版的。回滚不依赖 registry：回滚 overlay 从源码本地构建（见 9.6）。

**发布前需要在仓库 Settings → Secrets and variables → Actions 配好两个 secret**：

| Secret                       | 作用                                       |
| ---------------------------- | ------------------------------------------ |
| `VITE_AMAP_KEY`              | 高德地图浏览器 Key，**构建期**烘进前端镜像 |
| `VITE_AMAP_SECURITY_JS_CODE` | 与上面配套的安全密钥                       |

这是 Vite 的构建期变量，不是运行期环境变量 —— 镜像构建时没有它，跑起来的前端 GPS 地图
会显示「未配置 Key」提示（其余功能不受影响），且**必须重新构建镜像**才能补上，改容器
环境变量没有用。

需要为某个已有 tag 补发镜像时，手动触发即可：

```bash
gh workflow run publish-images.yml -f tag=v1.0.0
```

> 历史注意：该 workflow 早期用 `on: release: [published]` 触发，而 release-please 是用
> `GITHUB_TOKEN` 创建 Release 的 —— GitHub 的防循环规则不允许 `GITHUB_TOKEN` 产生的事件
> 触发其他 workflow，所以 v0.2.0 / v0.3.0 / v1.0.0 三个版本都没有自动产出镜像。现在改为
> 由 release job 直接 `workflow_call` 调用，不再依赖那条永远不会触发的链路。

### 9.6 前端切换与回滚

`web` 服务的名字取的是**角色**（被服务的那套 SPA），不是某一版实现。默认构建
`frontend-next/Dockerfile`，也就是 v3 控制台。回滚到 v1.0.0 那套是加一个 overlay：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  -f deploy/docker-compose.legacy-frontend.yml up -d --build web
```

切回去把 `-f deploy/docker-compose.legacy-frontend.yml` 去掉再跑一遍即可。overlay 只覆盖
`dockerfile` 一行，构建上下文、高德 ARG、网络、健康检查、资源上限全部从基础文件继承，
**服务名不变**，所以 nginx 与 `depends_on` 都不用动 —— 这也是它必须共用一个服务名的原因：
overlay 只能新增、不能删掉 `depends_on` 里的条目，另起一个服务会把两套镜像一起拉起来。

回滚后有两件事会变，都是旧控制台本来的性质，不是故障：

- **URL 回到 hash 路由**（`/#/`），从 v3 复制出去的深链接解析不了。边缘对未知路径的兜底
  也随之消失：`/devices/agv-a01` 这类路径在 v3 下是 200，回滚后是 404。
- **两套共用的四个 localStorage 键会带过去**（`navfleet:theme`、`:map-mode`、
  `:acked-alerts`、`:ros-scene-views`）—— 同一个 origin、同一个操作员、同一套选择，这是
  刻意的。v3 独有的那几个（侧栏、设备页版式、四个告警声音键）只是不被读，切回去还在。

两个方向都在本机实测过：切到 v3 时 `/` 出 Reka UI 的 chunk、深链接 200；回滚后 `/` 出旧
产物、深链接 404；两个方向的四个安全响应头都各只出现一次。

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

### 无人值守大屏没有告警提示音

浏览器不允许一个**没有被交互过的文档**播放声音，这是自动播放策略，页面里绕不过去。
日常使用不受影响：控制台记住了「这台浏览器启用过声音」，之后任意一次点击或按键都会静默恢复，
所以坐在机器前的人第一次点任何东西时它就已经就绪了。

**真正会失效的只有一种部署：开机加载页面、之后几小时无人触碰的值班大屏。** 这种场景要在启动
浏览器时关掉该策略，例如 Chrome / Edge：

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required http://<console-host>/
```

不加这个参数时控制台不会假装正常：一旦真有告警级消息在「尚未获得交互」期间到达，
顶栏读数会立刻从「告警响应」变成「告警待就绪」并转为警示色，同时弹出一条可见提示 ——
听不到的告警至少不会同时是看不到的。

### mosquitto 报 `port is already allocated`

compose 把 1883 发布到宿主。同一台机器上如果另有一个 broker 容器占着 1883（例如为了联调临时
起的那种），compose 的 mosquitto 就永远起不来，而**报错只说端口被占，不说被谁占**。查占用者：

```bash
docker ps --format '{{.Names}} {{.Ports}}' | grep 1883
```

如果这台机器上的车辆都从远端连进来、不需要从宿主直连 broker，按第 10 节把 mosquitto 的
`ports` 段删掉即可 —— 容器之间仍走 `bus` 网络互通，不需要宿主端口。

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
