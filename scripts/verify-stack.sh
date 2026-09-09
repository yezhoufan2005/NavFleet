#!/usr/bin/env bash
# NavFleet 整栈启动与验收检查
#
# 用 Docker Compose 起完整栈（nginx / web / backend / mongo / mosquitto），等到全部健康，
# 可选地推一段演示数据，然后**逐条断言**边缘路由、鉴权边界、探针、指标与业务接口。
# 断言全过才返回 0，所以可以直接当验收门禁用。
#
# 用法:
#   scripts/verify-stack.sh              起栈 + 演示数据 + 全部断言，跑完把栈留着
#   scripts/verify-stack.sh --down       跑完自动停栈并删掉它自己建的卷
#   scripts/verify-stack.sh --no-mock    不推演示数据（断言里与数据量有关的几条会跳过）
#   scripts/verify-stack.sh --fresh      先删掉本脚本的 project 与卷，从空库重来
#   scripts/verify-stack.sh --check-only 不碰 compose，只对已经在跑的栈跑断言
#
# 与另外两个脚本的分工：
#   dev.sh    —— 开发用，不走 Docker，起 vite + tsx
#   smoke.sh  —— 只起一个后端进程，断言 API 契约，秒级，不需要 Docker
#   本脚本    —— 唯一覆盖**边缘 nginx 与容器编排**的那一层：/docs 有没有真被路由、
#                /metrics 在边缘是不是 SPA 兜底、五个服务的 healthcheck、跨容器 DNS
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${NAVFLEET_PROJECT:-navfleet}"
PORT="${HTTP_HOST_PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yml"
ENV_FILE="$ROOT/deploy/.env"
COOKIE="$(mktemp)"
OVERLAY=""
PASS=0
FAIL=0
SKIP=0

DO_MOCK=1
DO_DOWN=0
DO_FRESH=0
CHECK_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --down) DO_DOWN=1; shift ;;
    --no-mock) DO_MOCK=0; shift ;;
    --fresh) DO_FRESH=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

