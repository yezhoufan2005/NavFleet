# NavFleet 升级路线图 · v3（Phase 11–18）

**起点是 v1.0.0（2026-08-29）** —— 后续所有改动都从那里开始。v1.0.0 之前的阶段计划与执行记录已
搬到 [docs/roadmap-archive.md](docs/roadmap-archive.md)，本文件只讲往前走的路。

目标：把 v1.0.0 这个干净但功能保守的基准版，做成一款有竞争力的车队监控产品。

两条不变的红线：**只读监控**（无控制下发）、**单实例内网**（无多租户 / 无水平扩展）。

工作方式：每个 PR = 独立分支 → 实现 → 本地自检（lint / format / typecheck / test / build）→ 推送 →
CI 全绿 → `--no-ff` 合并 → 回写本文件并记录自检结果。

图例：`[ ]` 待办 · `[~]` 进行中 · `[x]` 完成（附自检）

## 起点：2026-08-29 的第二轮审计

v1.0.0 的架构分层与文档质量已经超出多数同规模项目，但四路审计（后端健壮性 / 前端技术债 /
测试门禁 / 部署运维）加一轮鉴权与领域模型复审，暴露出三件事，它们共同定义了 v3 的范围：

1. **RBAC 是名义上的。** `requireRole` 在全仓库只有一处调用，且那条路由默认关闭、生产环境直接拒绝
   启动。也就是说生产部署下 `admin` / `operator` / `viewer` 三个角色权限完全相同，前端也没有任何
   角色门禁（无 `meta.roles`、无按角色隐藏的操作）。**没有任何用户管理 API，连改密码都没有**——
   用户唯一来源是环境变量种子的单个管理员，加第二个人只能直接写数据库。登出不使已签发的 token
   失效。零审计日志。告警确认只存在浏览器本地，不落库、不跨人、无操作人无时间。
   → **v1.0.0 实质是「口令保护的看板」，不是多用户系统。** README:43 / :59 声称的 RBAC 属于过度
   承诺，随 Phase 15 一并修正。
2. **大量已采集数据从未被产品利用。** `alerts` 集合的 `firstSeenAt` / `lastSeenAt` / `clearedAt` /
   `active=false` 全部落库却零读取方，`/api/v1/alerts` 端点存在而前端从不调用；`telemetry_ts` 落库
   17 个 measurements，历史面板只渲染 5 个；`tags` / `formation.description` / `extra.temperature` /
   `networkQuality` / `vehicleModel` / `summary.gpsCount` 全链路搬运却零展示。**报码字典根本不存在**
   ——现存 4 个报码只是 mock 与 e2e 里的演示常量。→ 这是 v3 里最便宜的一批竞争力。
3. **前端主体来自最初的手搓 demo。** 12 个 SFC 全部无 `lang="ts"`（约 2,300 行逻辑在 `vue-tsc` 视野
   外），零图表组件，单一视口无响应式审计，信息架构是「一个塞满的仪表盘 + 三个附属页」。

另有五处运行时健壮性缺陷（详见 P0 批次），其中一处会导致进程退出，已列为最高优先级。

> **关于缺陷条目的写法**：本仓库是公开的，所以未修复缺陷在这里只写「是什么 / 在哪个模块 /
> 影响等级 / 要做什么」，不写触发条件与利用路径 —— 那些留在工作会话与本地笔记里。修复合并后
> 可以在执行记录中完整说明。

## 已确认的决策（2026-08-29 与项目负责人对齐）

| #   | 决策                                                                | 依据                                                                                         |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **数据范围隔离暂不做**（用户组只能看指定编队/场景），等确有客户要求 | 每个读接口都要带范围裁剪 + WS 广播裁剪，测试面显著变大，收益待验证；核心与实际需要的功能照做 |
| 2   | 设计系统底座 = **无头库 Reka UI + Tailwind + 自建 token 层**        | 不撞脸中后台模板；a11y 底座（焦点管理/键盘/ARIA）免费拿，契合已有 axe serious/critical 门禁  |
| 3   | 图表 = **ECharts**                                                  | 负责人熟悉；Phase 12D 留下性能基线，出现瓶颈再评估 uPlot                                     |
| 4   | **IA 重构**，但重构前先充分调研评估                                 | Phase 11 全部是调研与设计，不写产品代码；逐步推进而非一次性掀翻                              |
| 5   | **先焕新前端 → 负责人验收调整 → 再补齐功能**                        | 待补的功能大部分需要新页面（用户管理/报表/规则配置），在旧前端上做等于做两遍                 |
| 6   | 五个 P0 缺陷按合理时机穿插，不等阶段边界                            | 它们是缺陷而非功能，各自的合理时机见 P0 批次                                                 |

## 发版节奏

| 版本      | 内容                                                 | 时机               |
| --------- | ---------------------------------------------------- | ------------------ |
| **1.0.1** | P0-a 修复（hotfix）                                  | 立刻，不等任何阶段 |
| **1.0.2** | 后端健壮性批次（P0-b～P0-e + 优雅关闭）              | 与 Phase 12 并行   |
| **1.1.0** | 新前端替换旧前端                                     | Phase 14 收口      |
| **1.2.0** | 用户 / 用户组 / 真 RBAC / 审计（含 schema 迁移机制） | Phase 15 收口      |
| **1.3.0** | 告警体系深化（ack 落库 / 历史 / 规则 / 外发）        | Phase 16 收口      |
| **1.4.0** | 报表与数据价值（聚合 / 导出 / 大屏）                 | Phase 17 收口      |

发版顺序有一条从 v1.0.0 学到的纪律：**先发镜像、再建 Release**。那次顺序反了，说明文档里的镜像
地址一度指向尚不存在的产物。

## P0 缺陷批次（穿插，不占用阶段序号）

### P0-a — WebSocket 连接异常可致进程退出 ✅ 完成（v1.0.1 已发布）

`backend/src/websocket.ts` 没有为客户端连接和 server 注册 `error` 监听器。Node 的 EventEmitter 在
没有 `error` 监听器时会把错误抛出，而进程级 `uncaughtException` 处理器的动作是关闭并退出 ——
于是一个连接层面的异常就足以终止后端。**影响：可用性，高。**

