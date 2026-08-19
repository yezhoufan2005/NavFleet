#!/usr/bin/env bash
# NavFleet API 冒烟测试：启动一个临时后端实例，断言鉴权与关键接口契约。
# 无需浏览器、无 token 成本，可重复运行。用法: scripts/smoke.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=3100
BASE="http://127.0.0.1:${PORT}"
COOKIE="$(mktemp)"
PASS=0
FAIL=0

check() { # 描述  期望码  实际码
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1 ($3)"; PASS=$((PASS+1));
  else echo "  ✗ $1 期望 $2 实得 $3"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "构建后端…"; (cd "$ROOT/backend" && npm run build >/dev/null 2>&1) || { echo "构建失败"; exit 1; }

echo "启动临时后端 (:${PORT})…"
(
  cd "$ROOT/backend"
  PORT="$PORT" CONFIG_ROOT_PATH="../config-runtime" JWT_SECRET="smoke-secret" \
  ADMIN_USERNAME="admin" ADMIN_PASSWORD="smoke123" DEBUG_INGEST_ENABLED="true" \
  node dist/index.js >/tmp/navfleet-smoke.log 2>&1
) &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; rm -f "$COOKIE"; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done

echo "运行断言:"
check "健康检查公开可访问"        200 "$(code "$BASE/health")"
check "就绪探针公开可访问"        200 "$(code "$BASE/health/ready")"
check "指标端点公开可访问"        200 "$(code "$BASE/metrics")"
check "OpenAPI 文档公开可访问"    200 "$(code "$BASE/openapi.json")"
check "未登录访问快照被拒"        401 "$(code "$BASE/api/fleet/snapshot")"
check "错误密码登录被拒"          401 "$(code -H 'Content-Type: application/json' -d '{"username":"admin","password":"nope"}' "$BASE/api/auth/login")"
check "正确登录成功"              200 "$(code -c "$COOKIE" -H 'Content-Type: application/json' -d '{"username":"admin","password":"smoke123"}' "$BASE/api/auth/login")"
check "登录后访问快照"            200 "$(code -b "$COOKIE" "$BASE/api/fleet/snapshot")"
check "会话信息 /me"             200 "$(code -b "$COOKIE" "$BASE/api/auth/me")"
check "场景列表(鉴权后)"          200 "$(code -b "$COOKIE" "$BASE/api/scenes")"
check "告警查询非法参数 400"      400 "$(code -b "$COOKIE" "$BASE/api/alerts?severity=fatal")"
check "调试注入(admin,已开启)"    200 "$(code -b "$COOKIE" -H 'Content-Type: application/json' -d '{"deviceId":"smoke-1","gps":{"lat":31.2,"lng":121.4}}' "$BASE/api/debug/ingest")"
check "登出"                    204 "$(code -b "$COOKIE" -X POST "$BASE/api/auth/logout")"

echo
echo "结果: ${PASS} 通过, ${FAIL} 失败"
[[ "$FAIL" -eq 0 ]]
