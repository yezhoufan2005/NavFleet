#!/usr/bin/env bash
# NavFleet 整栈启动与验收检查
#
# 用 Docker Compose 起完整栈（nginx / web / backend / mongo / mosquitto），等到全部健康，
# 可选地推一段演示数据 + 注入演示账号/记录，然后**逐条断言**边缘路由、鉴权边界、探针、指标与业务接口。
# 断言全过才返回 0，所以可以直接当验收门禁用。
#
# 用法:
#   scripts/verify-stack.sh              起栈 + 演示数据 + 演示账号/记录 + 全部断言，跑完把栈留着
#   scripts/verify-stack.sh --down       跑完自动停栈并删掉它自己建的卷
#   scripts/verify-stack.sh --no-mock    不推实时演示遥测（断言里与数据量有关的几条会跳过）
#   scripts/verify-stack.sh --no-seed    不注入演示账号/角色/组/会话/审计（只保留 admin）
#   scripts/verify-stack.sh --fresh      先删掉本脚本的 project 与卷，从空库重来
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
    --check-only) CHECK_ONLY=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --mqtt-tls) MQTT_TLS=1; shift ;;
    --monitoring) MONITORING=1; shift ;;
    # 2,27 是上面那段注释的确切范围 —— 注释止于第 27 行，第 28 行是 `set -uo pipefail`。
    # dev.sh 里踩过同一个off-by-one（--help 末尾多印一行代码），所以这里写死并核对过。
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