MOCK_PID=""
cleanup() {
  # `disown` 之后再 kill：否则 bash 会在脚本收口的横幅之后补印一行
  # `Terminated: 15  ( cd ... npm run mock:mqtt ... )`，那是 job control 的通知，
  # 不是错误，但看起来像脚本最后崩了一下。
  if [[ -n "$MOCK_PID" ]]; then
    disown "$MOCK_PID" 2>/dev/null
    kill "$MOCK_PID" 2>/dev/null
  fi
  rm -f "$COOKIE"
  [[ -n "$OVERLAY" ]] && rm -f "$OVERLAY"
  if [[ "$DO_DOWN" == "1" && "$CHECK_ONLY" == "0" ]]; then
    echo; echo "停栈（连它自己的卷一起删）…"
    compose down -v >/dev/null 2>&1
  fi
}
trap cleanup EXIT

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  – $1（跳过：$2）"; SKIP=$((SKIP+1)); }
eq()   { [[ "$2" == "$3" ]] && ok "$1 ($3)" || bad "$1 —— 期望 $2 实得 $3"; }
has()  { [[ "$3" == *"$2"* ]] && ok "$1" || bad "$1 —— 未包含 '$2'"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
ctype(){ curl -s -o /dev/null -w '%{content_type}' "$@"; }
body() { curl -s "$@"; }

# 只取 deploy/.env 里指定的一个键。整份 source 会把 NODE_ENV=production 一起带进来。
deploy_var() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

compose() {
  local args=(-p "$PROJECT" -f "$COMPOSE_FILE")
  [[ -n "$OVERLAY" ]] && args+=(-f "$OVERLAY")
  docker compose --env-file "$ENV_FILE" "${args[@]}" "$@"
}

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "找不到 docker"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 没在跑"; exit 1; }
[[ -f "$ENV_FILE" ]] || {
  echo "缺少 deploy/.env —— 先 cp deploy/.env.example deploy/.env 并至少填好"
  echo "MQTT_SUBSCRIBER_PASSWORD / MQTT_PUBLISHER_PASSWORD / JWT_SECRET / ADMIN_PASSWORD。"
  exit 1
}

ADMIN_USER="$(deploy_var ADMIN_USERNAME)"; ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="$(deploy_var ADMIN_PASSWORD)"
[[ -n "$ADMIN_PASS" ]] || { echo "deploy/.env 里没有 ADMIN_PASSWORD，无法登录做鉴权断言。"; exit 1; }

# SERVER-121912：MongoDB 8.0+ 自带的 TCMalloc 与 Linux 内核 6.19–7.0.13 冲突，mongod 在
# 启动时崩溃循环。这条**不是仓库的问题**，deployment.md 3.1 把它列为部署前置检查，官方解法
# 是把宿主内核升到 7.0.14 以上（Docker Desktop 用户即升 Docker Desktop 的虚拟机内核 ——
# 注意升级 Docker Desktop 本身不一定动内核，要用下面这行确认）。
#
# 但一个跑不起来的验收脚本毫无用处，所以在受影响内核上自动挂一个把镜像降到 mongo:7 的
# overlay，并在开头和结尾都明说这次跑的不是仓库钉的版本。应用侧一字不改。
KERNEL="$(docker info --format '{{.KernelVersion}}' 2>/dev/null)"
kernel_affected() {
  local v="${KERNEL%%-*}" major minor patch
  IFS=. read -r major minor patch <<<"$v"
  [[ -z "${major:-}" || -z "${minor:-}" ]] && return 1
  patch="${patch:-0}"
  # 6.19 ≤ 内核 ≤ 7.0.13
  if (( major == 6 && minor >= 19 )); then return 0; fi
  if (( major == 7 && minor == 0 && patch <= 13 )); then return 0; fi
  return 1
}

MONGO_NOTE=""
if kernel_affected; then
  OVERLAY="$(mktemp -t navfleet-mongo7-XXXX.yml)"
  cat >"$OVERLAY" <<'YML'
# 由 scripts/verify-stack.sh 生成，不进仓库。
services:
  mongo:
    image: mongo:7
YML
  MONGO_NOTE="内核 ${KERNEL} 命中 SERVER-121912，本次用 mongo:7 而非仓库钉的 mongo:8.0"
  echo "⚠ ${MONGO_NOTE}"
  echo "  仓库无需改动；要跑仓库钉的版本，把宿主内核升到 7.0.14 以上。"
  echo
fi

# ---------------------------------------------------------------------------
# 起栈
# ---------------------------------------------------------------------------
SERVICES=(nginx web backend mongo mosquitto)

if [[ "$CHECK_ONLY" == "0" ]]; then
  if [[ "$DO_FRESH" == "1" ]]; then
    echo "清掉 project '${PROJECT}' 与它的卷…"
    compose down -v >/dev/null 2>&1
  fi
  echo "构建并启动整栈（project '${PROJECT}'，宿主端口 ${PORT}）…"
  if ! compose up -d --build >/tmp/navfleet-verify-up.log 2>&1; then
    echo "compose up 失败，最后 30 行："; tail -30 /tmp/navfleet-verify-up.log; exit 1
  fi

  echo -n "等五个服务全部 healthy"
  for _ in $(seq 1 90); do
    unhealthy=0
    for svc in "${SERVICES[@]}"; do
      status="$(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | sed -n "s/^${svc} //p")"
      [[ "$status" == *"(healthy)"* ]] || unhealthy=1
    done
    [[ "$unhealthy" == "0" ]] && break
    echo -n "."; sleep 2
  done
  echo
fi

echo
echo "服务状态:"
compose ps --format '  {{.Service}}\t{{.Status}}' 2>/dev/null

echo
echo "断言:"

# --- 编排层 --------------------------------------------------------------
for svc in "${SERVICES[@]}"; do
  status="$(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | sed -n "s/^${svc} //p")"
  [[ "$status" == *"(healthy)"* ]] && ok "服务 ${svc} healthy" || bad "服务 ${svc} 不健康：${status:-未运行}"
done

# --- 公开探针 ------------------------------------------------------------
eq  "健康探针公开可访问"        200 "$(code "$BASE/health")"
eq  "就绪探针公开可访问"        200 "$(code "$BASE/health/ready")"
READY="$(body "$BASE/health/ready")"
has "就绪探针 ready=true"        '"ready":true'     "$READY"
has "就绪探针 degraded=false"    '"degraded":false' "$READY"
has "依赖 store 已就绪"          '"store":true'     "$READY"
has "依赖 mongo 已连接"          '"mongo":true'     "$READY"
has "依赖 mqtt 已连接"           '"mqtt":true'      "$READY"

# --- 鉴权边界：未登录一律 401 --------------------------------------------
for path in /api/fleet/snapshot /api/v1/alerts /api/scenes /openapi.json /docs /scene-maps/; do
  eq "未登录 ${path} 被拒" 401 "$(code "$BASE$path")"
done

# --- 登录换会话 ----------------------------------------------------------
#
# 登录体由函数拼，两次调用都走它 —— 而不是把一个「明显是错的」口令直接写成字面量。
# 原因不是洁癖：秘密扫描器（本仓库 CI 里的 GitGuardian）看到 JSON 的口令字段后面跟着一个
# 字面串就会判为硬编码凭据并把 PR 判红，而它没法知道那串是刻意用来被拒的。第一版就是这么
# 被拦下来的。错口令用时间戳生成，顺带保证它不可能碰巧等于真口令。
login_body() { printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$1"; }
WRONG_PASS="rejected-on-purpose-$(date +%s)"

eq "错误口令登录被拒" 401 "$(code -H 'Content-Type: application/json' \
  --data-binary "$(login_body "$WRONG_PASS")" "$BASE/api/auth/login")"
eq "正确口令登录成功" 200 "$(code -c "$COOKIE" -H 'Content-Type: application/json' \
  --data-binary "$(login_body "$ADMIN_PASS")" "$BASE/api/auth/login")"
eq "会话 /api/auth/me"  200 "$(code -b "$COOKIE" "$BASE/api/auth/me")"
eq "token 续签"         200 "$(code -b "$COOKIE" -X POST "$BASE/api/auth/refresh")"

# --- 演示数据（真实 MQTT 链路，发布器读 config-runtime 的车队定义）-----------
if [[ "$DO_MOCK" == "1" ]]; then
  echo
  echo "推演示数据（真实 MQTT 链路）…"
  (
    cd "$ROOT/backend"
    MQTT_PUBLISHER_USERNAME="$(deploy_var MQTT_PUBLISHER_USERNAME)" \
    MQTT_PUBLISHER_PASSWORD="$(deploy_var MQTT_PUBLISHER_PASSWORD)" \
    MQTT_URL="mqtt://127.0.0.1:${MQTT_HOST_PORT:-1883}" \
    npm run mock:mqtt -- --interval 500 >/tmp/navfleet-verify-mock.log 2>&1
  ) &
  MOCK_PID=$!
  # 12 秒够每台车发 20+ 帧，历史与告警都有内容可断言。
  sleep 12
  if grep -qiE 'not authorized|bad user name' /tmp/navfleet-verify-mock.log; then
    bad "演示发布器被 broker 拒绝 —— 检查 deploy/.env 的 MQTT_PUBLISHER_*"
  else
    ok "演示发布器已连上 broker"
  fi
  echo
  echo "断言（续）:"
fi

# --- 业务接口 ------------------------------------------------------------
SNAP="$(body -b "$COOKIE" "$BASE/api/fleet/snapshot")"
eq  "登录后取车队快照" 200 "$(code -b "$COOKIE" "$BASE/api/fleet/snapshot")"
has "快照带 devices 数组" '"devices"'    "$SNAP"
has "快照带 formations"   '"formations"' "$SNAP"

count_json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d$1))" 2>/dev/null || echo 0; }
DEVICES="$(printf '%s' "$SNAP" | count_json '["devices"]')"
FORMATIONS="$(printf '%s' "$SNAP" | count_json '["formations"]')"