- [x] `client.on("error")` + `wsServer.on("error")`，记日志并只清理受影响的那一条连接；另加
      `socket.on("error")` 到 upgrade 处理器 —— 那个 socket 还没交给 `ws`，此前没有任何监听方
- [x] `WebSocketServer` 显式设置 `maxPayload` 为 64 KiB（库默认 100 MiB）。故意不做成配置项：
      入站协议只有 `{"type":"ping"}` 一种形态，没有部署有理由去调它
- [x] 回归测试：连接层异常发生后进程仍在、其他客户端不受影响
- 自检 ✅（2026-08-29，PR #67）：两个用例**修复前让整个文件红**而不是某条断言失败 —— vitest 把它们
  报成 uncaught exception 并以 1 退出，与缺陷在生产里的行为一致（`Errors 2 errors`）；修复后
  `15 passed`、零 uncaught error。后端测试 280 → 282，`websocket.ts` 覆盖率 97.27% statements /
  100% functions，总覆盖率 82.76/81.99/85.27/82.76（ratchet 80/79/82/80）；E2E 17/17 走真实 socket。

### P0-b～P0-e — 后端健壮性批次（1.0.2，与 Phase 12 并行）

放在这里的理由：全部在后端，与前端焕新零冲突；而新前端开发期正好需要一个不会莫名重启的后端。

- [ ] **P0-b 摄入无背压。** `store.ts` 的变更串行链没有长度上限，且每条消息的处理成本随设备总数
      线性增长（两次全量 Map 复制 + 一次全设备排序的快照重建，**而那个快照的返回值在调用处被直接
      丢弃**）。先摘掉这处纯浪费，再加有界队列 + 满时策略（丢最旧 / 采样）+ 队列深度与丢弃计数
      指标 + Grafana 面板与告警规则。放大项：`persistence.ts` 只设了 `serverSelectionTimeoutMS`，
      数据库半死时每条消息的写操作都在这条串行链上排队。**影响：稳定性，高。**
- [ ] **P0-c 数据库断连期间遥测丢失。** `persistence.ts` 在连接为空时直接返回，**不进缓冲**；缓冲
      溢出时静默丢弃最旧数据且**没有计数器**，监控面板上看不到任何丢失痕迹。→ 断连也进缓冲、
      溢出计数上指标、定时刷盘（现在只在下一次写入成功后被动触发）。**影响：数据完整性，高。**
- [ ] **P0-d 内存无上界。** `src/` 内不存在任何 `Map.delete()`，设备一旦进入内存永不移出；四个
      按设备键的结构都没有数量上限。容器内存限额 512M，OOM 后由 restart 策略拉起、内存态全丢。
      → 设备标识的格式与长度约束 + 未知设备数量上限 + 长期未上报设备的淘汰 + 淘汰计数指标。
      **影响：可用性，高。**
- [ ] **P0-e 全量替换语义过宽。** 归一化器支持一种「整体替换」的载荷形态，对只读监控没有正当
      用途。→ 收敛为仅调试摄入接口可用。**影响：数据完整性，中。**
- [ ] **优雅关闭补全。** MQTT client 从不 `end()`（`connectMqtt` 的返回值在入口处被丢弃），收到
      SIGTERM 后 broker 仍在投递；不 drain 变更串行链；缓冲中的遥测不刷盘（最多 2000 条随进程
      消失）；WS 关闭不带 1001 码、不等握手完成。另 compose 未设 `stop_grace_period`（Docker 默认
      10s）。**影响：数据完整性，中。**

### P0-f — 工程门禁（随 1.1.0，Phase 14 之后）

推到旧前端下线之后的理由：type-aware lint 会在两套前端上各产生一遍修复工作，等下线后做只需修一次。

- [ ] ESLint 启用 `recommendedTypeChecked` —— 现在三份配置全是 `recommended`，
      `no-floating-promises` / `no-misused-promises` / `await-thenable` **全不生效**，而 P0-a 与 P0-b
      恰是这个规则集专抓的那一类（async 事件回调、被丢弃的 Promise）
- [ ] `--max-warnings 0` —— `no-unused-vars` 三处都降为 `warn` 且全仓无 `--max-warnings`，
      warning 永不让 CI 红，等于没配
- [ ] Playwright CI `retries: 1` → 0，flaky 不再被重跑掩盖
- [ ] `packages/shared` 纳入 lint（根 `eslint.config.mjs:23` 显式 ignore）、e2e 纳入 `format:check`
- [ ] 覆盖率近零区补测：后端 `persistence.ts` 42.6%（3 例）/ `store.ts` 57.4%（**2 例**）
- [ ] tsconfig 补 `noUncheckedIndexedAccess` 等严格开关（四份配置现在只开了 `strict`）

## Phase 11 — 前端焕新：调研与设计（**不写产品代码**）

> 目标：在动手之前把「新前端长什么样、凭什么说它更好、怎么证明它不比旧的少功能」三个问题答完。
> 本阶段唯一产出是文档与原型；负责人评审通过才进入 Phase 12。

### PR 11A — 现状穷举与功能等价基线

- [x] 把现有 4 页的**全部**功能点、数据绑定、交互态、空态穷举成清单（含右侧详情面板的每一个字段、
      地图的 pan/zoom/定位/适应场景/视图记忆）—— **338 项**。盘点纠正了本条目自身的三处错误认知：
      仪表盘没有任何筛选/搜索/排序控件、**快捷键一个都不存在**、**告警抽屉不存在**（`alert-drawer.css`
      161 行仍被 import 但标记不在任何 `.vue` 里，是死 CSS）
- [x] 标注每一项的去留：🟢 保留 / 🟡 改造 / 🔴 废弃，另加 ⚠️ 缺陷一档 —— 盘点中发现 **30 处缺陷**，
      它们是**反向**目标（照抄就是失职），单列第 9 节并按影响排序
