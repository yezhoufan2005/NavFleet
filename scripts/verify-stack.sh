#!/usr/bin/env bash
# NavFleet 整栈启动与验收检查
#
# 用 Docker Compose 起完整栈（nginx / web / backend / mongo / mosquitto），默认叠加演示车队
# （docker-compose.demo.yml：模拟器 sim + 本机收件箱 mailpit），等到全部健康，注入演示账号/记录，
# 然后**逐条断言**边缘路由、鉴权边界、探针、指标与业务接口。断言全过才返回 0，可直接当验收门禁用。
#
# 演示数据像真实车队一样持续存在：库与模拟器状态都在卷里，**首次**起栈生成保留期内的历史
# （29 车 × 30 天、模拟器限 2 核时约 1 小时），之后每次起栈只补停栈期间的空档，随即接着实时上报。
#
# 用法:
#   scripts/verify-stack.sh              起栈 + 演示车队 + 演示账号/记录 + 全部断言，跑完把栈留着
#   scripts/verify-stack.sh --down       跑完停栈（保留数据卷，下次起栈接着补齐）
#   scripts/verify-stack.sh --purge      开跑前删掉本 project 的全部卷（库与演示状态），从空库重来
#   scripts/verify-stack.sh --no-mock    不叠加演示车队（断言里与数据量有关的几条会跳过）
#   scripts/verify-stack.sh --no-seed    不注入演示账号/角色/组/会话/审计（只保留 admin）
#   scripts/verify-stack.sh --fresh      先停掉并删除本 project 的容器再起（保留卷）
#   scripts/verify-stack.sh --check-only 不碰 compose，只对已经在跑的栈跑断言（也不注入演示数据）
#   scripts/verify-stack.sh --allow-dirty 工作树有未提交改动时仍继续（默认拦下，见下）
#   scripts/verify-stack.sh --mqtt-tls   叠加 TLS broker（mqtts://8883），验证加密摄入链路
#   scripts/verify-stack.sh --monitoring 叠加监控栈，断言三个 exporter 在 Prometheus 里 up
#
# 每次都「干净地更新+重启」：compose 从磁盘当前文件构建镜像，故开工前会打印构建依据的 HEAD，
# 工作树脏则默认拦下（镜像会含改到一半的文件，正是 vue-tsc 偶发失败的根因）；启动用
# --force-recreate 强制重建容器，确保改过的挂载配置（如 nginx locations.conf）与新镜像一定生效。
#
# 与另外两个脚本的分工：
#   dev.sh    —— 开发用（热更新）：前后端走 tsx/vite；--demo 另起一次性 Mongo 容器注入演示数据
#   smoke.sh  —— 全量 API 契约冒烟：起一个临时后端进程逐条断言接口契约，秒级，不需要 Docker
#   本脚本    —— 完整起栈：唯一覆盖**边缘 nginx 与容器编排**的那一层（/docs 路由、/metrics
#                SPA 兜底、五个服务 healthcheck、跨容器 DNS），并把演示账号/记录注入进真库
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${NAVFLEET_PROJECT:-navfleet}"
PORT="${HTTP_HOST_PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yml"
ENV_FILE="$ROOT/deploy/.env"
COOKIE="$(mktemp)"
PASS=0
FAIL=0
SKIP=0

DO_MOCK=1
DO_SEED=1
DO_DOWN=0
DO_FRESH=0
DO_PURGE=0
CHECK_ONLY=0
MQTT_TLS=0
MONITORING=0
ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --down) DO_DOWN=1; shift ;;
    --no-mock) DO_MOCK=0; shift ;;
    --no-seed) DO_SEED=0; shift ;;
    --fresh) DO_FRESH=1; shift ;;
    --purge) DO_PURGE=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --mqtt-tls) MQTT_TLS=1; shift ;;
    --monitoring) MONITORING=1; shift ;;
    # 2,31 是上面那段注释的确切范围 —— 注释止于第 31 行，第 32 行是 `set -uo pipefail`。
    # dev.sh 里踩过同一个off-by-one（--help 末尾多印一行代码），所以这里写死并核对过。
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

cleanup() {
  rm -f "$COOKIE"
  # 只停不删：演示车队的历史与模拟器状态都在卷里，下次起栈从停下的那一秒接着补齐。
  if [[ "$DO_DOWN" == "1" && "$CHECK_ONLY" == "0" ]]; then
    echo; echo "停栈（保留数据卷）…"
    compose down >/dev/null 2>&1
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
  docker compose --env-file "$ENV_FILE" -p "$PROJECT" "${COMPOSE_ARGS[@]}" "$@"
}