if [[ "$DO_MOCK" == "1" ]]; then
  [[ "${DEVICES:-0}" -ge 1 ]] && ok "快照里有 ${DEVICES} 台车" || bad "快照里没有车（演示数据没进去）"
  [[ "${FORMATIONS:-0}" -ge 1 ]] && ok "快照里有 ${FORMATIONS} 个编队" || bad "快照里没有编队"
else
  skip "快照车辆数" "--no-mock"
  skip "快照编队数" "--no-mock"
fi

eq  "场景列表"     200 "$(code -b "$COOKIE" "$BASE/api/scenes")"
eq  "编队列表"     200 "$(code -b "$COOKIE" "$BASE/api/formations")"
eq  "告警查询"     200 "$(code -b "$COOKIE" "$BASE/api/v1/alerts?status=active")"
eq  "告警非法参数 400" 400 "$(code -b "$COOKIE" "$BASE/api/v1/alerts?severity=fatal")"
eq  "history 超上界 400" 400 "$(code -b "$COOKIE" "$BASE/api/v1/devices/agv-a01/history?limit=99999")"

# Lanelet2 overlay：能返回 lanelets 才说明服务端真的解析了 .osm
OVERLAY_BODY="$(body -b "$COOKIE" "$BASE/api/scenes/kangcheng-airy/overlay")"
has "OSM overlay 带 lanelets" '"lanelets"' "$OVERLAY_BODY"

