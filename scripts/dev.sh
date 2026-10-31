#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ scripts/dev.sh —— 开发脚本（热更新）                                        ║
# ╠══════════════════════════════════════════════════════════════════════════╣
# ║ 起后端 (tsx, :3000) + v3 控制台 (vite, :7070)，两端都热更新，用于日常改前端 ║
# ║ /联调。三个脚本的分工见文件末尾 usage()。                                   ║
# ║                                                                            ║
# ║ 常用：                                                                     ║
# ║   scripts/dev.sh            前后端热更新；本机有 1883 broker 时自动跑演示车队 ║
# ║   scripts/dev.sh --demo     额外起持久 Mongo 容器：演示账号/角色/组，演示车队 ║
# ║                             首次补 7 天历史、之后只补空档——验收报表/回放用这个 ║
# ║   scripts/dev.sh --mock     强制跑演示车队（需本机 1883 broker）             ║
# ║   scripts/dev.sh --no-mock  只起前后端，不发布演示数据                        ║
# ║   scripts/dev.sh --legacy   起 v1.0.0 旧控制台 (:5173) 而非 v3，仅回滚验证用  ║
# ║   scripts/dev.sh -h         打印用法                                        ║
# ║   前后端崩溃（报 npm error 退出）会自动重启，不必手动重跑 dev.sh            ║
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
MAIN_PID=$$
# A sentinel file, not a variable: the supervisor loops run in background subshells that
# forked before cleanup sets it, so they cannot see a parent variable — but they can stat a
# file. cleanup creates it so a loop whose child was just killed exits instead of restarting.
SHUTDOWN_FLAG="$(mktemp -u "${TMPDIR:-/tmp}/navfleet-dev.XXXXXX")"

# Kill a process and everything under it. Killing only the tracked subshell leaves its
# npm → tsx/vite → node grandchildren (and the dev servers on :3000/:7070) orphaned, because a
# parent's death does not signal its children. Depth-first so children die before their parent.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM
  touch "$SHUTDOWN_FLAG" 2>/dev/null || true
  echo; echo "正在停止前后端…"
  for pid in "${PIDS[@]:-}"; do kill_tree "$pid"; done
  wait 2>/dev/null || true
  rm -f "$SHUTDOWN_FLAG"
  exit 0
}
trap cleanup INT TERM

# Keep a dev process alive: run it, and if it exits while we are NOT shutting down, restart it
# after a short pause. tsx watch / vite are long-running watchers — one healthy run never
# returns — so this only re-enters on a crash (the "改完就退出、报 npm error、要手动重开" case).
# Two stop conditions keep it from looping when it should not: the sentinel (set by cleanup /
# the subshell's own INT-TERM trap on Ctrl+C), and a liveness check on the main script — if the
# script was hard-killed (kill -9, no cleanup), an orphaned loop would otherwise respawn forever.
supervise() {
  local label="$1"
  shift
  trap 'touch "$SHUTDOWN_FLAG" 2>/dev/null; exit 0' INT TERM
  local attempt=0
  while [[ ! -f "$SHUTDOWN_FLAG" ]]; do
    "$@"
    local code=$?
    [[ -f "$SHUTDOWN_FLAG" ]] && break
    kill -0 "$MAIN_PID" 2>/dev/null || break
    # 3 = 拒绝运行（如演示车队补历史拒绝写入已有数据的库），重启也是同样的结果，不再重试。
    if [[ "$code" == "3" ]]; then
      echo "✖ [$label] 拒绝运行（原因见上方），不再自动重启。"
      break
    fi
    attempt=$((attempt + 1))
    echo "⟳ [$label] 退出（code ${code}），1.5s 后自动重启（第 ${attempt} 次；Ctrl+C 停止全部）"
    sleep 1.5
  done
}

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

# 高德 Key 是 Vite 的构建期变量，且**按 workspace 各自一份**。少了它 GPS 面板会显示
# 「未配置 Key」而其余功能正常 —— 这个提示曾被当成前端缺陷报上来一次，所以这里明说。
if [[ ! -f "$ROOT/$FRONTEND_WORKSPACE/.env" ]]; then
  echo "ℹ 未找到 $FRONTEND_WORKSPACE/.env —— GPS 面板会显示「未配置 Key」，其余功能不受影响。"
  echo "  需要地图时在该文件里写 VITE_AMAP_KEY 与 VITE_AMAP_SECURITY_JS_CODE（两个 workspace 各自一份）。"
fi

