#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ scripts/dev.sh —— 开发脚本（热更新）                                        ║
# ╠══════════════════════════════════════════════════════════════════════════╣
# ║ 起后端 (tsx, :3000) + v3 控制台 (vite, :7070)，两端都热更新，用于日常改前端 ║
# ║ /联调。三个脚本的分工见文件末尾 usage()。                                   ║
# ║                                                                            ║
# ║ 常用：                                                                     ║
# ║   scripts/dev.sh            前后端热更新；本机有 1883 broker 时自动跑演示发布器 ║
# ║   scripts/dev.sh --demo     额外起一次性 Mongo 容器并注入演示数据（用户/角色/ ║
# ║                             组 + 报表回填）——验收报表/会话/审计/样式用这个     ║
# ║   scripts/dev.sh --mock     强制跑演示发布器（需本机 1883 broker）           ║
# ║   scripts/dev.sh --no-mock  只起前后端，不发布演示数据                        ║
# ║   scripts/dev.sh --legacy   起 v1.0.0 旧控制台 (:5173) 而非 v3，仅回滚验证用  ║
# ║   scripts/dev.sh -h         打印用法                                        ║
# ║   Ctrl+C 停止前后端（--demo 的 Mongo 容器保留，命令见收尾横幅）             ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/health"
ADMIN_USER="admin"
ADMIN_PASS="admin123"
DEV_MONGO_CONTAINER="navfleet-dev-mongo"
DEV_MONGO_URI=""

# 默认起的是 compose 实际部署的那一套（v3 控制台）。此前这里是旧前端 —— 切换之后
# 再默认起它，等于让每个照文档跑 dev 的人开发在一个已经退役的界面上。
FRONTEND_WORKSPACE="frontend-next"
FRONTEND_LABEL="v3 控制台"
FRONTEND_URL="http://127.0.0.1:7070"

usage() { sed -n '/^# ╔/,/^# ╚/p' "$0" | sed 's/^# \{0,1\}//'; }

MOCK_MODE="auto" # auto | force | off
DEMO_MODE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock) MOCK_MODE="force"; shift ;;
    --no-mock) MOCK_MODE="off"; shift ;;
    --demo) DEMO_MODE=1; shift ;;
    --legacy)
      FRONTEND_WORKSPACE="frontend"
      FRONTEND_LABEL="v1.0.0 旧控制台（已冻结，仅回滚用）"
      FRONTEND_URL="http://127.0.0.1:5173"
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1（-h 看用法）"; exit 1 ;;
  esac
done

PIDS=()
cleanup() {
  echo; echo "正在停止前后端…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  exit 0
}
trap cleanup INT TERM

ensure_deps() {
  if [[ ! -d "$ROOT/$1/node_modules" ]]; then
    echo "首次运行，安装 $1 依赖…"
    (cd "$ROOT/$1" && npm install)
  fi
}

broker_up() { command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 1883 2>/dev/null; }

# The bundled broker refuses anonymous clients, so a dev stack pointed at it
# needs the same credentials compose uses. Read only the MQTT_* keys out of
# deploy/.env: sourcing that file would drag NODE_ENV=production, the Mongo URI
# and COOKIE_SECURE into a development process. An already-exported value wins,
# and an external broker without auth simply leaves these empty.
DEPLOY_ENV="$ROOT/deploy/.env"
deploy_var() {
  [[ -f "$DEPLOY_ENV" ]] || return 0
  sed -n "s/^$1=//p" "$DEPLOY_ENV" | tail -1
}
MQTT_SUBSCRIBER_USER="${MQTT_USERNAME:-$(deploy_var MQTT_SUBSCRIBER_USERNAME)}"
MQTT_SUBSCRIBER_PASS="${MQTT_PASSWORD:-$(deploy_var MQTT_SUBSCRIBER_PASSWORD)}"
MQTT_PUBLISHER_USER="${MQTT_PUBLISHER_USERNAME:-$(deploy_var MQTT_PUBLISHER_USERNAME)}"
MQTT_PUBLISHER_PASS="${MQTT_PUBLISHER_PASSWORD:-$(deploy_var MQTT_PUBLISHER_PASSWORD)}"

