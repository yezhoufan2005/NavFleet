#!/usr/bin/env bash
# NavFleet 本地一键启动脚本
# 启动后端 (:3000) 与前端 (:5173) 开发服务。演示数据不写死在脚本里：如本机有
# MQTT broker，则用 config-runtime 定义的车队跑 mock 发布器（真实链路，仅数据为演示）。
# 用法:
#   scripts/dev.sh            启动前后端；检测到 127.0.0.1:1883 时自动跑演示发布器
#   scripts/dev.sh --mock     强制跑演示发布器（需本机 1883 broker）
#   scripts/dev.sh --no-mock  只启动前后端，不发布演示数据
#   Ctrl+C 停止所有子进程
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
FRONTEND_URL="http://127.0.0.1:5173"
HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/health"
ADMIN_USER="admin"
ADMIN_PASS="admin123"

MOCK_MODE="auto" # auto | force | off
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock) MOCK_MODE="force"; shift ;;
    --no-mock) MOCK_MODE="off"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

PIDS=()
cleanup() {
  echo; echo "正在停止服务…"
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

ensure_deps backend
ensure_deps frontend

echo "启动后端 (:${BACKEND_PORT})…"
(
  cd "$ROOT/backend"
  PORT="$BACKEND_PORT" \
  NODE_ENV="development" \
  CONFIG_ROOT_PATH="../config-runtime" \
  JWT_SECRET="${JWT_SECRET:-navfleet-dev-secret}" \
  ADMIN_USERNAME="$ADMIN_USER" \
  ADMIN_PASSWORD="$ADMIN_PASS" \
  DEBUG_INGEST_ENABLED="true" \
  MQTT_USERNAME="$MQTT_SUBSCRIBER_USER" \
  MQTT_PASSWORD="$MQTT_SUBSCRIBER_PASS" \
  npm run dev
) &
PIDS+=($!)

echo "启动前端 (${FRONTEND_URL})…"
(cd "$ROOT/frontend" && npm run dev) &
PIDS+=($!)

# 等待后端健康检查通过（最多 ~30s）
echo -n "等待后端就绪"
for _ in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 0.5
done
echo " ok"

# 演示数据：走真实 MQTT 链路（发布器读取 config-runtime 的车队定义）。
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
    echo "⚠ 未检测到 127.0.0.1:1883 的 MQTT broker，无法发布演示数据。"
    echo "  可先启动 broker：docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d mosquitto"
  else
    echo "ℹ 未检测到本机 MQTT broker，跳过演示数据；前后端仍可用于登录与联调。"
    echo "  需要演示数据时启动 broker 后加 --mock，或用 docker compose 起完整栈。"
  fi
fi

echo
echo "─────────────────────────────────────────────"
echo "  前端:   ${FRONTEND_URL}"
echo "  后端:   http://127.0.0.1:${BACKEND_PORT}"
echo "  账号:   ${ADMIN_USER} / ${ADMIN_PASS}"
echo "  停止:   Ctrl+C"
echo "─────────────────────────────────────────────"
wait