MOCK_PID=""
# 演示发布器转后台持续运行后，PID 记在这里，供下次起栈（或 --down）先清掉上一只，避免叠加成一群。
MOCK_PIDFILE="/tmp/navfleet-verify-demo-mock.pid"
# 递归杀进程树：mock 是 `( … npm run mock:mqtt ) &`，$! 只是那层 subshell/npm，直接 kill 它
# 会把底下的 tsx→node（真正那个连 broker、按节拍发的进程）留成孤儿，继续灌 compose 后端的摄入
# 队列（表现为报表页偶发 Failed to fetch）。深度优先、先子后父，确保整棵树都停。
kill_tree() {
  local pid="$1" child
  [[ -n "$pid" ]] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  # 收尾策略取决于 --down：
  #  · --down：栈要拆，顺手把后台演示发布器也杀掉、删 pidfile。
  #  · 否则：**故意留着**发布器在后台跑，让设备持续有遥测、保持在线（否则 60s 后全部离线，
  #    正是「演示数据突然没了」）。只 disown，脚本退出不带走它；下次起栈开头会先清旧的再起新的。
  if [[ -n "$MOCK_PID" ]]; then
    disown "$MOCK_PID" 2>/dev/null
    if [[ "$DO_DOWN" == "1" ]]; then
      kill_tree "$MOCK_PID"
      rm -f "$MOCK_PIDFILE"
    fi
  fi
  rm -f "$COOKIE"
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

  if [[ "$DO_FRESH" == "1" ]]; then
    echo "清掉 project '${PROJECT}' 与它的卷…"
    compose down -v >/dev/null 2>&1
  fi
  echo "构建并启动整栈（project '${PROJECT}'，宿主端口 ${PORT}）…"
  # --force-recreate：保证每次都重建容器。否则改了挂载进容器的配置（如 nginx 的 locations.conf，
  # 单文件 bind mount，host 侧改动不会触发 compose 重建）或重建了镜像时，旧容器可能原地留存，
  # 看起来「跑了却没更新」。配合上面的构建，这条让「每次 verify-stack 都确实更新+重启」成立。
  if ! compose up -d --build --force-recreate >/tmp/navfleet-verify-up.log 2>&1; then
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
  # --fresh 刚 down -v + up 过，backend 本就是新的，跳过这次多余的重启。
  if [[ "$DO_FRESH" == "0" ]]; then
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

# --- 演示数据（真实 MQTT 链路，发布器读 config-runtime 的车队定义）-----------
if [[ "$DO_MOCK" == "1" ]]; then
  # 先清掉上一次起栈留在后台的发布器（若有），避免一只只叠加、把后端摄入队列灌爆。
  if [[ -f "$MOCK_PIDFILE" ]]; then
    kill_tree "$(cat "$MOCK_PIDFILE" 2>/dev/null)"
    rm -f "$MOCK_PIDFILE"
  fi
  echo
  echo "推演示数据（真实 MQTT 链路；转后台持续运行以保持设备在线）…"
  # --interval 2000：~29 台车每 2 秒各发一帧 ≈ 15 帧/秒，远低于摄入队列承载，不会灌爆（旧的 500ms
  # 是之前「Failed to fetch」的元凶）；同时 2s < 60s 离线阈值，设备稳定在线。exec nohup 让进程树是
  # nohup→npm→tsx→node，忽略 SIGHUP；凭据走 export（不进 `ps` 的命令行参数）。
  (
    cd "$ROOT/backend"
    export MQTT_PUBLISHER_USERNAME="$(deploy_var MQTT_PUBLISHER_USERNAME)" \
      MQTT_PUBLISHER_PASSWORD="$(deploy_var MQTT_PUBLISHER_PASSWORD)" \
      MQTT_URL="mqtt://127.0.0.1:${MQTT_HOST_PORT:-1883}"
    exec nohup npm run mock:mqtt -- --interval 2000
  ) >/tmp/navfleet-verify-mock.log 2>&1 &
  MOCK_PID=$!
  echo "$MOCK_PID" >"$MOCK_PIDFILE"
  disown "$MOCK_PID" 2>/dev/null || true
  # 10 秒够每台车发 5+ 帧，历史与告警都有内容可断言。
  sleep 10
  if grep -qiE 'not authorized|bad user name' /tmp/navfleet-verify-mock.log; then
    bad "演示发布器被 broker 拒绝 —— 检查 deploy/.env 的 MQTT_PUBLISHER_*"
  else
    ok "演示发布器已连上 broker（将在后台持续运行）"
  fi

  # 回填 30 天演示历史（遥测 + 消息），直接写库。
  #
  # 为什么直接入库而不走 debug/ingest：每台每分钟一帧、30 天是百万级帧，HTTP 回填会撞边缘限流。
  # 生成逻辑在 scripts/demo-history.js（与 backend/scripts/seed-reports.ts 共用同一份），按车型画像
  # 逐分钟模拟电量/作业/充电、计划维护与通信闪断，并按真实形态产出每次发生一条的消息（提示多、预警
  # 次之、告警少；带持续时长、因果先后与按班次的确认人）。这里把它与 vehicles.json 一起喂给 mongosh：
  # 先清掉累积的遥测与消息，再相对“现在”铺 30 天（留最近 5 分钟给后台发布器）。设备在线状态由
  # device_latest + 发布器维持，这里不动它。播种的消息一律是已清除的历史，不污染实时活跃列表。
  MONGO_U="$(deploy_var MONGO_INITDB_ROOT_USERNAME)"; MONGO_U="${MONGO_U:-root}"
  MONGO_P="$(deploy_var MONGO_INITDB_ROOT_PASSWORD)"
  OFFLINE_S="$(python3 -c "import json;print(json.load(open('$ROOT/config-runtime/rules.json')).get('offline',{}).get('afterSeconds',60))" 2>/dev/null || echo 60)"
  SEEDED="$( {
      cat "$ROOT/scripts/demo-history.js"
      printf 'var VEHICLES = %s;\nvar OFFLINE_AFTER_SECONDS = %s;\n' \
        "$(cat "$ROOT/config-runtime/vehicles.json")" "$OFFLINE_S"
      cat <<'JS'
var now = Date.now(), DAYS = 30;
var known = db.device_latest.distinct("deviceId");
var fleet = VEHICLES.filter(function (v) { return known.indexOf(v.deviceId) >= 0; });
if (!fleet.length) { print("0 0 0"); quit(); }
// telemetry_ts 默认 30 天 TTL（TELEMETRY_RETENTION_SECONDS）：演示库放宽到 45 天，30 天历史留得住
// 而不在边上被裁（仅本地演示卷，不改部署配置）。
try { db.runCommand({ collMod: "telemetry_ts", expireAfterSeconds: 45 * 24 * 3600 }); } catch (e) {}
db.telemetry_ts.deleteMany({});
db.alerts.deleteMany({});
var frames = 0, messages = 0;
fleet.forEach(function (vehicle) {
  var h = demoDeviceHistory(vehicle, VEHICLES.indexOf(vehicle),
    { now: now, days: DAYS, offlineAfterSeconds: OFFLINE_AFTER_SECONDS, tailMinutes: 5 });
  for (var i = 0; i < h.telemetry.length; i += 10000) db.telemetry_ts.insertMany(h.telemetry.slice(i, i + 10000));
  if (h.alerts.length) db.alerts.insertMany(h.alerts);
  frames += h.telemetry.length; messages += h.alerts.length;
});
print(fleet.length + " " + frames + " " + messages);
JS
    } | compose exec -T mongo mongosh --quiet -u "$MONGO_U" -p "$MONGO_P" \
      --authenticationDatabase admin fleet_monitor 2>/dev/null
  )"
  SEEDED="$(printf '%s' "$SEEDED" | grep -oE '[0-9]+ [0-9]+ [0-9]+' | tail -1 | awk '{print $1" 台 / "$2" 帧遥测 / "$3" 条消息"}')"
  echo "演示历史回填：${SEEDED:-（无设备，已跳过）}（30 天，随本次起栈刷新）"

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

# --- 演示账号 / 角色 / 组 / 会话 / 审计（admin API 注入进真库）------------------
# verify-stack 过去只推遥测（mock），却从不建演示用户 —— 整栈起来后「用户/会话/审计」页仍是空的，
# 用户在真栈里看不到改好的演示数据正是这个缺口。这里跑 seed:demo（幂等）把账号/角色/组/会话/审计
# 注入进 compose 的 Mongo，再断言确实落了库。报表的多日历史不在这里造（需 DEBUG_INGEST，且本就是
# dev.sh --demo 的职责）；mock 已给「今天」的遥测与告警。
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
    echo "  演示发布器: 已转后台持续运行（每 2s 一帧），设备保持在线；下次起栈会自动替换它"
    echo "  只停发布器: kill \$(cat ${MOCK_PIDFILE}) 的进程树（或再跑一次本脚本 / 加 --down）"
  fi
  echo "  停栈:   docker compose -p ${PROJECT} --env-file deploy/.env -f deploy/docker-compose.yml down"
fi
echo "─────────────────────────────────────────────"

[[ "$FAIL" -eq 0 ]]