# Base file always; the TLS overlay is appended under --mqtt-tls. An array so the
# `-f a -f b` argument pair is passed verbatim (a single string would word-split
# wrong on the paths).
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ "$MQTT_TLS" == "1" ]]; then
  COMPOSE_ARGS+=(-f "$ROOT/deploy/docker-compose.mqtt-tls.yml")
fi
if [[ "$MONITORING" == "1" ]]; then
  COMPOSE_ARGS+=(-f "$ROOT/deploy/docker-compose.monitoring.yml")
fi
if [[ "$DO_MOCK" == "1" ]]; then
  COMPOSE_ARGS+=(-f "$ROOT/deploy/docker-compose.demo.yml")
fi
PROM_PORT="${PROMETHEUS_HOST_PORT:-9090}"

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

# 这里曾经有一段内核检查：MongoDB 8.0+ 在 Linux 6.19–7.0.13 上拒绝启动
# （SERVER-121912），所以脚本会在受影响的机器上自动挂一个把镜像降到 mongo:7 的临时 overlay。
#
# 那段代码已经删掉了 —— **compose 直接钉 mongo:7.0 了**（理由见 deployment.md 3.1：本项目一行
# 代码都不需要 8.0，而 8.0 换来的只是「更新」，代价是一整类宿主起不来）。一个不再需要的
# 变通比它解决的问题更容易误导人。

# --mqtt-tls：确保 broker 证书就位（缺就用 lab 脚本现生成一套自签的）。overlay 把
# ./mosquitto/certs 挂进 broker 与 backend，缺文件 docker 会静默建空目录、握手必失败。
if [[ "$MQTT_TLS" == "1" && "$CHECK_ONLY" == "0" ]]; then
  if [[ ! -f "$ROOT/deploy/mosquitto/certs/server.crt" ]]; then
    echo "生成 lab MQTT 证书（deploy/mosquitto/certs/）…"
    sh "$ROOT/deploy/tools/generate-mqtt-certs.sh" >/dev/null
  fi
fi

# --monitoring：叠加会因 `${VAR:?}` 在缺口令时直接让 up 失败，这里先给出可读的前置提示。
if [[ "$MONITORING" == "1" ]]; then
  [[ -n "$(deploy_var GRAFANA_ADMIN_PASSWORD)" ]] ||
    { echo "deploy/.env 里没有 GRAFANA_ADMIN_PASSWORD，监控叠加会拒绝启动。"; exit 1; }
  [[ -n "$(deploy_var MQTT_MONITOR_PASSWORD)" ]] ||
    { echo "deploy/.env 里没有 MQTT_MONITOR_PASSWORD，mosquitto-exporter 无法连 broker。"; exit 1; }
fi

# ---------------------------------------------------------------------------
# 起栈
# ---------------------------------------------------------------------------
SERVICES=(nginx web backend mongo mosquitto)
[[ "$DO_MOCK" == "1" ]] && SERVICES+=(sim)

