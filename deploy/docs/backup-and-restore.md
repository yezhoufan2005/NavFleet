# MongoDB 备份与恢复

NavFleet 的持久化数据（时序遥测 `telemetry_ts`、设备快照 `device_latest`、告警
`alerts`、用户 `users`）都存放在 `mongo` 容器的 `fleet_monitor` 库中。本文档说明
如何备份、恢复，以及现有的索引 / TTL 策略。

前提：使用 `deploy/docker-compose.yml` 部署，`mongo` 服务健康运行。脚本通过
`docker compose exec` 在容器内调用 `mongodump` / `mongorestore`，宿主机无需安装
MongoDB 工具。

## 备份

有两条路：一个**自动化容器**（推荐）和一个**手动脚本**。两者写到同一个目录，由
`BACKUP_HOST_PATH` 决定（默认 `./backups`，相对 `deploy/` 解析）。

### 自动化：备份叠加文件

```bash
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.backup.yml up -d
```

`mongo-backup` 容器按 `BACKUP_INTERVAL_SECONDS`（默认 86400）循环 `mongodump`，按
`BACKUP_RETENTION_DAYS`（默认 14）清理旧档 —— 只删符合自身命名规则的文件，因为那个目录是
宿主机挂载、可能还放着别的东西。它只接在 `data` 网段上，既碰不到 Web 层也没有出网能力。
变量说明见 [config-reference.md 8.5](./config-reference.md#85-备份叠加文件变量)。

这条路比下面的 cron 好在：不依赖宿主机上另一份定时任务，且保留策略与备份动作在同一处。

### 手动：一次性归档

```bash
# 默认导出到 BACKUP_HOST_PATH（未设则 deploy/backups/），文件名带时间戳
deploy/tools/mongo-backup.sh

# 或指定输出目录
deploy/tools/mongo-backup.sh /data/navfleet-backups
```

生成 `fleet_monitor-YYYYMMDD-HHMMSS.gz`（`mongodump --archive --gzip` 单文件归档）。
凭据默认取自 `deploy/.env`（`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`），
脚本不会回显密码。

### 定时备份（cron 示例）

已经启用上面的备份叠加文件时**不需要这一段**。仅在不想多跑一个容器时使用：

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

| 集合            | 索引 / 策略                                                                                                            | 说明                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `telemetry_ts`  | 时序集合（timeField=`ts`, metaField=`meta`），`expireAfterSeconds=TELEMETRY_RETENTION_SECONDS`（默认 30 天）           | 历史轨迹来源；到期自动清理 |
| `device_latest` | `{deviceId:1}` 唯一、`{stamp:-1}`                                                                                      | 每设备最新快照             |
| `alerts`        | `{deviceId:1, ts:-1}`、`{severity:1, active:1, ts:-1}`、`{lastSeenAt:1}` TTL=`ALERTS_RETENTION_SECONDS`（默认 180 天） | 告警查询与到期清理         |
| `users`         | `{username:1}` 唯一                                                                                                    | 账号                       |

保留时长通过环境变量调整（见 `backend/.env.example`）：`TELEMETRY_RETENTION_SECONDS`、
`ALERTS_RETENTION_SECONDS`。调大将增加磁盘占用，请结合备份策略与磁盘容量评估。

## 校验恢复可用性

「有备份」和「能恢复」是两件事。`deploy/tools/restore-drill.sh` 只证明后者，**且不写生产库**：

```bash
deploy/tools/restore-drill.sh                    # 默认取备份目录里最新的归档
deploy/tools/restore-drill.sh /path/to/archive.gz
```

它把归档用 `--nsFrom/--nsTo` 恢复到临时库 `fleet_monitor_restore_drill`，逐集合与生产库
对比文档数，然后把临时库删掉。只有「恢复成功且每个集合都非空」才返回 0，所以可以直接挂到
定时任务里当断言用。

查找目录与备份同源（`BACKUP_HOST_PATH`），不需要额外配置。

上面的 `mongo-restore.sh` 是**真恢复**，带 `--drop`；演练用这个脚本，不要用它。
