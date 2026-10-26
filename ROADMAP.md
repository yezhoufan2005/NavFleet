# NavFleet 路线图

NavFleet 是一个只读的实时车队监控平台：MQTT 遥测 → 归一化 → 内存快照 → MongoDB 历史 →
REST/WebSocket → Vue 控制台。本文件回答两个问题：**现在是什么**，以及**往前走做什么、不做什么**。
它是现状与方向的唯一口径；实现细节见代码与 [ARCHITECTURE.md](ARCHITECTURE.md)，开发房规见
[docs/conventions.md](docs/conventions.md)。

两条不变的红线：**只读监控**（不向车辆下发任何控制指令）、**单实例内网**（无多租户、无水平扩展）。

## 当前状态

- **已发布 1.7.0**。部署的前端是 `frontend-next`（workspace `navfleet-console`，compose 服务 `web`）；
  旧 `frontend/` 已冻结，只保留作一行回滚，不再改动。发布镜像 `navfleet-backend` / `navfleet-console`。
- **工程门禁**：lint `--max-warnings 0` + type-aware；四个 workspace 各自 vitest 覆盖率门槛（只升不降）；
  E2E `retries: 0`；CI 跨 Node 22/24 跑后端+shared、两套前端、E2E 分片、部署接线与密钥扫描。
- **演示数据**：29 台车 / 6 编队 / 6 场景（`config-runtime/`）。

### 能力清单（按域）

| 域         | 能力                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 接入与实时 | MQTT（可选 TLS）遥测接入、归一化、内存快照、WebSocket 推送、GPS / 场景地图叠加                                  |
| 历史与报表 | MongoDB 时序历史、服务端聚合报表（可用率/电量、告警统计）、CSV 导出、定时邮件报表、kiosk 大屏值班               |
| 消息与告警 | 报码字典（内置表 ⊕ 部署码表）、告警确认落库与历史、告警规则、外发通知（webhook/企业微信/钉钉/邮件，默认不外发） |
| 权限与审计 | 真 RBAC（角色 / 用户组 / 能力门禁）、审计日志、令牌即时失效、登录锁定                                           |
| 运维与交付 | 设备接入向导（车辆/编队写盘）、场景地图上传、运维监控指标、多平台镜像 + SBOM + cosign 无密钥签名                |

## 进行中

- **全项目收敛**：去重（提取共享组件 / 组合式 / helper）、风格一致化（见 [docs/conventions.md](docs/conventions.md)）、
  文档对齐现状、演示数据真实化、已核实缺陷修复。**不新增功能**，分批独立 PR 推进。

## 计划中（需先出方案再动手）

- **数据模型检查与完善**：在前端细修收尾后统一做；设备实时页的 `formationIds` / `tags`、runtime-vs-default
  场景展示暂缓，待这轮数据模型一并定。

### 已识别的待办（不急，择机排期）

全项目收敛过程中识别、尚未动手的改进，按类归档，后续按批推进：

- **重构 / 去冗余**
  - 路由 `asyncHandler` 大扫除：Express 5 自动转发 async 异常，去掉各路由里冗余的 `try/catch + next(e)`。
  - 路由样板再提取：`auditFromRequest`、「裸数组/`{key:[]}`」解包、`validate→400`、CSV 列表 helper。
  - 前端 `useLatestRequest` + `useResourceList` / `UiAsyncState`：加载/错误/空三态与竞态守卫再收一层（跨约 14 个视图）。
  - 两套归一化（`backend/normalize.ts` 与 `fleet-core/fleetNormalize.ts`）的纯 helper 下沉 `@navfleet/shared`。
- **后端小隐患**
  - `persistence` 批量插入部分失败时整批重排队 → 重复遥测，`totalSamples` 虚高。
  - 场景资源上传 400/500 靠正则匹配报错文案 → 改按错误类型/码判。
  - `index.ts` 的 `bufferFlush` 定时器在 `shutdown()` 未清。
  - `fleetNormalize.mergeDevice` 的 `alerts` 字段无兜底（部分更新会清空告警）。
  - 删用户时不清其用户组成员资格（删后重建同名用户会重获旧组能力）。
  - `configRegistry.deriveBounds` 按轴对齐算场景边界、忽略 `origin.yaw`。
- **测试 / 健壮性**
  - `@navfleet/shared` 加 vitest 覆盖率门禁 + 把码表自洽性测试迁入；随后删 `fleet-core` 的死包装（`reportCodes` / `deviceTone`）。
  - `rbac/service` 的 update/delete-group 冲突分支、`notify/email` 发送路径补测。
  - 并发跑 coverage 的 5s 超时 flaky 稳定化（见 memory）。
- **演示数据**（目标：覆盖率高、真实性强，但不突兀——在线率/SOC 自然波动，不收敛、不规律尾升，能反映现实运营情况）
  - 按车型 `category` / `maxLoadKg` 的负载与电量画像（需把车辆配置并入种子）。
  - `seed-reports.ts` 电量曲线与 `verify-stack.sh` 的直灌种子对齐。
- **文档 / 杂项**
  - `/openapi.json`（`openapi.ts`）补 rbac / rules / reports-config / vehicles / scene-write 路由定义（ARCHITECTURE 已给按域概览，机器 spec 仍缺）。
  - `CHANGELOG.md` 1.7.0 段落的重复条目清理（release-please squash 产物，纯噪声）。

## 长期搁置（已识别，现在不做，不自行开工）

- 多厂商 / 多车型适配；`frontend-next` 更名；告警分区版式；`prom-client` → `@prometheus-io/client`
  （上游采用不足）；国际化 i18n（仅在有海外交付时做）。各项都有触发条件，到点再议。

## 明确不做（范围约束，不是待办）

- 控制下发、多租户、水平扩展 —— 红线。
- 删除冻结的 `frontend/`（留作一行回滚）。
- 注册 / 忘记密码（内网单实例，账号由管理员创建）。