if [[ "$CHECK_ONLY" == "0" ]]; then
  # compose 从**当前磁盘上的文件**构建镜像（context 是仓库根），不是从某个 git 提交。所以工作树脏
  # ——有人正在改、或切分支/编辑改到一半——镜像就会装进半成品，`vue-tsc` 等构建步骤随机报错（这正是
  # 之前几次 `npm run build -w navfleet-console` 在 vue-tsc 处莫名失败的根因：构建发生在编辑中途）。
  # 开工前先把构建依据亮出来，脏树默认拦下，确认是在测本地改动再 --allow-dirty 放行。
  HEAD_DESC="$(git -C "$ROOT" log --oneline -1 2>/dev/null || echo '(非 git 仓库)')"
  echo "构建依据 HEAD：${HEAD_DESC}"
  if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
    echo "⚠ 工作树有未提交改动——镜像会按磁盘现状构建，包含任何改到一半的文件："
    git -C "$ROOT" status --short 2>/dev/null | sed 's/^/    /'
    if [[ "$ALLOW_DIRTY" == "0" ]]; then
      echo "  这常是「构建撞上正在进行的编辑」。确认无误（在测本地改动）就加 --allow-dirty 重跑；"
      echo "  否则先提交/暂存，或等编辑结束，再 sh verify-stack.sh。"
      exit 1
    fi
    echo "  （--allow-dirty：按当前磁盘状态继续）"
  fi

  if [[ "$DO_PURGE" == "1" ]]; then
    echo "删掉 project '${PROJECT}' 的容器与全部卷（库与演示车队状态），从空库重来…"
    compose down -v >/dev/null 2>&1
  elif [[ "$DO_FRESH" == "1" ]]; then
    echo "停掉并删除 project '${PROJECT}' 的容器（保留卷）…"
    compose down >/dev/null 2>&1
  fi
  echo "构建并启动整栈（project '${PROJECT}'，宿主端口 ${PORT}）…"
  # --force-recreate：保证每次都重建容器。否则改了挂载进容器的配置（如 nginx 的 locations.conf，
  # 单文件 bind mount，host 侧改动不会触发 compose 重建）或重建了镜像时，旧容器可能原地留存，
  # 看起来「跑了却没更新」。配合上面的构建，这条让「每次 verify-stack 都确实更新+重启」成立。
  if [[ "$DO_MOCK" == "1" ]]; then
    # 演示车队分两步起：先库、broker 与模拟器，等模拟器把历史补到「现在」并转入实时上报，再起平台。
    # 平台不在历史还在写的时候判离线——和真实现场一样，车一直在报，平台后上线。
    if ! compose up -d --build --force-recreate mongo mosquitto mailpit sim \
      >/tmp/navfleet-verify-up.log 2>&1; then
      echo "compose up（演示车队）失败，最后 30 行："; tail -30 /tmp/navfleet-verify-up.log; exit 1
    fi
    echo "等演示车队补齐历史并转入实时上报（首次约 1 小时，之后只补停栈期间的空档）…"
    last_line=""
    sim_ready=0
    for _ in $(seq 1 1440); do
      status="$(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | sed -n 's/^sim //p')"
      if [[ "$status" == *"(healthy)"* ]]; then sim_ready=1; break; fi
      if [[ "$status" != Up* ]]; then
        echo "  模拟器没在运行：${status:-未运行}"; compose logs --tail 30 sim; exit 1
      fi
      line="$(compose logs --no-log-prefix sim 2>/dev/null | grep '^\[sim\]' | tail -1)"
      if [[ -n "$line" && "$line" != "$last_line" ]]; then echo "  ${line}"; last_line="$line"; fi
      sleep 5
    done
    [[ "$sim_ready" == "1" ]] || { echo "  模拟器 2 小时内未就绪"; compose logs --tail 30 sim; exit 1; }
    # --no-deps：依赖刚才已起好；不带它，force-recreate 会把模拟器也重建一遍。
    if ! compose up -d --build --force-recreate --no-deps nginx web backend \
      >>/tmp/navfleet-verify-up.log 2>&1; then
      echo "compose up 失败，最后 30 行："; tail -30 /tmp/navfleet-verify-up.log; exit 1
    fi
  elif ! compose up -d --build --force-recreate >/tmp/navfleet-verify-up.log 2>&1; then
    echo "compose up 失败，最后 30 行："; tail -30 /tmp/navfleet-verify-up.log; exit 1
  fi

  # 重启 backend，清空它内存里的「登录限流」计数再做鉴权断言。
  #
  # 为什么需要：/api/auth 挂了一个 express-rate-limit（AUTH_RATE_LIMIT_MAX，默认 50 次 /
  # 15 分钟 / 每 IP，见 app.ts），计数存在后端进程内存里。本脚本每跑一遍要打 ~5 个 auth 请求
  # （错/对口令登录、/me、续签、登出），同一个 15 分钟窗口里反复验收就会累加到 50 以上 ——
  # 于是登录直接 429，后面所有带会话的断言连锁 401。`compose up` 若没改镜像不会重建既有容器，
  # 这个内存计数就跨多次验收活了下来（正是本次 23 条失败的根因）。重启后进程重来、计数归零，
  # 每次验收都拿到干净的限流预算；限流值本身不动（仍是真实的 50/15min）。
  #
  # --fresh / --purge 刚 down + up 过，backend 本就是新的，跳过这次多余的重启。
  if [[ "$DO_FRESH" == "0" && "$DO_PURGE" == "0" ]]; then
    echo "重启 backend 清空登录限流计数（避免多次验收累积触发 429）…"
    compose restart backend >/dev/null 2>&1 || true
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

# --- MQTT over TLS（仅 --mqtt-tls）---------------------------------------
# 上面那条 `mqtt:true` 在 TLS 叠加下就是端到端证明：backend 连的是 mqtts://mosquitto:8883，
# 就绪 = TLS 握手 + CA 校验 + 账号鉴权全过。再补一条 broker 侧：日志里出现 8883 监听
# 才说明 TLS 监听器真的起来了（而不是仅 1883）。
if [[ "$MQTT_TLS" == "1" ]]; then
  MOSQ_LOG="$(compose logs mosquitto 2>/dev/null)"
  has "broker 起了 8883 TLS 监听器" 'port 8883' "$MOSQ_LOG"
  has "backend 经 mqtts 连上（就绪即证明）" '"mqtt":true' "$READY"