- [x] 产出 [docs/frontend-parity.md](docs/frontend-parity.md)（737 行）—— 这份清单就是 Phase 14 的验收 checklist
- 自检 ✅（2026-08-29，PR #71）：四路并行盘点（仪表盘 / 两类地图 / 历史与告警 / 外壳与全局机制），
  逐文件读取共 12 个 SFC + 8 个 composable + store + 22 个 CSS partial，全部条目可回溯 `file:line`。
  最有价值的一项发现：现有 17 例 e2e **零 `data-testid`**、全部用 `getByRole` + 中文可访问名匹配，
  所以只要新前端保持相同语义结构与文案，这 17 例能一字不改复用 —— 「新前端是否功能等价」因此有客观判据，
  不靠人眼比对。`prettier --check` 通过；无代码改动。

### PR 11B — 角色任务流与竞品调研

- [x] 六类角色 24 项任务流，步数逐条对着代码数过 —— **11 项可完成、13 项做不到**，而可完成的 11 项里
      6 项集中在值班调度与设备定位（即 v1.0.0 真正做完的那部分）。这张表就是"功能保守"的量化形式
- [x] 竞品 IA 调研：Grafana Saga 导航规则、Datadog 侧栏分区逻辑、仓储机器人看板设计经验、墙面看板规则、
      车队 SaaS 通用模式 —— 提炼出 **8 条硬约束**（C1–C8）带进 11C
- [x] 产出 [docs/frontend-research.md](docs/frontend-research.md)（231 行）
- 自检 ✅（2026-08-29，PR #72）：文中四条承重断言重新对着代码核过 —— `persistence.ts` 零
  `aggregate`/`$group`、`routes/fleet.ts` 与 `routes/scenes.ts` 读 `request.user` **0 次**、
  chokidar 只监听 4 个 JSON + `**/*.osm`（`.pcd` 与 `.svg` 不在其中）、4 个报码只出现在
  `mock-mqtt.ts` / `e2e/support/seed.ts` / `validation.test.ts`（`src` 与 `config-runtime` 零命中）。
  `prettier --check` 通过；无代码改动。
- **调研否掉了两个我原先的想法**，两者都写进了 11C 的待拍板项：
  1. **「态势 = 全屏地图为主体」可能是错的。** 公开的仓储机器人看板设计经验：实时坐标全铺是厂商默认
     做法，而管 40 台以上的主管**第一周之内就不再看那个画面**；有效做法是主屏 4-5 个信号 +「现在需要
     处理的那 3-4 台车」。我倾向把地图降为独立分区、总览做默认首屏，但这与本路线图已写的方案冲突，
     需要负责人拍板。同时要注意规模差异：6 台时地图完全看得过来，200 台时才是上述情形。
  2. **「大屏模式就是再做一个宽屏页面」是错的。** 墙面看板的硬规则是不可交互 + **不能有会话超时**，
     而我们是 15 分钟 access token + fire-and-forget 刷新 —— 挂三个月的屏会在某次静默失败后停在一个
     永不更新的画面上**且看不出来**。所以 17C 的难点在凭据与新鲜度可见性，不在布局。

### PR 11C — IA 与信息层级设计

- [x] 分区取舍：七个候选减到 **5 个一级项**。拿掉两个 —— **大屏**不是分区而是模式（不可交互 + 无会话
      超时，所以是 `/wall` 独立入口 + kiosk 凭据，不进导航）；**设备详情**不是一级项而是 `/devices/:id`
      详情路由（提到一级等于按"我们有设备这种数据"分区，违反按工作流分区那条）。另合并：历史回放并入
      设备详情的 tab —— 它现在是独立页，代价正是那条排故流程里"重新选一次设备"的一半
- [x] 导航模型：**左侧栏三态 + 细顶栏**（理由具体：16:9 屏上垂直像素比水平稀缺，而地图与曲线吃高度；
      顶栏要 56–64px 通高，侧栏收起只占 44px 通宽）+ 自动生成的面包屑 + 跨分支"返回上一处"
- [x] URL：**建议迁 web history**，代价写清（前端镜像加 nginx conf `try_files` + 边缘 `location /` 同步 + 两处安全响应头）。必须现在定而非等 Phase 14，因为属部署改动
- [x] 响应式：一条刻度 768 / 1024 / 1280 / 1536 / 1920 / 2560（wall）取代四个凭手感的断点；axe 从
      单一 1440×900 扩到含 1024 与 2560
- [x] 产出 [docs/frontend-ia.md](docs/frontend-ia.md) + 低保真线框
      [docs/frontend-ia-options.html](docs/frontend-ia-options.html)（三个候选 × 灰阶线框 + 导航树 +
      任务流影响）。**注意**：本会话的 Artifact 发布不可用（鉴权走 `ANTHROPIC_AUTH_TOKEN`，与 claude.ai
      登录互斥），所以线框改为仓库内独立 HTML，`open docs/frontend-ia-options.html` 即可评审
- 自检 ✅（2026-08-29，PR #74）：线框页在 Chrome 实测 —— 明暗双主题都从 token 取色（body 背景显式设置，
  浅色 `rgb(239,243,242)` / 深色 `#0a141a`）、IBM Plex 三体确认真实加载（非回落）、1280 与 820 两个
  宽度下页面**零横向滚动**、`.scroll` 容器兜住两张宽表；标签配对经容错正则核对（prettier 会把闭合
  标签换行，`</span>` 这类要按 `</span\s*>` 匹配才数得对）。修掉两处自造缺陷：`.vlist li` 用 flex
  导致 `<strong>` 与后续文本被排成两列；`text-transform: uppercase` 把标签里的 `/wall` 写成 `/WALL`
- **11C 定稿 ✅（2026-08-29，PR #75）**：负责人四项决定 —— ① 采用候选 **B**（总览为默认落地页，
  地图降为 `/devices` 的一个视图）② **做规模退化，阈值 40 台**（我先前给的 24 是估的，改用调研里唯一
  的实测值；列表侧 200 台 34.5ms 不构成约束）③ **迁 web history**（部署工作项已写进 PR 12B）
  ④ **做声音提醒**（要点已写进 PR 13D）。`docs/frontend-ia.md` 第 5 节改写为决定记录，线框页同步为
  定稿态；13A 标题按决定 B 从「态势视图（地图为主体）」更正为「设备分区：列表 ⇄ 地图两个视图」。

