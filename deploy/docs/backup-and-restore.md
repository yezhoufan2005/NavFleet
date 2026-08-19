# MongoDB 备份与恢复

NavFleet 的持久化数据（时序遥测 `telemetry_ts`、设备快照 `device_latest`、告警
`alerts`、用户 `users`）都存放在 `mongo` 容器的 `fleet_monitor` 库中。本文档说明
如何备份、恢复，以及现有的索引 / TTL 策略。

前提：使用 `deploy/docker-compose.yml` 部署，`mongo` 服务健康运行。脚本通过
`docker compose exec` 在容器内调用 `mongodump` / `mongorestore`，宿主机无需安装
MongoDB 工具。

## 备份

```bash
# 默认导出到 deploy/backups/，文件名带时间戳
deploy/tools/mongo-backup.sh

# 或指定输出目录
deploy/tools/mongo-backup.sh /data/navfleet-backups
```

生成 `fleet_monitor-YYYYMMDD-HHMMSS.gz`（`mongodump --archive --gzip` 单文件归档）。
凭据默认取自 `deploy/.env`（`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`），
脚本不会回显密码。

### 定时备份（cron 示例）

```cron
# 每日 03:17 备份，并保留最近 14 份
17 3 * * * /opt/navfleet/deploy/tools/mongo-backup.sh /data/navfleet-backups \
  && ls -1t /data/navfleet-backups/fleet_monitor-*.gz | tail -n +15 | xargs -r rm --
```

建议再将归档同步到异地 / 对象存储（rsync、rclone、云 CLI 等），避免与数据库同机丢失。

## 恢复

> ⚠ **破坏性操作**：`--drop` 会先删除同名集合再导入。请确认目标环境无误。

```bash
deploy/tools/mongo-restore.sh deploy/backups/fleet_monitor-20260819-031700.gz
# 非交互（脚本/自动化）可加 --yes 跳过确认
deploy/tools/mongo-restore.sh <归档> --yes
```

恢复后建议重启后端以重建内存快照：

```bash
docker compose -f deploy/docker-compose.yml restart backend
```

## 索引与 TTL 复核

以下由后端在启动时自动创建（`backend/src/persistence.ts` 的 `ensureMongoCollections`），
无需手动维护，但可据此规划容量与保留：

| 集合 | 索引 / 策略 | 说明 |
| --- | --- | --- |
| `telemetry_ts` | 时序集合（timeField=`ts`, metaField=`meta`），`expireAfterSeconds=TELEMETRY_RETENTION_SECONDS`（默认 30 天） | 历史轨迹来源；到期自动清理 |
| `device_latest` | `{deviceId:1}` 唯一、`{stamp:-1}` | 每设备最新快照 |
| `alerts` | `{deviceId:1, ts:-1}`、`{severity:1, active:1, ts:-1}`、`{lastSeenAt:1}` TTL=`ALERTS_RETENTION_SECONDS`（默认 180 天） | 告警查询与到期清理 |
| `users` | `{username:1}` 唯一 | 账号 |

保留时长通过环境变量调整（见 `backend/.env.example`）：`TELEMETRY_RETENTION_SECONDS`、
`ALERTS_RETENTION_SECONDS`。调大将增加磁盘占用，请结合备份策略与磁盘容量评估。

## 校验恢复可用性

定期做一次「恢复演练」：在测试环境用最新归档执行 `mongo-restore.sh`，启动后端后访问
`/health/ready`（`checks.mongo=true`）与前端历史回放，确认数据可读。