fi

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

# --- 演示车队（模拟器 sim 经真实 MQTT 链路上报，历史由同一条时间线回填）------------
if [[ "$DO_MOCK" == "1" ]]; then
  echo
  echo "演示车队:"
  compose logs --no-log-prefix sim 2>/dev/null | grep -E '^\[sim\] .*(wrote|summarised|connected)' | tail -3 | sed 's/^/  /'
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
  # 回放要的是位姿：历史帧与实时帧同一形状，带 ROS 位姿与场景。
  FROM_24H="$(python3 -c "import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
  NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  PLAYBACK="$(body -b "$COOKIE" "$BASE/api/v1/devices/agv-a01/history?from=${FROM_24H}&to=${NOW_ISO}&sampling=even")"
  POSED="$(printf '%s' "$PLAYBACK" | python3 -c "
import json,sys
items=json.load(sys.stdin).get('items',[])
print(sum(1 for i in items if isinstance((i.get('measurements') or {}).get('fusionLoc',{}).get('x'),(int,float))), len(items))" 2>/dev/null || echo '0 0')"
  [[ "${POSED%% *}" -ge 100 && "${POSED%% *}" == "${POSED##* }" ]] &&
    ok "近 24 小时回放每帧都带 ROS 位姿（${POSED##* } 帧）" || bad "回放帧缺位姿（带位姿/总数：${POSED}）"
  # 30 天全车队报表：1 Hz 下靠小时汇总才能在超时内出来。
  REPORT_FROM="$(python3 -c "import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
  REPORT_T="$(curl -s -o /tmp/navfleet-verify-report.json -w '%{http_code} %{time_total}' -b "$COOKIE" \
    "$BASE/api/v1/reports/availability?from=${REPORT_FROM}&to=${NOW_ISO}&bucket=day")"
  [[ "${REPORT_T%% *}" == "200" ]] && grep -q '"available":true' /tmp/navfleet-verify-report.json &&
    ok "30 天全车队可用率报表（${REPORT_T##* }s）" || bad "30 天全车队可用率报表失败：${REPORT_T}"
  CLEARED="$(body -b "$COOKIE" "$BASE/api/v1/alerts?status=cleared" | count_json '["items"]')"
  [[ "${CLEARED:-0}" -ge 50 ]] && ok "已清除的消息历史（${CLEARED} 条，查询上限 500）" || bad "已清除的消息历史过少：${CLEARED}"
  # 注入：急停一分钟，平台随即看到 5701；一分钟后自行恢复，不留永久状态。
  if compose exec -T sim npx tsx sim/main.ts inject agv-w05 estop 1 >/dev/null 2>&1; then
    INJECTED=""
    for _ in $(seq 1 15); do
      INJECTED="$(body -b "$COOKIE" "$BASE/api/fleet/snapshot" | python3 -c "
import json,sys
d={x['deviceId']:x for x in json.load(sys.stdin)['devices']}
print(d.get('agv-w05',{}).get('errorCode',{}).get('code'))" 2>/dev/null)"
      [[ "$INJECTED" == "5701" ]] && break
      sleep 1
    done
    eq "注入急停后平台看到 agv-w05 报 5701" 5701 "$INJECTED"
  else
    bad "注入命令执行失败"
  fi
  MAILPIT_N="$(curl -s "http://127.0.0.1:$(deploy_var MAILPIT_HOST_PORT | grep . || echo 8025)/api/v1/messages?limit=1" |
    python3 -c "import json,sys;print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo 0)"
  NOTIFY_N="$(body -b "$COOKIE" "$BASE/api/v1/notify/log" | count_json '["items"]')"
  [[ "${NOTIFY_N:-0}" -ge 1 ]] && ok "外发记录有送达记录（${NOTIFY_N} 条；本机收件箱 ${MAILPIT_N} 封）" ||
    bad "外发记录为空"
else
  skip "历史落库" "--no-mock"
fi

