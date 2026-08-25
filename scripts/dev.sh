#!/usr/bin/env bash
# NavFleet 本地一键启动脚本
# 启动后端 (:3000) 与前端 (:5173) 开发服务，可选注入演示设备 / 启动 MQTT 模拟。
# 用法:
#   scripts/dev.sh              启动前后端，并注入 3 台演示设备
#   scripts/dev.sh --no-seed    不注入演示数据（空车队）
#   scripts/dev.sh --seed 5     注入 5 台演示设备
#   scripts/dev.sh --mock       用 MQTT 模拟发布器代替演示注入（需本机 1883 broker）
#   Ctrl+C 停止所有子进程
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
FRONTEND_URL="http://127.0.0.1:5173"
HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/health"
ADMIN_USER="admin"
ADMIN_PASS="admin123"

SEED_COUNT=3
USE_MOCK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-seed) SEED_COUNT=0; shift ;;
    --seed) SEED_COUNT="${2:-3}"; shift 2 ;;
    --mock) USE_MOCK=1; SEED_COUNT=0; shift ;;
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

ensure_deps backend
ensure_deps frontend

echo "启动后端 (:${BACKEND_PORT})…"
(
  cd "$ROOT/backend"
  PORT="$BACKEND_PORT" \
  CONFIG_ROOT_PATH="../config-runtime" \
  JWT_SECRET="${JWT_SECRET:-navfleet-dev-secret}" \
  ADMIN_USERNAME="$ADMIN_USER" \
  ADMIN_PASSWORD="$ADMIN_PASS" \
  DEBUG_INGEST_ENABLED="true" \
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

# 可选：注入演示设备，便于立即看到效果（依赖 DEBUG_INGEST_ENABLED）
if [[ "$SEED_COUNT" -gt 0 ]]; then
  echo "注入 ${SEED_COUNT} 台演示设备…"
  COOKIE="$(mktemp)"
  curl -s -c "$COOKIE" -o /dev/null -H "Content-Type: application/json" \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
    "http://127.0.0.1:${BACKEND_PORT}/api/auth/login"
  for i in $(seq 1 "$SEED_COUNT"); do
    soc=$(( 40 + RANDOM % 60 )); lat="31.23$(( RANDOM % 90 ))"; lng="121.47$(( RANDOM % 90 ))"
    curl -s -b "$COOKIE" -o /dev/null -H "Content-Type: application/json" -d "{
      \"deviceId\":\"agv-demo-$i\",\"deviceName\":\"演示车 $i\",\"scene_id\":\"kangcheng-airy\",
      \"vehicle_info\":{\"control_mode\":1,\"gear\":1,\"soc\":$soc,\"speed\":1.8},
      \"fusion_loc\":{\"x\":$((10+i*3)),\"y\":$((12+i*2)),\"yaw\":0.3},
      \"gps\":{\"lat\":$lat,\"lng\":$lng,\"heading\":45},\"task_status\":1
    }" "http://127.0.0.1:${BACKEND_PORT}/api/debug/ingest"
  done
  rm -f "$COOKIE"
fi

# 可选：启动 MQTT 模拟发布器（需本机 broker）
if [[ "$USE_MOCK" -eq 1 ]]; then
  if nc -z 127.0.0.1 1883 2>/dev/null; then
    echo "启动 MQTT 模拟发布器…"
    (cd "$ROOT/backend" && npm run mock:mqtt -- --count 4 --interval 1000) &
    PIDS+=($!)
  else
    echo "⚠ 未检测到 127.0.0.1:1883 的 MQTT broker，跳过模拟发布（可用 docker compose 启动 mosquitto）"
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

