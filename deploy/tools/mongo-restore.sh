#!/usr/bin/env bash
# NavFleet MongoDB 恢复脚本
# 通过 docker compose 在 mongo 容器内运行 mongorestore，从 gzip 归档恢复整库。
# ⚠ 破坏性：使用 --drop 会先删除同名集合再导入，请务必确认目标环境。
# 用法:
#   deploy/tools/mongo-restore.sh <归档路径> [--yes]
# 环境变量同 mongo-backup.sh（MONGO_INITDB_ROOT_USERNAME/PASSWORD、MONGO_DB_NAME、COMPOSE）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "用法: $0 <归档路径> [--yes]" >&2
  echo "错误：找不到归档文件 '$ARCHIVE'" >&2
  exit 1
fi

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

echo "⚠ 即将把 '${ARCHIVE}' 恢复到数据库 '${MONGO_DB}'（--drop 会覆盖同名集合）。"
if [[ "$CONFIRM" != "--yes" ]]; then
  read -r -p "确认继续？输入 yes 继续： " reply
  if [[ "$reply" != "yes" ]]; then
    echo "已取消。"
    exit 0
  fi
fi

# --nsInclude 限定只恢复目标库；--drop 覆盖既有集合。密码经 env 传入容器。
$COMPOSE -f "$COMPOSE_FILE" exec -T \
  -e MONGO_PASS="$MONGO_PASS" \
  mongo sh -c \
  "mongorestore --quiet --archive --gzip --drop --nsInclude='${MONGO_DB}.*' --username='${MONGO_USER}' --password=\"\$MONGO_PASS\" --authenticationDatabase=admin" \
  < "$ARCHIVE"

echo "恢复完成。建议重启后端以重建内存快照：$COMPOSE -f \"$COMPOSE_FILE\" restart backend"
