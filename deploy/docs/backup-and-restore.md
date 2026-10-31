# MongoDB 备份与恢复

NavFleet 的持久化数据（遥测与报表汇总、设备快照、消息、外发记录、用户与会话、自定义角色与用户组、
审计日志，完整列表见文末的索引表）都存放在 `mongo` 容器的 `fleet_monitor` 库中。本文档说明如何备份、
恢复，以及现有的索引 / TTL 策略。

前提：使用 `deploy/docker-compose.yml` 部署，`mongo` 服务健康运行。脚本通过
`docker compose exec` 在容器内调用 `mongodump` / `mongorestore`，宿主机无需安装
MongoDB 工具。

三个脚本（`mongo-backup.sh`、`mongo-restore.sh`、`restore-drill.sh`）自动找正在运行的那个 compose
项目：直接 `docker compose -f deploy/docker-compose.yml` 起的栈项目名是 `deploy`，`verify-stack.sh`
起的是 `navfleet`。两个同时在跑时脚本会拒绝并要求指定，用 `NAVFLEET_PROJECT=<项目名>` 指定即可。

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

生成 `fleet_monitor-YYYYMMDD-HHMMSS.gz`（`mongodump --archive --gzip` 单文件归档），以及同一时间戳的
`fleet_monitor-YYYYMMDD-HHMMSS.config.tgz`（盘上配置目录 `CONFIG_RUNTIME_HOST_PATH`，见下）。
时间戳是 UTC，与备份容器写的同名。凭据默认取自 `deploy/.env`（`MONGO_INITDB_ROOT_USERNAME` /
`MONGO_INITDB_ROOT_PASSWORD`），经容器环境变量传入，不出现在命令行和进程列表里。归档先写成
`.partial`，成功后才改成正式文件名，所以失败的备份不会留下半截的「最新备份」。

### 定时备份（cron 示例）

已经启用上面的备份叠加文件时**不需要这一段**。仅在不想多跑一个容器时使用：