# --demo：报表 / 会话 / 审计都靠 Mongo 聚合与落库，而默认 dev 后端是内存态（无 Mongo），
# 所以这里起一个**一次性 Mongo 容器**（只绑 127.0.0.1:27017）供 host 上的 tsx 后端连。
# 前后端仍走 tsx/vite 热更新 —— 唯一的容器就是这台 Mongo。容器在 Ctrl+C 后保留，复跑
# --demo 会复用它（数据留存）；要清空重来：docker rm -f navfleet-dev-mongo。
ensure_dev_mongo() {
  command -v docker >/dev/null 2>&1 || { echo "✗ --demo 需要 docker"; exit 1; }
  docker info >/dev/null 2>&1 || { echo "✗ Docker 没在跑"; exit 1; }
  local u p running
  u="$(deploy_var MONGO_INITDB_ROOT_USERNAME)"; u="${u:-root}"
  p="$(deploy_var MONGO_INITDB_ROOT_PASSWORD)"; p="${p:-navfleet-dev}"
  running="$(docker inspect -f '{{.State.Running}}' "$DEV_MONGO_CONTAINER" 2>/dev/null || true)"
  if [[ "$running" == "true" ]]; then
    echo "复用已在运行的 Mongo 容器 $DEV_MONGO_CONTAINER"
  elif docker inspect "$DEV_MONGO_CONTAINER" >/dev/null 2>&1; then
    echo "启动已存在的 Mongo 容器 $DEV_MONGO_CONTAINER…"
    docker start "$DEV_MONGO_CONTAINER" >/dev/null
  else
    echo "起一次性 Mongo 容器 $DEV_MONGO_CONTAINER (127.0.0.1:27017)…"
    docker run -d --name "$DEV_MONGO_CONTAINER" -p 127.0.0.1:27017:27017 \
      -e MONGO_INITDB_ROOT_USERNAME="$u" -e MONGO_INITDB_ROOT_PASSWORD="$p" \
      mongo:7.0 >/dev/null
  fi
  DEV_MONGO_URI="mongodb://${u}:${p}@127.0.0.1:27017/fleet_monitor?authSource=admin"
  echo -n "等待 Mongo 就绪"
  for _ in $(seq 1 60); do
    if docker exec "$DEV_MONGO_CONTAINER" mongosh --quiet -u "$u" -p "$p" \
        --authenticationDatabase admin --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; then
      break
    fi
    echo -n "."; sleep 0.5
  done
  echo " ok"
}

ensure_deps backend
ensure_deps "$FRONTEND_WORKSPACE"
[[ "$DEMO_MODE" == "1" ]] && ensure_dev_mongo
# APPEND_MARKER

# 高德 Key 是 Vite 的构建期变量，且**按 workspace 各自一份**。少了它 GPS 面板会显示
# 「未配置 Key」而其余功能正常 —— 这个提示曾被当成前端缺陷报上来一次，所以这里明说。
if [[ ! -f "$ROOT/$FRONTEND_WORKSPACE/.env" ]]; then
  echo "ℹ 未找到 $FRONTEND_WORKSPACE/.env —— GPS 面板会显示「未配置 Key」，其余功能不受影响。"
  echo "  需要地图时在该文件里写 VITE_AMAP_KEY 与 VITE_AMAP_SECURITY_JS_CODE（两个 workspace 各自一份）。"
fi