### PR 11D — 设计系统设计

- [x] token 体系：三层（原始色阶 → 语义 → 组件，第三层设准入门槛防硬编码 rgba 回流）。原始层
      **6 条 ramp × 12 阶 = 72 个 oklch 值，由脚本生成**；字阶 10 档 + 大屏另一套 5 档；间距以
      `--spacing: 4px` 为基准；层级 4 档、动效 3 条曲线、断点 6 档
- [x] `-contrast` / `-ink` 的区分从两个特例**升级为对每个状态色都成立的规则** —— 并且第一版被机检
      打回：`oklch` 的感知均匀明度**不等于** WCAG 亮度比（`L 0.55` 对 `L 0.20` 只有约 3.7:1），
      实心表面用 `X-600` + 前景 `X-950` 时 14 组里红了 4 组。改为表面 `700/300`、前景 `25/950` 后
      浅色 14/14 最低 4.62:1、深色 14/14 最低 5.58:1
- [x] Tailwind v4 接入方案，含一条枢纽结论：**语义 token 必须进 `@theme` 但绝不能用 `@theme inline`**
      —— `inline` 会把值嵌进工具类，于是按主题重定义 token 就失效，表现为"深色主题下颜色完全不切换"；
      另需把 `dark:` 变体重绑到 `[data-theme]`，但绝大多数场景不该用 `dark:`（语义 token 已吸收主题差异）
- [x] CSS 体积预算 **gzip ≤ 14 KB**（现状实测基线 36.4 KB 未压缩 / 7.7 KB gzip），并写明超预算时
      先查三类成因而不是提高预算
- [x] 组件清单：Reka UI 40 个 primitive 里**采用 14 个**（列出各自替掉现在的什么）、备选 3 个、
      明确自建的 5 类；自有组件 12 原子 + 14 分子 + 11 领域 + 8 页面级（页面级按 IA 候选 B 的层级）
- [x] 产出 [docs/frontend-design-system.md](docs/frontend-design-system.md) +
      [docs/frontend-design-system-preview.html](docs/frontend-design-system-preview.html)
      （由 `docs/tools/gen-design-system-preview.py` + 模板生成，**不要手改**）
- 自检 ✅（2026-08-29，PR #76）：预览页在 Chrome 三种主题态（浅 / 深 / 跟随系统）实测，**14 组对比度
  全部通过、零红**；72 个色阶格子齐全、无横向滚动、无未替换占位符、无未渲染的 markdown 标记。
  过程中修掉三处自造问题：4 组对比度不达标（见上）、模板里 5 处 `**加粗**` 写进 HTML 不会渲染、
  深色阶上的数字标签用 `mix-blend-mode: luminosity` 读不清（改 `difference` + 白字后两端都可读）。

### PR 11E — 技术方案与风险评估

- [ ] 新 workspace 结构与命名（**初步选择 `frontend-next/` 顶层目录**：`packages/*` 是通配符能自动纳入
      根 lint/typecheck/test，但 `packages/` 语义是库不是应用；顶层需手动加 `package.json:6-10` 一行 +
      CI job。替换时改名。此项可逆，评审时定）
- [ ] **纯逻辑抽取方案**：把 `fleetNormalize`(510) / `fleetApi`(114) / `enums`(60) / `gps`(57) /
      `formatters`(34) / `data-defaults`(21) 从 `frontend/src` 抽到 `packages/fleet-core`，两个前端共同
      引用 —— **并行期最大的风险是这批逻辑分叉成两份**，抽取是唯一的根治办法
- [ ] 可搬 Vue 逻辑的搬迁边界：`useSvgViewport`(706) / `useSceneOverlay`(146) / `useHistoryPlayback`(123) /
      `useAuth`(114) / `guards`(113) / `useTheme`(83) / `useNotifications`(74) / `useAlertAck`(65)；
      `stores/fleet`(761) 要不要顺手按职责拆开（它现在同时是 state + 归一化入口 + 9 个 computed +
      整个 WS 传输层 + 场景加载 + window 调试 API，返回对象 **28** 个键）
- [ ] 接入点清单：根 `build` 是逐个 `-w` 硬编码、CI 的 frontend job 也是（**新 workspace 在加 job 前
      CI 覆盖为零**）、`frontend/Dockerfile:13-16` 逐个 COPY 三个 workspace 的 manifest
- [ ] **并行与切换策略**：并行期**不通过 nginx 暴露**新前端（`vite.config.js` 无 `base`，产物是绝对
      `/assets/…`，子路径挂载必 404；且安全响应头全写在 `location /` 内部，nginx `add_header` 不跨
      location 继承）。开发期 vite dev 直连后端；验收期用 compose overlay 覆盖 `frontend` 服务的
      image 一行，**切换原子、回滚一条命令**
- [ ] 决策：新前端全部 SFC 带 `lang="ts"`（顺手还掉 v2 推到 1.1 的债）
- [ ] 风险清单与回滚方案；产出 `docs/frontend-next-plan.md`

**Phase 11 收口**：五份文档评审通过，负责人签字；`docs/frontend-parity.md` 作为后续所有阶段的验收基线。

## Phase 12 — 前端焕新：底座搭建

> 目标：一个能跑、进 CI、有设计系统、有图表能力的空壳。此阶段结束时新前端还没有业务页面，
> 但**每一条工程管线都已打通**——后面每个页面都是纯增量。

### PR 12A — 共享逻辑抽取（先做，避免分叉）

- [ ] 新建 `packages/fleet-core`，迁入 6 个纯逻辑模块（合计 796 行）+ 对应 5 个测试文件
      （`fleetNormalize.test` 149 / `fleetApi.test` 95 / `enums.test` 37 / `gps.test` 25 / `fleetFixtures` 210）
- [ ] 现有 `frontend` 改为引用 `@navfleet/fleet-core`，**构建产物应逐字节一致**（此为验收判据）
- [ ] 顺手清死代码：`hasGps`（零引用）、`fleetApi.getAlerts`（生产零调用，仅自己的单测在用，
      连带 `AlertRecord` 15 字段死类型）、`sceneCatalog = {}`（三处查表恒不命中）