```cron
# 每日 03:17 备份，数据库归档与配置包都保留最近 14 份
17 3 * * * /opt/navfleet/deploy/tools/mongo-backup.sh /data/navfleet-backups \
  && ls -1t /data/navfleet-backups/fleet_monitor-*.gz | tail -n +15 | xargs -r rm -- \
  && ls -1t /data/navfleet-backups/fleet_monitor-*.config.tgz | tail -n +15 | xargs -r rm --
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

### 盘上配置

车辆、编队、场景与底图、码表、消息规则、外发、定时报表都存在盘上的配置目录里，不在库里。只恢复
数据库会留下一批找不到对应车辆和场景的记录，所以两种备份都会把配置目录按同一时间戳打包成
`*.config.tgz`（不含后端自己的兜底副本 `.last-good/`）。恢复时用**同一时间戳**那份，先停后端再解包：

解包目标是实际挂载给后端的配置目录 `CONFIG_RUNTIME_HOST_PATH`（相对 `deploy/` 解析，默认
`../config-runtime`），不是仓库里的 `config-runtime`：

```bash
docker compose -f deploy/docker-compose.yml stop backend
CONFIG_DIR="$(cd deploy && realpath "${CONFIG_RUNTIME_HOST_PATH:-../config-runtime}")"
tar -xzf deploy/backups/fleet_monitor-20260819-031700.config.tgz -C "$CONFIG_DIR"
docker compose -f deploy/docker-compose.yml start backend
```

### 版本对应

库里记着结构版本（`schema_migrations` 集合）。把**新版本**的备份恢复到**旧版本**的后端上，后端会拒绝
启动并在日志里写明库的版本和自己认识的最高版本，而不是带着看不懂的字段继续跑。处理办法：换回写出这份
备份的版本，或者改用当前版本时期的备份。旧备份恢复到新版本没有问题，启动时会自动补跑迁移。

## 索引与 TTL 复核

以下由后端在启动时自动创建（`backend/src/persistence.ts` 的 `ensureMongoCollections`），
无需手动维护，但可据此规划容量与保留：

| 集合                    | 索引 / 策略                                                                                                                               | 说明                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `telemetry_ts`          | 时序集合（timeField=`ts`, metaField=`meta`），`{meta.deviceId:1, ts:1}`；TTL=`TELEMETRY_RETENTION_SECONDS`（默认 30 天）                  | 历史轨迹来源；到期自动清理         |
| `telemetry_hourly`      | `{deviceId:1, hour:1}`、`{hour:1}` TTL=`TELEMETRY_ROLLUP_RETENTION_SECONDS`（默认 180 天）                                                | 报表用的小时汇总；可由原始遥测重算 |
| `telemetry_hourly_runs` | `{hour:1}` TTL=`TELEMETRY_ROLLUP_RETENTION_SECONDS`                                                                                       | 小时汇总的运行记录                 |
| `device_latest`         | `{deviceId:1}` 唯一、`{stamp:-1}`                                                                                                         | 每设备最新快照                     |
| `alerts`                | `{deviceId:1, ts:-1}`、`{severity:1, active:1, ts:-1}`、`{firstSeenAt:1}`、`{lastSeenAt:1}` TTL=`ALERTS_RETENTION_SECONDS`（默认 180 天） | 消息查询与到期清理                 |
| `notify_log`            | `{deviceId:1, ts:-1}`、`{channelId:1, ts:-1}`、`{status:1, ts:-1}`、`{expireAt:1}` TTL=`ALERTS_RETENTION_SECONDS`                         | 外发记录；没配外发时为空           |
| `users`                 | `{username:1}` 唯一                                                                                                                       | 账号                               |
| `sessions`              | `{sessionId:1}` 唯一、`{username:1, createdAt:-1}`、`{expiresAt:1}` TTL（按会话自身到期时间）                                             | 登录会话                           |
| `rbac`                  | 单个文档（`_id: "state"`），无额外索引                                                                                                    | 自定义角色与用户组                 |
| `audit_log`             | `{actor:1, ts:-1}`、`{action:1, ts:-1}`、`{ts:-1}` TTL=`AUDIT_RETENTION_SECONDS`（默认 365 天）                                           | 审计日志                           |
| `schema_migrations`     | `{version}`（迁移标记）                                                                                                                   | 已应用的 schema 版本记录           |

保留时长通过环境变量调整（见 `deploy/.env.example`）：`TELEMETRY_RETENTION_SECONDS`、
`TELEMETRY_ROLLUP_RETENTION_SECONDS`、`ALERTS_RETENTION_SECONDS`（也决定外发记录的保留）、
`AUDIT_RETENTION_SECONDS`。**1.2.0 起，改这些值对已建库也生效**：后端每次连接会把各 TTL 索引收敛到
配置值（`collMod`，见 `backend/src/migrations/ttl.ts`），所以调整后重启即生效。调大将增加磁盘占用，
请结合备份策略与磁盘容量评估。

## 校验恢复可用性

「有备份」和「能恢复」是两件事。`deploy/tools/restore-drill.sh` 只证明后者，**且不写生产库**：

```bash
deploy/tools/restore-drill.sh                    # 默认取备份目录里最新的归档
deploy/tools/restore-drill.sh /path/to/archive.gz
```

它把归档用 `--nsFrom/--nsTo` 恢复到临时库 `fleet_monitor_restore_drill`，逐集合与生产库
对比文档数，然后把临时库删掉。返回 0 的条件是：恢复没有报错、没有恢复失败的文档、至少恢复出一个
集合和一条文档，且同一时间戳的配置包（存在时）可以读出。可以直接挂到定时任务里当断言用。

空集合本身不算失败：后端启动时会建好所有集合，没用过的功能（例如没配外发时的 `notify_log`）备份出来
就是空的。脚本会把空集合列出来，由人判断是否符合预期。缺配置包只给警告。

查找目录与备份同源（`BACKUP_HOST_PATH`），不需要额外配置。

上面的 `mongo-restore.sh` 是**真恢复**，带 `--drop`；演练用这个脚本，不要用它。