# 后端/前端启动各封装成函数，交给 supervise 守护：进程崩溃（报 npm error 退出）即自动
# 重启，不必手动重跑脚本。健康运行时 tsx watch / vite 不会返回，所以 supervise 只在崩溃后重入。
run_backend() {
  cd "$ROOT/backend" || return 1
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
  if [[ "$DEMO_MODE" == "1" ]]; then
    export MONGO_URI="$DEV_MONGO_URI"
  fi
  npm run dev
}
run_frontend() { cd "$ROOT/$FRONTEND_WORKSPACE" && npm run dev; }

echo "启动后端 (:${BACKEND_PORT})…"
supervise 后端 run_backend &
PIDS+=($!)

echo "启动前端 —— ${FRONTEND_LABEL} (${FRONTEND_URL})…"
supervise 前端 run_frontend &
PIDS+=($!)

# 等待后端健康检查通过（最多 ~30s）
echo -n "等待后端就绪"
backend_ready=0
for _ in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then backend_ready=1; break; fi
  echo -n "."; sleep 0.5
done
if [[ "$backend_ready" == "1" ]]; then
  echo " ok"
else
  echo " 未就绪"
  echo "⚠ 后端 30s 内没有通过健康检查，原因见上方后端日志；它在守护下会继续重试。"
fi

# --demo：后端起来后注入演示账号/角色/组 + 会话/审计（走 admin API，幂等）。
if [[ "$DEMO_MODE" == "1" ]]; then
  echo "注入演示数据：用户/角色/组 + 会话/审计…"
  (cd "$ROOT/backend" && SEED_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" \
    ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASS" \
    npm run seed:demo) || echo "⚠ seed:demo 失败（可稍后手动重试）"
fi

# 演示车队（backend/sim）：走真实 MQTT 链路，每车每秒一帧，状态记在 backend/.demo-sim/。
# --demo 时先把历史补到「现在」（首次 7 天，之后只补停下期间的空档），再转实时上报；
# 没有 Mongo 时只发实时。补历史期间后端已在跑，补完前的几分钟车辆可能短暂显示离线。
run_sim() {
  cd "$ROOT/backend" || return 1
  export CONFIG_ROOT_PATH="../config-runtime" \
    MQTT_PUBLISHER_USERNAME="$MQTT_PUBLISHER_USER" \
    MQTT_PUBLISHER_PASSWORD="$MQTT_PUBLISHER_PASS" \
    LOG_LEVEL=warn
  if [[ "$DEMO_MODE" == "1" ]]; then
    MONGO_URI="$DEV_MONGO_URI" SIM_HISTORY_DAYS=7 npm run sim:catchup || return $?
  fi
  npm run sim:live
}
# compose 演示栈的 sim 容器在跑时，它已经在用同一个发布者身份发车队：再起一个，两边会互相顶掉
# 会话，后端交替收到两条时间线。
compose_sim_running() {
  command -v docker >/dev/null 2>&1 &&
    [[ -n "$(docker ps -q --filter label=com.docker.compose.service=sim 2>/dev/null)" ]]
}
if [[ "$MOCK_MODE" != "off" ]]; then
  if compose_sim_running; then
    echo "ℹ compose 演示栈的 sim 容器正在发布演示车队，跳过本地演示车队（避免两个发布者互相顶替）。"
  elif broker_up; then
    echo "检测到 MQTT broker，启动演示车队…"
    supervise 演示车队 run_sim &
    PIDS+=($!)
  elif [[ "$MOCK_MODE" == "force" ]]; then
    echo "⚠ 未检测到 127.0.0.1:1883 的 MQTT broker，无法发布实时演示数据。"
    echo "  可先启动 broker：docker compose --env-file deploy/.env -p navfleet -f deploy/docker-compose.yml up -d mosquitto"
  else
    echo "ℹ 未检测到本机 MQTT broker，跳过演示车队。"
  fi
fi

echo
echo "─────────────────────────────────────────────"
echo "  前端:   ${FRONTEND_URL}  (${FRONTEND_LABEL})"
echo "  后端:   http://127.0.0.1:${BACKEND_PORT}"
echo "  账号:   ${ADMIN_USER} / ${ADMIN_PASS}"
if [[ "$DEMO_MODE" == "1" ]]; then
  echo "  演示:   已注入用户/角色/组；演示车队补齐历史后实时上报（Mongo 容器 ${DEV_MONGO_CONTAINER}）"
  echo "  事件:   (cd backend && npm run sim -- inject <设备> <事件> [分钟])"
  echo "  清库:   docker rm -f ${DEV_MONGO_CONTAINER} && rm -rf backend/.demo-sim"
fi
echo "  停止:   Ctrl+C（--demo 的 Mongo 容器会保留）"
echo "─────────────────────────────────────────────"
wait