- [ ] 顺手合并重复实现：`hasPose` 三份、`mergeSceneDefinition` 两份、`toneLabelMap` 两份逐字重复

### PR 12B — workspace 骨架与工程管线

- [ ] `frontend-next/`：Vite + Vue 3 + TS strict + Pinia + vue-router，**全 SFC `lang="ts"`**
- [ ] Tailwind v4 + Reka UI + token 层落地（按 11D 的设计）
- [ ] 基础组件第一批：按钮 / 输入 / 选择 / 卡片 / 表格 / 标签 / 徽标 / 骨架 / toast / 对话框 / 抽屉
- [ ] 工程接入：`package.json` workspaces + 根 `build`、CI 新 job（lint / format:check / typecheck /
      test:coverage / build，node 20+22 矩阵）、覆盖率门槛（**按真实测量标定，不要沿用旧数字**）
- [ ] `vue/block-lang` 在新 workspace 里设为**强制 `lang="ts"`**（旧 frontend 保持 `allowNoLang`）
- [ ] **web history 迁移的部署侧**（11C 决定 3，必须在这里落地而不是拖到 Phase 14）：
      `frontend/Dockerfile` 加 nginx conf 含 `try_files $uri $uri/ /index.html`、边缘
      `deploy/nginx/locations.conf` 的 `location /` 同步同一 fallback、**两处都要带上安全响应头**
      （`add_header` 不跨 location 继承，现在全套头只挂在 SPA 那一个 location 上）、compose 实跑验证
      直接访问 `/devices/xxx` 与刷新都不 404、e2e 新增深链接用例

### PR 12C — 应用外壳

- [ ] 导航 + 路由 + 鉴权（搬 `useAuth` / `guards`）+ 主题（搬 `useTheme`，接新 token）+
      错误边界 + 通知（搬 `useNotifications`）+ 全局错误处理
- [ ] 响应式断点 + 大屏模式骨架
- [ ] **E2E 等价性网接线**：新增指向新前端的 playwright project。现有 17 例**零 `data-testid`**、
      全部用 `getByRole` + 中文可访问名匹配，只要新前端保持相同语义结构与可见文案就能一字不改复用 ——
      这是"新前端是否功能等价"最硬的判据。注意 `outputDir` / html report 路径写死在
      `REPO_ROOT/test-results` 与 `playwright-report`，两套并行会互相覆盖，需参数化
- [ ] axe 审计同步接线（5 页 × 明暗双主题，serious/critical 阻塞）

### PR 12D — 图表基座

- [ ] ECharts 接入：按需引入控制体积、明暗双主题与 token 联动、时序曲线封装组件
      （现在**零图表组件**，这是从头建的能力）
- [ ] **性能基线测量并入库**：1/6/50 台设备 × 500/2000/5000 点的渲染与更新耗时。参照 Phase 10
      虚拟化那次的做法——断言放在确定量上（DOM 节点数 / 实例数），墙钟只打印不断言。这份基线是
      将来判断「要不要换 uPlot」的唯一依据，而不是靠感觉
- [ ] 大数据量下的降采样策略（后端 history 最多返回 500 点，见下方 Phase 17 的口径修正）

**Phase 12 收口**：新 workspace 进 CI 全绿、设计系统预览页可访问、17 例 E2E 能在新前端空壳上
跑到"登录成功"、ECharts 性能基线入库。

## Phase 13 — 前端焕新：页面实现

> 每个 PR 一批页面，收口条件都是「对应的 parity 清单项全部勾掉 + 该页 axe 双主题零违规」。
> 顺序按依赖排：先立主干（态势 + 总览），再补纵深（详情 + 曲线），最后是改造幅度最大的告警与历史。

### PR 13A — 设备分区：列表 ⇄ 地图两个视图

- [ ] 搬 `useSvgViewport`(706) —— **原样搬，不重写**。它是 v1.0.0 里花三次尝试才定位到根因
      （bounds watcher 的 `immediate: true` 早于 `onMounted` 测量面板）的文件，重写一遍会重踩所有坑
- [ ] 搬 `useSceneOverlay`(146) + `point-cloud`(375) + `amap`(91) + `useSceneViewportPersistence`(87)
- [ ] `RosSceneMap`(594) / `GpsMap`(311) 重写为新设计：地图升为页面主体、侧栏可折叠
      （现在地图只是面板里的一格）
- [ ] 顺手补 `useSvgViewport` 的测试 —— 它现在覆盖率 **1.07%**，706 行几乎裸奔
- [ ] 顺手修未节流热路径：`pointermove` 直接写 viewport 无 rAF 合帧；`wheel` **每个刻度**一次同步
      sessionStorage 读写 + 两次 `getBoundingClientRect`
- [ ] **规模退化**（11C 决定 2）：`/devices` 首次进入的默认视图按车辆数自动选，阈值 **40 台**
      （依据是调研里唯一的实测值；列表侧 200 台挂载 34.5ms 不构成约束，决定阈值的是地图的可扫读性）。
      用户显式切过视图后该选择被记住并**优先于自动判定** —— 所以阈值只决定第一次进入，猜错的代价是
      一次点击。`navfleet:map-mode` 的白名单现在只有 `gps`/`scene`，要扩成「列表 / 地图 + 自动」三态

### PR 13B — 总览页（默认落地页，新增）

- [ ] 车队健康度、KPI 卡、告警热区、快速跳转
- [ ] 接上被丢弃的服务端数据：`summary.gpsCount`（后端算好下发，前端 `ingestPayload` 完全忽略、
      改用本地重算）、服务端 `updatedAt`（被 `new Date()` 覆盖）
- [ ] `formation.description`（3 条配置文案，下发但零展示）、`LaneletOverlay.stats` 场景信息卡

### PR 13C — 设备详情页（新增，纵深）