echo "启动后端 (:${BACKEND_PORT})…"
(
  cd "$ROOT/backend"
  export PORT="$BACKEND_PORT" \
    NODE_ENV="development" \
    CONFIG_ROOT_PATH="../config-runtime" \
    JWT_SECRET="${JWT_SECRET:-navfleet-dev-secret}" \
    ADMIN_USERNAME="$ADMIN_USER" \
    ADMIN_PASSWORD="$ADMIN_PASS" \
    DEBUG_INGEST_ENABLED="true" \
    MQTT_USERNAME="$MQTT_SUBSCRIBER_USER" \
    MQTT_PASSWORD="$MQTT_SUBSCRIBER_PASS"
  # --demo 才接 Mongo（内存态下报表/会话/审计无法落库聚合）；否则留空走内存回退。
  [[ "$DEMO_MODE" == "1" ]] && export MONGO_URI="$DEV_MONGO_URI"
  # 回填脚本几秒内会打上千次 debug/ingest；默认 600/min 的每 IP 限流会把大半打成 429，
  # 所以 --demo 的本机 dev 后端放宽限流（仅开发用，不影响生产 .env 的真实限流值）。
  [[ "$DEMO_MODE" == "1" ]] && export RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=100000
  npm run dev
) &
PIDS+=($!)

echo "启动前端 —— ${FRONTEND_LABEL} (${FRONTEND_URL})…"
(cd "$ROOT/$FRONTEND_WORKSPACE" && npm run dev) &
PIDS+=($!)

# 等待后端健康检查通过（最多 ~30s）
echo -n "等待后端就绪"
for _ in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 0.5
done
echo " ok"

# --demo：后端起来后注入演示数据。seed:demo 走 admin API（用户/角色/组 + 会话/锁定/审计），
# seed:reports 走 debug/ingest 回填多日历史（报表页才有可聚合的数据）。两者都幂等/可重复。
if [[ "$DEMO_MODE" == "1" ]]; then
  echo "注入演示数据：用户/角色/组 + 会话/审计…"
  (cd "$ROOT/backend" && SEED_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" \
    ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASS" \
    npm run seed:demo) || echo "⚠ seed:demo 失败（可稍后手动重试）"
  echo "回填报表演示数据（多日遥测/告警历史）…"
  (cd "$ROOT/backend" && SEED_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" \
    ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASS" \
    CONFIG_ROOT_PATH="../config-runtime" npm run seed:reports) || echo "⚠ seed:reports 失败"
fi

# 演示发布器：走真实 MQTT 链路（发布器读 config-runtime 的车队定义）。与 --demo 正交：
# --demo 给静态历史，broker + 发布器给实时跳动。
if [[ "$MOCK_MODE" != "off" ]]; then
  if broker_up; then
    echo "检测到 MQTT broker，启动演示发布器…"
    (
      cd "$ROOT/backend"
      MQTT_PUBLISHER_USERNAME="$MQTT_PUBLISHER_USER" \
      MQTT_PUBLISHER_PASSWORD="$MQTT_PUBLISHER_PASS" \
      npm run mock:mqtt -- --interval 1000
    ) &
    PIDS+=($!)
  elif [[ "$MOCK_MODE" == "force" ]]; then
    echo "⚠ 未检测到 127.0.0.1:1883 的 MQTT broker，无法发布实时演示数据。"
    echo "  可先启动 broker：docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d mosquitto"
  else
    echo "ℹ 未检测到本机 MQTT broker，跳过实时发布器（--demo 的静态历史不受影响）。"
  fi
fi

echo
echo "─────────────────────────────────────────────"
echo "  前端:   ${FRONTEND_URL}  (${FRONTEND_LABEL})"
echo "  后端:   http://127.0.0.1:${BACKEND_PORT}"
echo "  账号:   ${ADMIN_USER} / ${ADMIN_PASS}"
if [[ "$DEMO_MODE" == "1" ]]; then
  echo "  演示:   已注入用户/角色/组 + 多日报表历史（Mongo 容器 ${DEV_MONGO_CONTAINER}）"
  echo "  清库:   docker rm -f ${DEV_MONGO_CONTAINER}"
fi
echo "  停止:   Ctrl+C（--demo 的 Mongo 容器会保留）"
echo "─────────────────────────────────────────────"
wait