# --- 演示账号 / 角色 / 组 / 会话 / 审计（admin API 注入进真库）------------------
# verify-stack 过去只推遥测（mock），却从不建演示用户 —— 整栈起来后「用户/会话/审计」页仍是空的，
# 用户在真栈里看不到改好的演示数据正是这个缺口。这里跑 seed:demo（幂等）把账号/角色/组/会话/审计
# 注入进 compose 的 Mongo，再断言确实落了库。遥测、消息与外发的历史由演示车队（sim）给出。
if [[ "$DO_SEED" == "1" && "$CHECK_ONLY" == "0" ]]; then
  echo
  echo "注入演示账号/角色/组/会话/审计…"
  if (
    cd "$ROOT/backend"
    SEED_BASE_URL="$BASE" ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASS" \
      npm run seed:demo >/tmp/navfleet-verify-seed.log 2>&1
  ); then ok "seed:demo 跑通"; else bad "seed:demo 失败 —— 看 /tmp/navfleet-verify-seed.log"; fi
  echo
  echo "断言（演示账号/记录）:"
  USERS="$(body -b "$COOKIE" "$BASE/api/v1/users")"
  has "演示运维账号已建"   'zhaoyun'  "$USERS"
  has "锁定演示账号已建"   'wugang'   "$USERS"
  has "自定义角色已建"     '报码维护' "$(body -b "$COOKIE" "$BASE/api/v1/rbac/roles")"
  has "用户组已建"         '现场运维组' "$(body -b "$COOKIE" "$BASE/api/v1/rbac/groups")"
  AUDIT_N="$(body -b "$COOKIE" "$BASE/api/v1/audit?limit=20" | count_json '["entries"]')"
  [[ "${AUDIT_N:-0}" -ge 1 ]] && ok "审计有记录 (${AUDIT_N})" || bad "审计为空（seed 未留痕）"
elif [[ "$CHECK_ONLY" == "1" ]]; then
  skip "注入演示账号/记录" "--check-only"
else
  skip "注入演示账号/记录" "--no-seed"
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

# 压缩在边缘做（locations.conf 的 gzip 段）：接口 JSON 与控制台静态资源都要带 gzip 回来，
# 弱网现场等的就是这几个大 body。openapi.json 足够大、又不需要会话，拿它当探针。
eq  "边缘对 JSON 启用 gzip" gzip "$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%header{content-encoding}' -b "$COOKIE" "$BASE/openapi.json")"

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

# --- 监控 exporter（仅 --monitoring）------------------------------------
# 三个容器侧 exporter 是叠加里另起的，Prometheus（绑 127.0.0.1:${PROM_PORT}）抓它们。
# exporter 目标要一两个抓取周期（15s）才 up，所以每个 job 轮询等待。用 up{job=…} 而不是
# exporter 内部指标名 —— up 是 Prometheus 为每个抓取目标合成的存活信号，最稳。
if [[ "$MONITORING" == "1" ]]; then
  echo
  echo "断言（监控 exporter）:"
  prom_up() {
    curl -s "http://127.0.0.1:${PROM_PORT}/api/v1/query?query=up%7Bjob%3D%22$1%22%7D" |
      python3 -c "import json,sys; r=json.load(sys.stdin).get('data',{}).get('result',[]); print(r[0]['value'][1] if r else 'none')" 2>/dev/null || echo none
  }
  eq "Prometheus 健康检查可达" 200 "$(code "http://127.0.0.1:${PROM_PORT}/-/healthy")"
  for job in navfleet-backend mongodb mosquitto nginx; do
    val=none
    for _ in $(seq 1 15); do
      val="$(prom_up "$job")"
      [[ "$val" == "1" ]] && break
      sleep 5
    done
    [[ "$val" == "1" ]] && ok "target ${job} 在 Prometheus 里 up" || bad "target ${job} 不 up（up=${val}）"
  done
fi

# ---------------------------------------------------------------------------
# 收口
# ---------------------------------------------------------------------------
echo
echo "─────────────────────────────────────────────"
printf "  通过 %d · 失败 %d · 跳过 %d\n" "$PASS" "$FAIL" "$SKIP"
if [[ "$DO_DOWN" == "0" && "$CHECK_ONLY" == "0" ]]; then
  echo "  控制台: ${BASE}   账号: ${ADMIN_USER} / （deploy/.env 里的 ADMIN_PASSWORD）"
  echo "  API 文档: ${BASE}/docs"
  if [[ "$DO_MOCK" == "1" ]]; then
    echo "  演示车队: 模拟器 sim 持续上报（每车每秒一帧），停栈后再起只补空档"
    echo "  制造事件: docker compose -p ${PROJECT} exec sim npx tsx sim/main.ts inject <设备> <事件> [分钟]"
    echo "  邮件收件箱: http://127.0.0.1:$(deploy_var MAILPIT_HOST_PORT | grep . || echo 8025)"
  fi
  echo "  停栈:   docker compose -p ${PROJECT} --env-file deploy/.env ${COMPOSE_ARGS[*]} down（保留数据卷）"
  echo "  从空库重来: scripts/verify-stack.sh --purge"
fi
echo "─────────────────────────────────────────────"

[[ "$FAIL" -eq 0 ]]