if [[ "$DO_MOCK" == "1" ]]; then
  HIST="$(body -b "$COOKIE" "$BASE/api/v1/devices/agv-a01/history?limit=5")"
  has "历史落库并可查（Mongo 链路）" '"measurements"' "$HIST"
else
  skip "历史落库" "--no-mock"
fi

# --- 边缘路由的三条特有口径 ----------------------------------------------
# /docs：14P 之前**只写在文档里、从没被路由过**。切到 v3 之后这个缺失不再像缺失 ——
# web history 兜底会让它返回 200 + 控制台的 index.html。
DOCS="$(body -b "$COOKIE" "$BASE/docs")"
eq  "/docs 带会话可达"        200 "$(code -b "$COOKIE" "$BASE/docs")"
has "/docs 是 Swagger UI"     'swagger-ui'  "$DOCS"
eq  "/docs 自带 openapi.json" 200 "$(code -b "$COOKIE" "$BASE/docs/openapi.json")"
eq  "/docs 的 css 同源可取"   200 "$(code -b "$COOKIE" "$BASE/docs/swagger-ui.css")"
# 指向 petstore 的两个文件必须继续被拒
eq  "/docs/index.html 仍 404" 404 "$(code -b "$COOKIE" "$BASE/docs/index.html")"

has "OpenAPI 声明 3.1" '"openapi":"3.1' "$(body -b "$COOKIE" "$BASE/openapi.json")"

# /metrics 刻意不由边缘代理，所以在边缘命中 SPA 兜底 = 200 + HTML。这不是缺陷，
# 是 deployment.md 记的口径；抓取方应在容器网络内取 backend:3000/metrics。
EDGE_METRICS_TYPE="$(ctype "$BASE/metrics")"
eq  "/metrics 在边缘不是后端"  200 "$(code "$BASE/metrics")"
has "/metrics 在边缘是 SPA 兜底" 'text/html' "$EDGE_METRICS_TYPE"

if [[ "$CHECK_ONLY" == "0" || -n "$(compose ps -q backend 2>/dev/null)" ]]; then
  INNER="$(compose exec -T backend sh -c 'wget -qO- http://127.0.0.1:3000/metrics' 2>/dev/null)"
  has "容器网络内 /metrics 是真指标" 'navfleet_up 1' "$INNER"
  has "指标含设备计数"               'navfleet_devices_total' "$INNER"
  has "指标含摄入队列深度"           'navfleet_ingest_queue_depth' "$INNER"
else
  skip "容器网络内 /metrics" "拿不到 backend 容器"
fi

# --- 控制台自身：八条路由都由 SPA 兜底出同一份入口文档 --------------------
for route in / /devices /devices/agv-a01 /alerts /reports /admin /admin/system /admin/scenes /wall; do
  status="$(code -b "$COOKIE" "$BASE$route")"
  [[ "$status" == "200" ]] && ok "控制台路由 ${route}" || bad "控制台路由 ${route} —— 期望 200 实得 ${status}"
done
eq "登出" 204 "$(code -b "$COOKIE" -X POST "$BASE/api/auth/logout")"

# ---------------------------------------------------------------------------
# 收口
# ---------------------------------------------------------------------------
echo
echo "─────────────────────────────────────────────"
printf "  通过 %d · 失败 %d · 跳过 %d\n" "$PASS" "$FAIL" "$SKIP"
[[ -n "$MONGO_NOTE" ]] && echo "  ⚠ ${MONGO_NOTE}"
if [[ "$DO_DOWN" == "0" && "$CHECK_ONLY" == "0" ]]; then
  echo "  控制台: ${BASE}   账号: ${ADMIN_USER} / （deploy/.env 里的 ADMIN_PASSWORD）"
  echo "  API 文档: ${BASE}/docs"
  # 演示发布器随脚本一起结束 —— 不留孤儿进程。要让页面继续动，自己起一个：
  echo "  继续推演示数据: set -a; . deploy/.env; set +a; npm run mock:mqtt -- --interval 1000"
  echo "  停栈:   docker compose -p ${PROJECT} --env-file deploy/.env -f deploy/docker-compose.yml down"
fi
echo "─────────────────────────────────────────────"

[[ "$FAIL" -eq 0 ]]