- [ ] 单车体检：实时遥测 + ECharts 曲线 + 告警史占位（数据源在 Phase 16）
- [ ] **把落库却未展示的遥测字段接上**：`speedLimit` / `online`（历史面板映射了但没渲染）、
      `controlMode` / `gear` / `omega` / `platformTaskStatus`（连映射都没有）、
      `extra.temperature` / `networkQuality` / `vehicleModel`（前端 grep 零命中）
- [ ] `tags` 变成可用的筛选与展示维度（6 台车各 2 个标签，现在全链路搬运却零 UI）
- [ ] `mapProfile` / `runtimeSceneId` vs `sceneId` 的差异是否值得暴露 —— 按 11A 的去留结论执行

### PR 13D — 告警中心（等价优先，深化留 Phase 16）

- [ ] 先做到与旧版功能等价：严重度分桶 / 设备筛选 / 搜索 / 确认 / 分页，`aria-pressed` 不能丢
- [ ] 补 11B/9.20 记的缺口：确认按钮的 `aria-pressed` / `aria-label`、批量操作的 toast 与撤销、
      空态的 `role="status"`、行可点击进设备详情、筛选状态入 URL
- [ ] **声音提醒**（11C 决定 4）：登录后一次性的"启用声音提醒"解锁（浏览器自动播放策略要求先有一次
      用户交互）、**只给 critical**（预警与提示不出声，否则值班室会把音量关掉 = 功能等于不存在）、
      未解锁时给一条低干扰提示说明"当前不会响"而不是静默地不响；静音 / 音量 / 免打扰时段三项配置
      进个人偏好（用户菜单），不进管理页
- [ ] 为 Phase 16 的历史与统计预留信息架构位置，但不提前实现

### PR 13E — 历史回放

- [ ] 搬 `useHistoryPlayback`(123)，重写回放条（进度滑块与倍速下拉的 `aria-label` 不能丢，
      那是 Phase 10 被 axe 抓到的 critical）
- [ ] **修 `trailsForMap` 的 O(N²)**：现在每 tick 都从 index 0 重走整段前缀，且每 tick 产生新的
      `{ [deviceId]: points }` 对象字面量，必然让下游 SVG path 全量重建。`limit` 上限 5000、
      4x 播放 150ms/帧 —— 这是当前唯一确定的前端性能缺陷
- [ ] 回放时的遥测曲线联动（ECharts + 游标同步）

### PR 13F — 设置 / 个人中心 / 404 / 收尾

- [ ] 设置页（主题 / 清本地数据 / 连接诊断）+ 为 Phase 15 的个人中心预留位置
- [ ] 404 + 错误页
- [ ] 全站键盘可达性复核（`.detail-scroll` 那类"可滚动但无可聚焦元素"的坑要在新实现里避免）

**Phase 13 收口**：`docs/frontend-parity.md` 全部勾掉；17 例 E2E 在新前端全绿；axe 5 页 × 双主题零违规。

## Phase 14 — 切换与替换（发版 1.1.0）

- [ ] **等价性验收**：parity 清单 + 17 例 E2E + axe 零违规 + **负责人人工验收**（第 5 条决策明确
      要"检查前端是否符合预期且调整后"才进下一步，这里预留调整迭代的余量，不设时限）
- [ ] 性能对比：首屏、交互延迟、大列表（复用 Phase 10 的 largeFleet 测量口径）、地图帧率、包体积
- [ ] compose overlay 原子切换 → 观察期 → 旧 `frontend` workspace 下线、`frontend-next` 改名
- [ ] 同步收尾：`frontend/Dockerfile` manifest 清单、CI job、根 `build`、`publish-images.yml` matrix、
      `playwright.config.ts` 的 workspace 名、`CONTRIBUTING.md` / `deploy/docs/deployment.md` 的引用
- [ ] 文档：README 的技术栈与截图、ARCHITECTURE 的前端章节
- [ ] **P0-f 工程门禁批次**在此之后执行（见前文，旧前端下线后 type-aware lint 只需修一遍）
- [ ] 发版 **1.1.0**（先发镜像、再建 Release —— v1.0.0 那次顺序反了，说明文档一度先于产物存在）

## Phase 15 — 用户体系与真 RBAC（发版 1.2.0）

> 这是把「口令保护的看板」变成「多用户系统」的阶段。**15A 必须先做**：后面每个 PR 都要改集合结构，
> 而现在全仓库没有任何迁移机制（无 migrations 目录、无 schema 版本字段、升级文档无回滚步骤）。

### PR 15A — schema 迁移机制（前置，非可选）

- [ ] 迁移框架：版本标记集合 + 顺序化迁移脚本 + 启动时自动执行（幂等）+ 失败即拒绝启动
- [ ] 补一处已确认的坑：`telemetry_ts` 的 TTL 只在 `createCollection` 分支设定
      （`persistence.ts:151-160`），集合已存在时不 `collMod` → **改 `TELEMETRY_RETENTION_SECONDS`
      对已建库无效**，而 `deploy/docs/backup-and-restore.md:63-64` 只说"通过环境变量调整"，未区分
- [ ] 升级文档补回滚步骤与"升级前强制备份"环节（现在两者都没有）

### PR 15B — 用户模型与管理 API

- [ ] `UserRecord` 从 5 个字段扩展：显示名、邮箱/手机（通知用）、启用状态、最后登录、
      `tokenVersion`、密码更新时间
- [ ] 用户 CRUD + **改密码**（自己改 / 管理员重置）+ 启用禁用 + 角色分配
- [ ] `tokenVersion` 让登出与改密**真正失效 token**（现在 logout 只 `clearCookie`，已签发 token 在
      TTL 内仍有效，refresh 最长 7 天）
- [ ] 密码复杂度校验（现在无注册/改密路径，所以从未校验过）
- [ ] refresh token 轮转（现在 `/refresh` 不换 refresh cookie）

### PR 15C — 用户组与权限矩阵

- [ ] 用户组 = **权限集 + 通知收件方**两合一（数据范围按决策 1 暂不做，但**数据模型留出位置**，
      避免将来加范围时要动全表）
- [ ] 权限矩阵落地：**每条路由标注所需权限**，`requireRole` 从 1 处调用扩展到全量；
      前端路由带 `meta.roles`、UI 按权限隐藏操作
