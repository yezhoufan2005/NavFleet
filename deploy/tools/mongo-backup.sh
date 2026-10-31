#!/usr/bin/env bash
# NavFleet MongoDB 备份脚本
# 通过 docker compose 在 mongo 容器内运行 mongodump，将整库导出为 gzip 压缩归档到宿主机。
# 用法:
#   deploy/tools/mongo-backup.sh [输出目录]
# 环境变量（可写在 deploy/.env）：
#   BACKUP_HOST_PATH           (默认 ./backups，相对 deploy/ 解析)
#   MONGO_INITDB_ROOT_USERNAME (默认 root)
#   MONGO_INITDB_ROOT_PASSWORD (默认 example)
#   MONGO_DB_NAME              (默认 fleet_monitor)
#   COMPOSE                    (默认 "docker compose")
#   NAVFLEET_PROJECT           compose 项目名（默认取正在运行的那个，见 compose-project.sh）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

# 载入 deploy/.env（如存在）以取得凭据，但不回显具体值。
if [[ -f "$DEPLOY_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DEPLOY_DIR/.env"
  set +a
fi

# 输出目录：显式参数 > BACKUP_HOST_PATH > ./backups。
#
# 之前这里只有 `${1:-$DEPLOY_DIR/backups}`，与 docker-compose.backup.yml 的
# `${BACKUP_HOST_PATH:-./backups}` 对不上：把 BACKUP_HOST_PATH 指到 NAS 的部署里，
# 容器备份进 NAS、手动备份进 deploy/backups，而恢复演练只看一个地方 —— 手动那份
# 从此对演练不可见。三者现在同一个来源。
OUT_DIR="${1:-${BACKUP_HOST_PATH:-./backups}}"
if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$DEPLOY_DIR/${OUT_DIR#./}"
fi

MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-root}"
MONGO_PASS="${MONGO_INITDB_ROOT_PASSWORD:-example}"
MONGO_DB="${MONGO_DB_NAME:-fleet_monitor}"
COMPOSE="${COMPOSE:-docker compose}"
# shellcheck source=compose-project.sh
source "$SCRIPT_DIR/compose-project.sh"
resolve_compose_project

mkdir -p "$OUT_DIR"
# UTC, like backup-loop.sh, so the two kinds of archive sort together by name.
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/${MONGO_DB}-${STAMP}.gz"

echo "备份数据库 '${MONGO_DB}' → ${ARCHIVE}"
# 先写 .partial，成功后再改名：mongodump 中途失败时，重定向已建出的半截文件不能留成「最新的备份」，
# 恢复演练按时间取最新的 *.gz。
trap 'rm -f "$ARCHIVE.partial"; [[ -z "${CONFIG_ARCHIVE:-}" ]] || rm -f "$CONFIG_ARCHIVE.partial"' EXIT
# -T 关闭 TTY 分配，使容器 stdout 能重定向到宿主机文件。密码经 env 传入容器，不出现在进程列表/日志。
$COMPOSE -f "$COMPOSE_FILE" exec -T \
  -e MONGO_PASS="$MONGO_PASS" \
  mongo sh -c \
  "mongodump --quiet --archive --gzip --username='${MONGO_USER}' --password=\"\$MONGO_PASS\" --authenticationDatabase=admin --db='${MONGO_DB}'" \
  > "$ARCHIVE.partial"
mv "$ARCHIVE.partial" "$ARCHIVE"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "完成：${ARCHIVE} (${SIZE})"

# 盘上配置（车辆/编队/场景与底图/码表/规则/外发/定时报表）不在库里，只恢复数据库会得到一堆找不到
# 对应车辆和场景的记录，所以同一时间戳一并打包。`.tgz` 而不是 `.gz`：restore-drill.sh 取最新的
# `*.gz` 当数据库归档。`.last-good/` 是后端自己的兜底副本，下次成功加载会重建。
CONFIG_DIR="${CONFIG_RUNTIME_HOST_PATH:-../config-runtime}"
if [[ "$CONFIG_DIR" != /* ]]; then
  CONFIG_DIR="$DEPLOY_DIR/$CONFIG_DIR"
fi
if [[ -d "$CONFIG_DIR" ]]; then
  CONFIG_ARCHIVE="$OUT_DIR/${MONGO_DB}-${STAMP}.config.tgz"
  tar -czf "$CONFIG_ARCHIVE.partial" --exclude=./.last-good -C "$CONFIG_DIR" .
  mv "$CONFIG_ARCHIVE.partial" "$CONFIG_ARCHIVE"
  echo "配置：${CONFIG_ARCHIVE} ($(du -h "$CONFIG_ARCHIVE" | cut -f1))"
else
  echo "⚠ 找不到配置目录 ${CONFIG_DIR}，本次只备份了数据库" >&2
fi
echo "提示：请将归档同步到异地/对象存储，并按保留策略清理旧备份（如保留最近 14 份）。"
