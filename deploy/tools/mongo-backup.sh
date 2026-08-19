#!/usr/bin/env bash
# NavFleet MongoDB 备份脚本
# 通过 docker compose 在 mongo 容器内运行 mongodump，将整库导出为 gzip 压缩归档到宿主机。
# 用法:
#   deploy/tools/mongo-backup.sh [输出目录]
# 环境变量（可写在 deploy/.env）：
#   MONGO_INITDB_ROOT_USERNAME (默认 root)
#   MONGO_INITDB_ROOT_PASSWORD (默认 example)
#   MONGO_DB_NAME              (默认 fleet_monitor)
#   COMPOSE                    (默认 "docker compose")
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
OUT_DIR="${1:-$DEPLOY_DIR/backups}"

# 载入 deploy/.env（如存在）以取得凭据，但不回显具体值。
if [[ -f "$DEPLOY_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DEPLOY_DIR/.env"
  set +a
fi

MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-root}"
MONGO_PASS="${MONGO_INITDB_ROOT_PASSWORD:-example}"
MONGO_DB="${MONGO_DB_NAME:-fleet_monitor}"
COMPOSE="${COMPOSE:-docker compose}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/${MONGO_DB}-${STAMP}.gz"

echo "备份数据库 '${MONGO_DB}' → ${ARCHIVE}"
# -T 关闭 TTY 分配，使容器 stdout 能重定向到宿主机文件。密码经 env 传入容器，不出现在进程列表/日志。
$COMPOSE -f "$COMPOSE_FILE" exec -T \
  -e MONGO_PASS="$MONGO_PASS" \
  mongo sh -c \
  "mongodump --quiet --archive --gzip --username='${MONGO_USER}' --password=\"\$MONGO_PASS\" --authenticationDatabase=admin --db='${MONGO_DB}'" \
  > "$ARCHIVE"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "完成：${ARCHIVE} (${SIZE})"
echo "提示：请将归档同步到异地/对象存储，并按保留策略清理旧备份（如保留最近 14 份）。"