- [ ] 三角色的实际边界定义清楚并写进文档；**修正 README:43 / :59 的 RBAC 表述**
- [ ] 权限边界的集成测试（每条受保护路由 × 每个角色）

### PR 15D — 审计日志

- [ ] `audit_log` 集合 + 中间件：登录/登出/失败、用户与用户组变更、权限变更、告警确认、配置变更
- [ ] 请求日志补用户名（现在只记 method/path/status/durationMs）
- [ ] 查询接口 + 管理页（筛选、分页、导出）+ TTL 保留策略
- [ ] 顺手补一处日志脱敏缺口：broker 连接串没有走 pino 的 redact 路径，若运维把凭据写进
      `MQTT_URL` 就会明文入日志（`mongoUri` 已有脱敏，这一处漏了）

### PR 15E — 会话管理与管理端 UI

- [ ] 会话可见性（当前登录设备列表）+ 管理员强制下线
- [ ] 账号级登录失败锁定（现在只有 IP 级限流，无 `failedAttempts` / `lockedUntil`）
- [ ] 管理页：用户 / 用户组 / 审计日志；个人中心：改密 / 改显示名
- [ ] 发版 **1.2.0**

## Phase 16 — 告警体系深化（发版 1.3.0）

> 告警现在是**纯派生、无状态**：规则只有 2 条（低电量阈值 20 在前后端各硬编码一遍）、
> 唯一可配阈值是 `OFFLINE_AFTER_SECONDS`、确认只存浏览器、`alerts` 集合积累的历史零读取方。

### PR 16A — 确认落库

- [ ] `StoredAlert` 补 `ackedBy` / `ackedAt` / `comment`（现在连字段都没有）
- [ ] 确认/取消确认 API + 审计联动；localStorage 数据一次性迁移并下线 `useAlertAck` 的本地存储
- [ ] 跨设备跨用户实时同步（WS 事件）

### PR 16B — 告警历史与统计

- [ ] 接线 `/api/v1/alerts` —— 端点早就存在，前端 `getAlerts()` **唯一调用方是它自己的单元测试**
- [ ] 展示已落库却零读取的字段：`firstSeenAt` / `lastSeenAt` / `clearedAt` / `active=false` 的已清除告警；
      `status=cleared` 查询能力已有 schema 支持却无 UI 入口
- [ ] 持续时长、发生频次、Top 排行、按设备/严重度/时间的分布

### PR 16C — 可配置规则引擎与报码字典

- [ ] 规则配置化：阈值、启停、作用范围（设备/编队/标签）、去抖动窗口。消除前后端两份硬编码规则
      （`normalize.ts:207-236` 与 `fleetNormalize.ts:222-250` 各写一遍，且已存在差异——前端不产出
      `alerts[].active`）
- [ ] **报码字典**（`code` → 名称 / 等级 / 分类 / 处理建议），可配置 + 管理 UI + 导入导出。
      现存 4 个报码只是 mock 与 e2e 的演示常量；不同厂商车型报码不同，这是这类产品最常被要求定制的地方
- [ ] 规则与字典的热重载（沿用 configRegistry 的原子替换 + 校验失败保留旧快照）

### PR 16D — 告警外发

- [ ] 渠道：webhook / 企业微信 / 钉钉 / 邮件（可扩展）
- [ ] 分级路由（critical 立即、warning 汇总）+ 静默窗口 + 去重 + 升级策略 + 发送失败重试
- [ ] 收件方接到用户组（Phase 15C 的第二个职责）
- [ ] 发送记录与可观测性（成功率、延迟指标 + Grafana 面板）
- [ ] 发版 **1.3.0**

## Phase 17 — 报表与数据价值（发版 1.4.0）

> 现在 `persistence.ts` 里**一个 `$group`/`aggregate` 都没有**，没有任何聚合端点；唯一的"统计"是
> Prometheus 的瞬时值，无历史聚合语义。这个阶段把已经躺了 30 天的时序数据变成能交给主管的数字。

### PR 17A — 聚合层

- [ ] 聚合管道：在线率 / 可用率 / 告警统计 / 里程或行驶时长（若 `fusionLoc` 精度足够）/ 电量循环
- [ ] 时间分桶（时/日/班次）+ 降采样，避免每次全量扫时序库
- [ ] 修正一处口径不一致：schema 允许 `limit ≤ 5000`（`validation.ts:15`），服务端硬夹到
      `MAX_HISTORY_POINTS`（默认 500），而前端默认请求 1000、输入框上限 5000 —— **实际最多返回 500 点**
- [ ] history 支持字段投影（现在整条文档原样返回，17 个 measurements 全传）

### PR 17B — 报表页与导出

- [ ] 报表页：班次日报 / 周报、可用率趋势、告警 Top、单车对比
- [ ] 导出 CSV / Excel（运维交班与主管汇报的刚需）
- [ ] 定时报表（可选：邮件推送，复用 16D 的渠道）

### PR 17C — 大屏值班模式

- [ ] 免交互看板：车队态势 + 关键 KPI + 滚动告警，长时间无人值守可运行
- [ ] kiosk 账号方案（长期 token + 只读权限 + 审计标记），**不做匿名开放**
- [ ] 多分辨率适配（1920×1080 / 2560×1440 / 4K）与烧屏规避

### PR 17D — 象限 B 收尾

- [ ] 把 Phase 13 未接完的"已有数据未利用"项清零，逐项对照第 2 条起点结论核销
- [ ] 场景侧未消费配置的去留：`occupiedThresh` / `freeThresh` / `negate` / `mapFrame`（前后端各 0 消费点）、
      `pointCloudMode`、点云 meta 的 `cell_values` / `counts`、`metadataUrl`（有消费代码但没有场景配置它）
- [ ] `mapProfile` 的处置：解析→合并→下发后**无任何读取方**，且 `vehicles.json` 里写的 `"rosRaster"`
      既不在 `MapProfile` 字面量内也不影响渲染（渲染实际由 scene 的 imageUrl/osmUrl/pointCloudUrl 决定）
      —— 要么真正消费，要么删掉，不留半截
- [ ] 发版 **1.4.0**

## Phase 18 — 交付成熟度收尾

> 不设发版号；按需并入前面某个 minor。这里放的是"给别人用"才会暴露的问题。

- [ ] **设备接入向导**：把改 `config-runtime/*.json` 变成 UI 操作（校验 + 预览 + 热重载反馈）。
      现在实施工程师必须登服务器改文件，且 `.pcd` 与 SVG 底图**不在 chokidar watch 列表**
      （只监听 `**/*.osm` 与 4 个 JSON）
- [ ] 场景地图上传与管理（含越权路径防护复核）
- [ ] 多平台镜像（当前 amd64-only）+ 镜像 SBOM / 签名（v2 的 PR 6C 已延后一次）
- [ ] `prom-client` → `@prometheus-io/client`（上游已 deprecated，v2 因新包采用度不足暂留）
- [ ] Lanelet2 `delete="true"` 过滤（88 条 lanelet 中 46 条带删除标记仍被绘制）
- [ ] 运维盲区补齐：Mongo 写入延迟与失败计数、缓冲溢出丢弃计数、WS 广播背压指标；
      mongo / mosquitto / nginx 的 exporter（Prometheus 现在只有 backend 与自身两个 job）
- [ ] 安全余项：`Permissions-Policy` 与其他 location 的安全头（nginx 的 `add_header` 不跨 location 继承，
      所以目前只有 SPA 那一个 location 带全套安全头）；mongo healthcheck 的口令传递方式
      与备份脚本不一致（后者刻意避开了命令行参数，前者没有）；MQTT over TLS
- [ ] i18n（v2 两次排除，若确有海外交付需求再启动）
- [ ] axe `incomplete` 桶的人工审阅流程（半透明/渐变表面落进该桶而不产生违规，Phase 10 已确认
      这类缺陷 suite 抓不到）

---

## v3 风险登记

| 风险                                       | 影响                         | 应对                                                                                           |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| 并行期两个前端的共享逻辑分叉               | 修一处漏一处，且分叉不会报错 | **PR 12A 先抽 `packages/fleet-core`**，从结构上让分叉不可能                                    |
| 新前端"看起来焕新了但少了功能"             | 切换后才发现，回滚代价高     | `docs/frontend-parity.md` 逐项核销 + 17 例 E2E 等价性网（零 testid、纯 ARIA 匹配，可直接复用） |
| IA 重构范围失控                            | 阶段无限延长                 | Phase 11 是纯设计阶段且要签字；13A–13F 逐页交付，任一页可独立收口                              |
| Reka UI / Tailwind v4 的实际契合度不如预期 | 底座返工                     | Phase 12B 是最小可验证切片；若 12B 就发现不合，此时沉没成本仅一个 PR                           |
| ECharts 在大数据量下不够快                 | 曲线卡顿                     | 12D 留下性能基线作为换 uPlot 的客观判据，而非靠感觉                                            |
| Phase 15/16 改集合结构无迁移机制           | 已交付部署升级即坏数据       | **PR 15A 前置**，非可选                                                                        |
| P0 缺陷在新功能之下被遗忘                  | 生产事故                     | P0-a 立刻单独发 1.0.1；P0-b～e 与 Phase 12 并行发 1.0.2；本表每阶段收口时回查                  |

---

---

## 执行记录

- 2026-08-29：**v1.0.0 发布**，作为 v3 全部工作的起点。此前的阶段记录见
  [docs/roadmap-archive.md](docs/roadmap-archive.md)。
- 2026-08-29：完成第二轮审计（后端健壮性 / 前端技术债 / 测试门禁 / 部署运维 + 鉴权与领域模型
  复审），与负责人对齐六项决策，**生成本路线图（Phase 11–18）**。过程中两件值得记录：
  1. 审计发现的 P0-a 此前四轮审阅都没看到 —— 它不在任何"已知边界"清单里，是这次逐文件读
     事件监听器注册时才浮出来的。这类"缺一个监听器"的缺陷不会在测试里表现为失败，只会在
     生产里表现为重启。
  2. **我把未修复缺陷的利用细节写进了本文件并推送到这个公开仓库**，创建 PR 时被权限分类器拦下
     才发现。拦得对，但文档已经推上去了。已改为"先修后写"：面向仓库的缺陷条目只写影响与待办，
     完整机制留在会话与本地笔记。同期核实并否决一条子代理误报（说 PR #39 的摄入串行化队列找
     不到实现 —— 那个 PR 改的是后端 `store.ts`，子代理去前端 `stores/fleet.ts` 找自然找不到）。
- 2026-08-29：**v1.0.1 发布**（#67 P0-a 修复）。tag / Release / 两个 GHCR 镜像全部到位，
  `1.0.1` · `1.0` · `latest` · `sha-c403acc` 四个标签同一 digest，镜像内 manifest 报 1.0.1。
- 2026-08-29：**版本号收敛为单一来源**（#70）。第一次**自动**发版立刻暴露了一个手工发版掩盖着的
  缺口：release-please 只 bump 根 manifest，所以 1.0.1 之后三个 workspace manifest 还停在 1.0.0。
  查证后发现实际情况更糟 —— 那三份 manifest 在 1.0.0 收尾时被手工改成 1.0.0，但**lockfile 里它们
  仍记着 `0.1.0`**，没有任何检查会看那个字段，所以直到这次才被发现。v1.0.0 记录里"六处版本全部
  一致"的说法对 lockfile 的 workspace 条目是不成立的。
  修法不是让它们跟着涨，而是**把 version 字段从三份 private manifest 里删掉**：它们从不发布，
  release-please 也只管根，一个没有消费方又无法自动同步的字段只会变质。影响面已核实为零 ——
  唯一在运行时读版本的是 `openapi.ts`，读的是根 manifest；镜像内 `/app/package.json` 也是根那份，
  实测仍报 1.0.1。附 `release-version.test.ts`（5 例）**断言这三处不存在 version 字段**，
  并已验证反向：把字段加回去测试立刻变红。断言"不存在"才让漂移结构上不可能，而不只是当下正确。
