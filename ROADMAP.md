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

### 版本号规则（2026-08-30 定稿）

| 位    | 含义                       | 例                               |
| ----- | -------------------------- | -------------------------------- |
| **X** | 阶段性、完全的重大更新     | `1.0.0` 基准版 · `2.0.0` v3 收口 |
| **Y** | 完整的项目功能与使用性更新 | `1.1.0` 新前端替换旧前端         |
| **Z** | 小型升级与 BUG 修复        | `1.0.1` P0-a hotfix              |

判定只问一句话：**用户能拿到什么。** 一次发版里如果用户可见的只有修复，那它是 Z；只有当一整块
功能真正到达用户手里时才动 Y。这条区分不是形式 —— 见下面 1.1.0 那次事故。

### 计划表

| 版本      | 内容                                                        | 时机          |
| --------- | ----------------------------------------------------------- | ------------- |
| **1.0.1** | P0-a 修复（hotfix）✅ 已发布                                | 2026-08-29    |
| **1.0.2** | 导航对比度修复（用户可见）+ Phase 12 内部底座（用户不可见） | Phase 12 收口 |
| **1.0.3** | 后端健壮性批次（P0-b～P0-e + 优雅关闭）                     | 该批次收口    |
| **1.1.0** | **新前端替换旧前端** —— 第一次有一整块功能真正到达用户      | Phase 14 收口 |
| **1.2.0** | 用户 / 用户组 / 真 RBAC / 审计（含 schema 迁移机制）        | Phase 15 收口 |
| **1.3.0** | 告警体系深化（ack 落库 / 历史 / 规则 / 外发）               | Phase 16 收口 |
| **1.4.0** | 报表与数据价值（聚合 / 导出 / 大屏）                        | Phase 17 收口 |
| **2.0.0** | v3 全部完成                                                 | Phase 18 收口 |

**Phase 13 不发版。** 它把新前端的页面一页页建起来，但旧前端仍然是用户唯一能访问的那一个 ——
没有任何东西到达用户，所以既不动 Y 也不动 Z。这不是保守，是上面那条判定的直接推论。

**表里的时机是计划，不是授权。** 每次实际发版由我提出、负责人批准后执行。

### 四条纪律，每条都是踩过才写下来的

1. **`feat:` / `fix:` 一旦落在 main 上，发版就已经注定了。** 关闭 release-please 的发版 PR
   **只能推迟、不能取消** —— 那些 commit 还在 main 上，下一次运行会用同样的内容重建一个 PR。
   所以**版本号是在 commit 那一刻决定的，不是在发版那一刻**。
2. **用户拿不到的改动一律用 `chore:` / `refactor:` / `test:` / `docs:`。** 这类 type 不产生发版，
   这是 Phase 12–13 这种"平行开发、尚未交付"阶段唯一正确的写法。
3. **要指定版本号就用 `Release-As: x.y.z` 脚注**，不要靠调整 commit type 去凑。
4. **先发镜像、再建 Release。** v1.0.0 那次顺序反了，说明文档里的镜像地址一度指向尚不存在的产物。

### 事故记录：1.1.0 被误发并已回收（2026-08-30）

**发生了什么。** 12A 用了 `feat(fleet-core):`、12B 用了 `feat(console):`，两者都是用户拿不到的
内部改动（fleet-core 是共享逻辑层；console 不在任何镜像、不在 compose）。release-please 因此提了
1.1.0 的发版 PR #78。#78 被关闭，但**那三个 commit 仍在 main 上**，于是它重建为 #83 并被合入 ——
tag、Release、镜像全部产生。负责人随后删除了 tag、Release 与包。

**我错在哪。** 我建议"关掉 #78"时，让它听起来像一个解决方案。它不是：关闭只推迟。我应该说清楚
**唯一的止损点是 commit type，而那三个 commit 已经落地**，所以这次发版在当时就已经不可避免 ——
能做的只有决定它叫什么号。

**为什么补 1.0.2 而不是直接发 1.1.0。** 自 1.0.1 以来用户可见的变化**只有导航对比度修复**一条，
其余全是内部底座。按上面的规则那是 Z 而不是 Y。直接叫 1.1.0 等于让版本号声称"一整块功能到达了
用户"，而那要到 Phase 14 才成立 —— 版本号一旦撒谎，之后每一次发版都得替它兜着。

**修法。** `.release-please-manifest.json` / `package.json` / `package-lock.json` 回到 1.0.1、
删掉 CHANGELOG 里那节 1.1.0，并用 `Release-As: 1.0.2` 把下一次发版钉在 1.0.2。
1.1.0 因此回到它该在的位置：Phase 14。

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

### P0-b～P0-e — 后端健壮性批次（1.0.3，与 Phase 12–13 并行）

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

### P1 — 多厂商 / 多车型适配（2026-08-30 记入，展开时机待定）

一轮讨论暴露出的**架构空洞**，不是可以顺手补的缺陷。记在这里是为了它不再被当成"以后自然会有"，
而**展开时机取决于一个还没有答案的问题**：第二种车是真的要接了，还是储备？两者的正确做法不同 ——
这与决策 #1 暂缓"数据范围隔离"用的是同一条判据。

- [ ] **P1-a 现状是「字段别名容错」，不是厂商适配。** `normalizeDevice` 宽容 `fusion_loc`/`fusionLoc`、
      `deviceId`/`id`/`device_id` 这类命名风格差异，`topicPattern` 也确实接进了订阅 —— 但**载荷结构
      本身是硬编码的一种方言**。换一家厂商的车，改的是 `normalize.ts`。
- [ ] **P1-b 「设备」被当成同一种东西。** 巡检车关心路线覆盖与抓拍，搬运车关心载荷/举升/取放货，
      清扫车关心水位与刷盘。13C 的详情页是按「一种车」画的；第二种车进来会得到一个到处是 `--`
      的页面，那比没有更糟 —— 它让人以为是数据丢了。
      **种子已经在了**：`gpsEnabled` / `rosMapEnabled` 就是按设备的能力开关，两张地图正是按它们决定
      要不要画。这条路走对了一步，但没走完，也没被承认成一种设计。
- [ ] **P1-c 三种做法，顺序比选择更重要。** A 能力声明驱动 UI（差异在有什么传感器/执行机构）·
      B 车型 profile（差异是成套的）· C 后端 ingest adapter（差异在载荷**结构**）。三者不互斥：
      **C 解决"进得来"，A/B 解决"显得对"**；真接第二家时 C 绕不过去。
- [ ] **P1-d 报码字典目前是单一全局表。** 部署侧码表要能按厂商/车型分表并从后端下发、覆盖内置表 ——
      这件事天然属于 Phase 16（那个阶段本来就有规则配置）。
- [ ] **P1-e `vehicleModel` 搬运但零参与判断。** 只在 `backend/src/normalize.ts` 塞进 `extra`，
      落库时默认 `"generic-agv"`，此外不影响任何行为。它是 P1-b 真要做时的天然入口。
- [ ] **建议插一个纯调研阶段（14.5，照 Phase 11 的先例，不写产品代码）**：调研 VDA 5050 完整状态模型、
      2–3 家公开文档的载荷结构、能力声明的常见做法；**收口物是一份决定，不是代码**。
      刻意排在 Phase 14 之后：13 的目标是"新前端替换旧前端"、14 要发 1.1.0，中途插入一个跨前后端的
      架构层会让那次发版范围失控 —— 这正是 1.1.0 误发后立的纪律想避免的事。

> **演示报码的边界（记在这里，因为它是 P1-d 的前提）**：仓库是 public，**厂商手册能下载不等于授权
> 再分发**，所以不逐条抄任何厂商的码表。可以照抄且理直气壮的只有 **VDA 5050 的 `errorType` 枚举**
> —— 它是公开标准，本身就是给人实现的。其余按公开文档的*故障类别与分层*自己写文案：得到的是真实
> **形状**，不是真实**内容**。真实码值等设备供应商给。

### P0-f — 工程门禁（随 1.1.0 前端替换，Phase 14 之后）

推到旧前端下线之后的理由：type-aware lint 会在两套前端上各产生一遍修复工作，等下线后做只需修一次。

- [ ] ESLint 启用 `recommendedTypeChecked` —— 现在三份配置全是 `recommended`，
      `no-floating-promises` / `no-misused-promises` / `await-thenable` **全不生效**，而 P0-a 与 P0-b
      恰是这个规则集专抓的那一类（async 事件回调、被丢弃的 Promise）
- [ ] `--max-warnings 0` —— `no-unused-vars` 三处都降为 `warn` 且全仓无 `--max-warnings`，
      warning 永不让 CI 红，等于没配
- [ ] Playwright CI `retries: 1` → 0，flaky 不再被重跑掩盖。**这条现在有实测依据**：#79 那次抖动
      是一个真的对比度缺陷（过渡中间态 1.38:1），而重试对它完全无效 —— 重跑同一段"导航→审计"只会
      再落进同一个窗口，`retries` 唯一的作用是把真缺陷标成 flaky 然后放行。详见执行记录 2026-08-29 条
- [ ] `packages/shared` 纳入 lint（根 `eslint.config.mjs:23` 显式 ignore）。**「e2e 纳入
      `format:check`」这半条已经不成立** —— 根 `format:check` 里已经有
      `prettier --check "e2e/**/*.{ts,json}"`，是这条待办写下之后补的，核对时才发现，已划掉
- [ ] 覆盖率近零区补测：后端 `persistence.ts` 42.6%（3 例）/ `store.ts` 57.4%（**2 例**）
- [ ] tsconfig 补 `noUncheckedIndexedAccess` 等严格开关（四份配置现在只开了 `strict`）
- [ ] **eslint 9 → 10 + eslint-plugin-vue 9 → 10，必须同时，而且要手写 PR。** dependabot 分开开了两个
      PR，**单独任何一个都红**：#110（eslint 10）在两个前端红，#108（plugin-vue 10）在 console 红 ——
      eslint 10 需要 plugin-vue 10，而 plugin-vue 10 在 eslint 9 下不工作。
      **⚠️ 我在这里犯过一个顺序错误，记下来是因为结论会影响下一次怎么做**：我先关掉了 #107/#108/#110，
      然后才给 `dependabot.yml` 加分组，以为下次会作为一个能合的 PR 回来 —— 结果 #112/#114 仍然只含
      一半（#114 正文自己写着「with **1 update**」）。**dependabot 的分组只打包它在同一次运行里提出的
      更新**，被关闭动作压掉的那一半拉不回来。分组对将来仍然有效（对面出新版本时两半会一起来），
      但这两个升级现在必须手写：eslint + plugin-vue 一起抬，并改 flat config，与上面
      `recommendedTypeChecked` 那条一起做
- [ ] **vitest 3 → 4（含 `@vitest/coverage-v8`），必须同时，且要重定覆盖率门槛。** #107 单独抬
      coverage-v8 到 4，peer 要求 `vitest@4`，8 项 CI 红 6 项；#112 反过来单独抬 vitest 到 4，
      六个构建任务全红 —— 正好是镜像。三个 workspace 都钉 `^3.2.7`，要一起升；vitest 4 还会牵动
      覆盖率的计算口径，而本仓库四个门槛是按实测值定的，所以这是一个需要重新测量的 PR，
      不是一次版本号替换
- [ ] **jsdom 26 → 30 是取舍而不是升级。** #109 只在 **node 20** 红、node 22 绿（console 与 frontend
      都是这个形状）—— 同一份代码同一份 lockfile，差别只有 Node 版本，指向 jsdom 30 抬高了 Node 最低
      要求。放弃 node 20 那一档需要单独决定（双版本矩阵是刻意的，为了不把部署锁死在单一 Node 上），
      不该由一次依赖升级顺带决定。等 node 20 走到 EOL、矩阵本来就要调整时，连同 vitest 4 一起做

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

## Phase 12 — 前端焕新：底座搭建 ✅ 完成（2026-08-30）

> 目标：一个能跑、进 CI、有设计系统、有图表能力的空壳。此阶段结束时新前端还没有业务页面，
> 但**每一条工程管线都已打通**——后面每个页面都是纯增量。

### PR 12A — 共享逻辑抽取（先做，避免分叉）

- [x] 新建 `packages/fleet-core`（`@navfleet/fleet-core`），迁入 6 个纯逻辑模块 + 4 个测试文件；
      现有 `frontend` 的 16 处 import 改指该包，另修 3 处注释里的旧路径
- [x] **`fleetFixtures.ts` 没进这个包** —— 它是 store 的 WebSocket/fetch 替身，而 store 留在 frontend，
      放进来两边都用不上（包的 `exports` 不暴露 test 目录）。已移回 `frontend/test/helpers/`。
      其中的 payload 构造器确实属于领域层，等 12C 新前端真要用时再拆
- [x] **验收判据换了**：原写的"构建产物逐字节一致"对 JS **不成立** —— 模块搬进包必然改变模块图，
      Vite 因此重新分块、内容 hash 全变（`enums-*.js` 合并进他处、`RosSceneMap-*.js` 独立成块）。
      换成四条能真正证明"没改行为"的：① **CSS 逐字节一致**（md5 `b9510483…`，且在 Docker 镜像内再验一次）
      ② JS 总体积 192752 → 192738，**差 -14 字节**（重复打包会是几百到几千） ③ 用中文字面量查重
      （「自动驾驶」「异常中断」「未命名设备」「暂无内容」各只出现在 **1 个** chunk） ④ **E2E 17/17**
- [x] **死代码清理与重复实现合并推到 12C**，理由两条：① 这个 PR 的价值全在"没改行为"可验证，混进删除就
      失去判据；② `fleetApi.getAlerts` 原计划要删（生产零调用），但 **Phase 16B 明确要接线它** ——
      删了再加是纯粹的来回。`hasGps` 零引用、`sceneCatalog = {}` 恒不命中、`hasPose` 三份实现都仍在
- [x] fleet-core 自带 eslint 配置与 `lint` / `format:check` / `typecheck` / `test:coverage` 四个脚本，
      并接进 CI 的 frontend job（与 `@navfleet/shared` 接在 backend job 同理）。**新包不加入
      `packages/shared` 那个"从未被 lint 过"的集合** —— 那是 P0-f 记着的缺口，不该再添一个
- [x] 覆盖率门槛按首次真实测量标定：**85 / 79 / 87 / 85**（实测 86.86 / 80.73 / 88.37 / 86.86）。
      抽包暴露出 `formatters.ts` 覆盖率是 **0%** —— 它在旧前端只被 DashboardView 的组件测试**间接**
      带到过，这是 Phase 10「虚假 100%」那条教训的反向版本。补了 9 例直接测试，其中 3 条**钉住
      `formatNumber(null) → "0.00"` 这个缺陷的现有行为而不是修它**（本 PR 不改行为；修在 Phase 13，
      届时这几条期望要在同一个 commit 里一起改，而不是悄悄漂移）
- 自检 ✅（2026-08-29，PR #77）：fleet-core 38 例（新增 formatters 9 例）· 后端 287 · 前端 132
  （161 − 29 迁走）· lint / format:check / typecheck / build 全过 · **两个 Docker 镜像实建通过**
  （`npm ci` 会校验完整 workspace 集合，缺一份 manifest 就拒绝 lockfile，所以 backend 与 frontend
  两个 Dockerfile 各自都要加 —— backend 有两个 stage，共三处）

### PR 12B — workspace 骨架与工程管线

- [x] `frontend-next/`（包名 `navfleet-console`）：Vite 8 + Vue 3 + Tailwind 4.3 + Reka UI 2.10；
      tsconfig 除 `strict` 外**另开** `noUncheckedIndexedAccess` / `noImplicitOverride` /
      `noFallthroughCasesInSwitch` / `noUnusedLocals` / `noUnusedParameters`（旧四份配置只开了 `strict`，
      新包不迁就）；dev 端口 **5273**，刻意不与旧前端的 5173 撞
- [x] **token 层与预览页同源**：`gen-design-system-preview.py` 现在同时产出
      `frontend-next/src/styles/{ramp,semantic}.css` —— 所以预览页里那 14 组对比度审计审的就是线上真正
      用的值，两者结构上无法漂移
- [x] **最高风险项已退役**：11D 标记的 `@theme` 覆盖机制在浏览器里实测成立。构建产物里
      `.bg-surface{background-color:var(--color-surface)}` —— **引用 token 而非嵌入值**；
      `--color-surface` 共 3 处定义（1 浅色基线 + 2 深色：媒体查询与属性选择器各一）；
      点一次切换后实测 body 底 `slate-25 → slate-900`、ink `slate-900 → slate-50`、
      `surface-raised` `white → slate-800`、brand 徽标底/字 `teal-50/800 → teal-900/200`，
      **源码里零 `dark:` 前缀**
- [x] 基础组件第一批只做了 `UiButton`（4 变体 × 2 尺寸 + disabled）—— 其余组件推到 12C，
      理由是它们的形状取决于外壳与页面，先做会做两遍
- [x] 工程接入：根 workspaces + 根 `build`/`dev:console`、**CI 独立 job**（node 20+22，
      lint / format:check / typecheck / test:coverage / build）。独立而非并进 frontend job 的理由：
      两个前端在 Phase 12–13 是各自独立的交付物，v3 红不该躲在生产中那个后面、也不该拖它
- [x] `vue/block-lang` 设为**强制 `lang="ts"`**（无 `allowNoLang`），`no-unused-vars` 直接 `error`
      而非 `warn`
- [x] **web history 的部署侧已落地并实测**（11C 决定 3）：`frontend-next/nginx.conf` +
      `Dockerfile`；起容器后 `/`、`/devices`、`/devices/agv-01`、`/alerts/history` 全部 200 且返回
      index.html，而 `/assets/nope.js` 正确 **404**（没被 fallback 吞掉 —— 这条最容易漏），
      四个安全响应头在 fallback 响应上齐全（`add_header` 不跨 location 继承，所以镜像里也写了一份）
- [x] token 机检 6 例，**反向验证过**：把 `@theme` 改成 `@theme inline` 后立刻变红。其中一条检查
      「组件里不得出现 `dark:`」、一条检查「类名必须是字面量」—— 后者抓的是 Tailwind 只扫字面量、
      `bg-${'{'}token{'}'}` 会静默不生成 CSS 的坑（我自己第一版就是这么写的）
- 自检 ✅（2026-08-29，PR #78）：console 6 例 · fleet-core 38 · 后端 287 · 前端 132（**旧前端零改动**）·
  lint / format:check / typecheck / build 全过 · console 镜像实建并跑通 SPA fallback ·
  CSS **4.32 KB gzip**（预算 14 KB）· lockfile 在 `node:22-alpine` 里生成、零 npmmirror
- [ ] **web history 的部署侧 —— 剩下的部分归 Phase 14，口径在此更正**。11C 决定 3 要求"必须在 12B
      落地"，落地的是**新前端自己那一份**（上一条，已实测）。剩下两项刻意不在这里做：- **旧前端不迁 hash**。它在 Phase 14 下线，为一个即将退役的前端改路由模式 + 镜像 nginx conf
      是纯粹的返工，且会让两套前端的 e2e URL 断言同时变动 —— 风险换不到任何收益。- **边缘 `deploy/nginx/locations.conf` 的 fallback 归 Phase 14**：compose 现在把 `/` 指向旧前端
      镜像，边缘改 fallback 在新前端进 compose 之前没有作用点。**但有一条现存缺口要带过去**：
      全套安全响应头现在只挂在 SPA 那一个 location 上，而 `add_header` 不跨 location 继承，
      所以 Phase 14 换镜像时必须同时核对每个 location 的头，而不是只改 `try_files`。

### PR 12C-1 — 应用外壳

拆成两个 PR 的理由：外壳本身与「把 e2e 接到新前端」是两件独立可验证的事，混在一起会得到一个
既改结构又改测试基建的大 diff，出问题时分不清是哪一半。

- [x] 路由（web history）+ 候选 B 的层级：`/` 总览 · `/devices` ⇄ `/devices/:deviceId` ·
      `/alerts` · `/reports` · `/admin` · `/wall`（`meta.bare`，不进导航）· 404。
      **`/devices/:deviceId` 是 `/devices` 的子路由而不是兄弟**，因为 `router-link-active` 按
      matched 记录判定 —— 兄弟路由会让工程师停留最久的那一页整条侧栏都不亮。已有测试钉住
- [x] 鉴权（搬 `useAuth` / `guards`）+ 通知（搬 `useNotifications`）+ 错误边界 + 全局错误处理
- [x] **用测试钉住了导航高亮的匹配语义**（上一版 12C 条目里记的待办）。两个类名的分工也定了：
      `router-link-active` 管**视觉高亮**（分区级，子路由上保持亮），而 `aria-current="page"` 只跟
      `isExactActive` —— 打开设备详情时「设备」是所在分区而不是当前页，两个都报当前页是撒谎
- [x] 外壳结构：全宽 `banner`（唯一一个）+ 侧栏三态（240 / 44 / 抽屉，`lg` 以下强制抽屉）+
      自动面包屑（C3）+ 跳转链接 + 可聚焦 `main`（导航后自动接管焦点）
- [x] 抽屉用 Reka `Dialog`、会话菜单用 Reka `DropdownMenu` —— 这是设计系统选的组件库第一次真用，
      跟 12B 用 token 切片退役 `@theme` 风险同一个思路：尽早在最便宜的地方验证它合不合适
- [x] 响应式：断点接 11C 刻度，axe 覆盖 1024 / 1440 / 1920 / 2560 四个视口
- [x] 大屏模式骨架：`/wall` 走不带外壳的渲染路径（kiosk 凭据与新鲜度指示留 17C）
- [x] **补了 v1.0.0 的两个真缺陷**，都在搬运时顺手修掉而不是照抄：
      ① token 刷新原来是 `void request(...)` 丢弃响应、失败什么都不做（parity 9.23，
      对挂三个月的大屏是致命的）→ 改成自调度链：401 直接登出并提示、网络故障走退避重试、
      整条阶梯都失败才放弃并给不消失的提示；② `useTheme` 的 `watchEffect` 建在**第一个调用者的
      组件作用域**里，而第一个调用者是会话菜单 —— 登出时它卸载，主题切换从此静默失效。
      改成 `effectScope(true)`
- [x] 单测 84 例（新增 78）：路由表与导航高亮、守卫、会话与刷新退避、通知去重、错误边界、
      外壳的地标结构。覆盖率门槛按首测标定 **92 / 85 / 86 / 92**（实测 94.07 / 88.07 / 89.23 / 94.07）
- [x] `lint` 加 `--max-warnings 0` —— P0-f 记的那条门禁在这个 workspace 里先立起来
- 自检 ✅（2026-08-30）：console 84 例 · fleet-core 38 · 后端 287 · 前端 132（**旧前端零改动**）·
  lint / format:check / typecheck / build 全过 · CSS **5.86 KB gzip**（预算 14 KB）·
  **axe 40 次审计零 serious/critical**（11 个界面 × 明暗，含抽屉打开与菜单打开两个瞬时态）·
  17 例旧 e2e 仍全绿（`signIn` 收紧为按名字取导航地标，两套前端都兼容）

**axe 那 40 次审计抓到两个真缺陷，都不是外壳的问题而是设计系统的问题**，所以修在生成器里：

1. **深色下 `ink-subtle` 落在 `surface-raised` 上只有 4.06:1。** 11D 的审计表只审了四组文本配对，
   漏掉的正是这一组，而占位卡、下拉菜单、抽屉全是 raised 底。机理值得记住：**深色的
   `surface-raised`(slate-800) 比 `surface`(slate-900) 更亮**，所以"在 surface 上够用"推不出
   "在 raised 上也够用"。修法：配对表扩到 18 组，深色文本整体上移一档（`ink-muted` 300→200、
   `ink-subtle` 400→300），最差一组变成 5.58:1。同时发现 `ink-subtle` × `surface-sunken` 在浅色下
   只有 4.43:1 且**结构上修不了**，已定为禁用组合并写进 design-system §2.5
2. **会话菜单打开时 `aria-hidden-focus`（serious）。** Reka 的 `DropdownMenu` 默认 `modal`，会给
   页面其余部分挂 `aria-hidden` 但不把里面的元素移出 tab 序 —— 屏幕阅读器被告知外壳不存在，键盘
   却还能 Tab 进去。菜单不是对话框，ARIA 的 menu-button 模式并不要求隐藏页面，所以设
   `modal="false"`；Esc、外点关闭、焦点归还都还在

- [x] 新增 `E2E_BROWSER_CHANNEL` 逃生口：Playwright 自带浏览器的下载在这台机器上会卡住（第二次
      了），设成 `chrome` 就能用已装的 Chrome 本地验证。CI 不设，判定仍以固定版本为准

### PR 12C-2 — E2E 等价性网与 axe 接线

- [x] 两个浏览器 project 跑在**同一次** `playwright test` 里：`frontend`（v1.0.0，全量 17 例）与
      `console`（v3，共享用例 + 自己的外壳 / a11y 用例），共 **34 例**。三个 webServer、一个后端、
      一份种子车队 —— 两个前端都代理到同一个后端，所以"新前端是否等价"问的是同一批数据
- [x] **上一版这条里「`outputDir` / html report 会互相覆盖，需参数化」是我判断错了。** 那个担心
      成立的前提是跑两次 `playwright test`；实际做成一次运行两个 project 之后，Playwright 自己就按
      project + 用例分目录，报告也只有一份。少写了一堆参数化，也少了一处以后会漂的配置。
      端口另加了 `E2E_CONSOLE_PORT`（默认 5298）
- [x] **把 11A 那句"17 例可一字不改复用"按实际情况改准了。** 它成立的前提是语义结构与文案都不变，
      而 11C 决定重构 IA 就意味着导航文案必然变。**做法不是分叉出第二套 spec，而是把差异集中到
      `e2e/support/ia.ts` 一张表里**（落地页文案 / 导航项 / 未知地址的写法 / 登出流程），由
      project 名注入一个 `ia` fixture。这样"不在那张表里的一切"就是两套前端都必须一致的行为，
      而表里每一条都是一个写了理由的决定 —— 分叉会把这两件事一起藏掉
- [x] 共享用例现状：登录 3 例 + 未知地址 1 例，**4 例在网内**。其中登录失败那条一字未改；
      登录成功与 404 那两条改的只是从 `ia` 取文案；登出那条走 `ia.signOut`，console 上多一步
      开菜单（11C §1「个人偏好进用户菜单」的直接结果）
- [ ] **其余 13 例依赖 Phase 13 的页面**，随对应页面逐个转绿。`playwright.config.ts` 里的
      `SHARED_SPECS` 每个 13x PR 扩一次，这份名单本身就是"等价性网覆盖了多少"的可读记录
- [x] 12C-1 那次手工 axe 扫描已落成提交进仓库的 spec（`console-accessibility.spec.ts`）：
      8 条路由 × 四个视口 × 明暗，外加登录页与抽屉打开、菜单打开两个瞬时态。
      **`animation.finished` 在动画被取消时会 reject `AbortError`**（抽屉的过渡就会），必须
      `.catch()`
- [x] console 专属外壳用例 7 例（`console-shell.spec.ts`）：跳转链接真按 Tab 能拿到焦点、
      侧栏收起跨刷新保持、抽屉锁焦点 + Esc 关闭 + 焦点归还触发器、导航后抽屉自动关、
      嵌套深链接直接加载且分区保持高亮（`aria-current` 不误报当前页）、主题跨刷新保持、
      `/wall` 不带外壳。**这些都是单测答不了的部分** —— 焦点真的移动、Esc 真的关闭
- 自检 ✅（2026-08-30）：**34 例 e2e 全绿**（frontend 17 · console 17）· lint:e2e / typecheck:e2e /
  format:check 全过 · 其余 workspace 未改动，测试数不变

### PR 12D — 图表基座

- [x] **`chart-1…8` 系列色进 token 层，且刻意不从 ramp 取。** 理由是结构性的：分类色靠色相彼此
      可分，而这套 ramp 只有 4 条有彩色相，凑 8 个必然出现"同色相两档"的配对 —— 那正是分类编码
      最不该有的东西（第 1 与第 5 条曲线看起来像同一条）。取值用已文档化、已验证的 8 色分类板，
      **并按 NavFleet 自己的表面重跑了校验器**（图表画在 `surface-raised` 上）：明度带与彩度下限
      PASS，CVD 最差相邻 ΔE 9.1 / 8.4（≥8），正常视觉最差相邻 ΔE 19.6 / 19.3（≥15）。
      详见 design-system §2.3
- [x] **对比度 WARN 被当成义务而不是警告。** 浅色 3 个槽、深色 4 个槽低于 3:1，按方法的救济规则
      必须让值能通过第二通道读到 —— 所以 `TimeSeriesChart` 内置数据表视图，**删掉它会让这套
      调色板变成不合规**，而不只是让组件变小。这一条在单测和 e2e 里都有断言
- [x] ECharts 按需引入：`echarts/core` + `LineChart` + Grid / Legend / Tooltip + CanvasRenderer，
      不用默认全量包。已核实产物里零 `BarChart` / `PieChart` / `geo` 等痕迹。顺手摘掉了注册了
      但没人用的 `MarkLineComponent`（省 6 KB gzip）
- [x] 明暗双主题与 token 联动：ECharts 在 `setOption` 时**拷贝**颜色值，所以主题切换必须重建
      option —— `useChartTheme` 监听 `resolved` 主题重读 token。一处坑记下来：`--color-chart-grid`
      解析出来是 `oklch(…)`，而 zrender 自己解析颜色、**不认识 oklch**，所以要过一次 canvas
      `fillStyle` 让浏览器做转换
- [x] 一个轴，结构上就不给第二个：`unit` 是**整张图**的属性而不是每条系列的，所以 option 构造器
      根本表达不出双 y 轴 —— 那是最常见的图表错误，值得让它不可能而不是靠自律
- [x] **性能基线入库（1 / 6 / 8 台 × 500 / 2000 / 5000 点，canvas，真实浏览器）**：
      | 系列 × 点数 | 总点数 | 渲染 |
      | ----------- | ------ | ---- |
      | 1 × 500 | 500 | 19.6 ms |
      | 6 × 500 | 3,000 | 10.2 ms |
      | 6 × 2000 | 12,000 | 12.7 ms |
      | 8 × 5000 | 40,000 | 17.7 ms |
      **结论：在目标规模内 ECharts 完全不是瓶颈，uPlot 的评估可以搁置。** 断言只放在确定量上
      （系列数 / 点数 / canvas 存在），墙钟只打印不断言 —— 与 Phase 10 虚拟化基线同一个做法
- [x] **第一版基线是错的，值得记**：500 点 25ms、3,000 点 1,024ms，这条曲线不可能成立。原因是
      ECharts 的 `finished` 事件在**进场动画之后**才触发，默认约 1 秒 —— 于是量到的是我们自己
      选的动画常数，不是绘制成本。改成 `emulateMedia({ reducedMotion: "reduce" })` 之后数字才
      有意义，顺带把减弱动效这条路径也覆盖了
- [x] 降采样：超过 800 点的系列交给 ECharts 的 **LTTB**（保留尖峰 —— 对遥测来说尖峰就是全部意义，
      均值采样会把它抹平）。后端 history 最多返回 500 点，所以实际数据到不了这个阈值，
      它是为大屏长窗口留的
- [x] **性能基线用一条只在 dev / `VITE_CHART_PERF` 下注册的路由**（`/__charts-perf`），
      产物里既没有它也没有 ECharts（正常构建主包 162.47 KB / 54.39 KB gzip，与 12C-1 一致）。
      加了 `scripts/assert-no-dev-only-chunks.mjs` 接进 `build`，让"测量工具不会随产品发出去"
      是被门禁保证的而不是被记住的
- [x] **图表包体积也量了，作为将来判断的另一半依据**：`VITE_CHART_PERF=1` 构建下 ECharts +
      组件是一个 **519 KB / 176 KB gzip 的懒加载 chunk**。目前不进主包；Phase 13C 真用图表时
      它会变成常态成本，届时这个数字就是取舍的起点
- 自检 ✅（2026-08-30）：console 100 例（新增 16）· **36 例 e2e 全绿**（frontend 17 · console 19）·
  lint / format:check / typecheck / build 全过 · 覆盖率 93.30 / 86.79 / 88.75 / 93.30（门槛 92/85/86/92）·
  lockfile 在 `node:22-alpine` 里生成、零 npmmirror、只多 32 行

**Phase 12 收口 ✅**（2026-08-30，PR #77 / #79 / #82 / #84 / #85）：新 workspace 进 CI 全绿、
设计系统预览页可访问、E2E 等价性网接到新前端且登录流程转绿（其余用例随 Phase 13 逐页转绿，
白名单本身就是覆盖度记录）、ECharts 性能基线入库。

四条留给 Phase 13 的既有结论，写在这里免得再翻一遍：

- **`useSvgViewport` 原样搬，不重写**（13A）。它是 v1.0.0 里花三次尝试才定位根因的文件。
- **`formatNumber(null) → "0.00"` 这个缺陷的期望值要在修它的同一个 commit 里改**
  （`packages/fleet-core/test/formatters.test.ts` 里钉着 3 条），不能悄悄漂。
- **等价性网每个 13x PR 扩一格**（`playwright.config.ts` 的 `SHARED_SPECS`）。
- **图表 chunk 176 KB gzip 会在 13C 变成常态成本** —— 那时再看要不要按页拆。

## Phase 13 — 前端焕新：页面实现

> 每个 PR 一批页面，收口条件都是「对应的 parity 清单项全部勾掉 + 该页 axe 双主题零违规」。
> 顺序按依赖排：先立主干（态势 + 总览），再补纵深（详情 + 曲线），最后是改造幅度最大的告警与历史。

### PR 13A — 设备分区：列表 ⇄ 地图两个视图

> **13A 实际拆成三个 PR。** 盘点之后发现它有一个没写进原计划的前置：`frontend-next/src/stores/`
> 是空的，而这七个文件全靠 props 拿数据（`DeviceSnapshot[]` / `selectedDevice` /
> `sceneDefinition` / `sceneDevices` / `getDeviceTone` / `trailsByDeviceId` / `setMapMode`），
> 旧 store 有 761 行。三刀的边界按「各自可独立验证」切：
>
> - **13A-0 共享判定上提** —— `getDeviceTone` / `deviceToneLabels` / 严重度排序进 fleet-core，
>   消掉三份拷贝。**跨两个前端**，所以它同时是 Phase 12 那条"防分叉"承诺的兑现。
> - **13A-1 数据层** —— fleet store + WS 实时层、顶栏实时状态点与车队名（12C 刻意留空的两个）、
>   生成器补 `--ros-*` 地图 token（`frontend-next/src/styles/` 里现在一个都没有）。
> - **13A-2 设备分区** —— 下面的清单，外加把 `dashboard.spec.ts` 接进 `SHARED_SPECS`。
>
> **收口条件必须包含 e2e 转绿。** 这七个文件零单元测试，`useSvgViewport` 覆盖率 1.07% ——
> 整个回归网只有五条 e2e 断言，不接上等于无网高空作业。

#### 13A-0 共享判定上提

- [x] `getDeviceTone` / `deviceToneLabels` / `DEVICE_TONE_SEVERITY` / `deviceToneRank` 进
      `packages/fleet-core/src/deviceTone.ts`，11 个测试，两个前端（含生产中的旧前端）共用
- [x] **修掉一个 v1.0.0 缺陷**：`Number(device.errorCode?.code) !== 0` 对缺失报码判定错误 ——
      `Number(undefined)` 是 `NaN`，`NaN !== 0` 为真，于是载荷里没有 `errorCode` 的设备被报成
      **告警**。改为先要求 `Number.isFinite`。这个缺陷是"给它写第一个测试"这个动作找出来的
- [x] 删掉三处拷贝：store 里的判定、`GpsMap.vue` 与 `DashboardView.vue` 里逐字复制的文案表
- [x] **覆盖率门槛两边同时调**，这是本条目里唯一值得单独记的工程动作。把覆盖良好的代码搬出
      `frontend` 之后它的比值反而下降（58% → 57.71%），CI 因此变红 —— 这是 Phase 10「虚假 100%」
      那条教训的**反向版本**：数字变差不是因为覆盖变差，是因为被覆盖的代码离开了。
      所以 `frontend` 降到 57，**同时把 fleet-core 从 85/79 提到 86/81** 把搬进来的那部分锁住。
      只降不升就会让"把代码挪个地方"变成一条悄悄卸掉覆盖率的路
- 自检 ✅（2026-08-30）：fleet-core 49 例（新增 11）· 后端 287 · 前端 132 · console 100 ·
  **36 例 e2e 全绿** · lint / format:check / typecheck / build 全过 · 四个 workspace 覆盖率门槛全过
  （fleet-core 87.30 / 82.05 / 89.36 / 87.30，门槛升到 86 / 81 / 87 / 86）

#### 13A-1 数据层

- [x] `frontend-next/src/stores/fleet.ts` —— 从 746 行的 v1.0.0 store 移植：state、派生视图
      （`sortedDevices` / `filteredDevices` / `formations` / `summary` / `groupedAlerts` /
      `sceneDevices` / `trailsByDeviceId`）、`ingestPayload` 的四种入站形状、bootstrap
- [x] `frontend-next/src/lib/realtimeLink.ts` —— WS 层单独成模块（心跳 ping/pong + 指数退避
      1s→30s + 手动关闭），**18 个测试**。旧实现是 store 里的 130 行且零测试；它每一条失败路径
      都在定时器上，放在 store 里测就得连带准备 store 和归一化器才能说清退避
- [x] **修掉一个 v1.0.0 缺陷：连不上的 connect 会终结自动恢复。** 旧实现没有 open 超时，心跳
      只在 `open` 之后才启动 —— 所以一个卡在 CONNECTING 的 socket 既不触发 `close`、不武装 pong
      定时器、也不推进退避。**一次这样的尝试就让整个会话再也不会重连**，界面停在"正在重连"
- [x] **又修掉一个：冷启动期间状态点自称"重连中"**，把一次从未发生的失败报给值班的人。
      `connecting` 与 `reconnecting` 必须分开 —— 正在建立的连接不是正在恢复的连接。这条是
      "把状态点渲染出来断言一次"抓到的
- [x] 顶栏补 12C 刻意留空的两个：**实时状态点（点 + 文字 + `role="status"`）** 与车队名。
      颜色单独承载不了状态 —— 对色盲用户什么都没说，对读屏软件更是完全没说；`role="status"`
      是"链路掉了会被念出来"而不是"只是换了个颜色"的那个差别
- [x] 生成器补 8 个地图 token（6 个 `ros-*` 原值搬迁 + `map-grid` / `map-scale` 取自 ramp），
      并新增 `docs/tools/check-map-contrast.mjs` 机检四组对比度。**机检当场推翻了我写在注释里的
      估计值**（我按 3.2 / 3.5 写，实测 1.59 / 2.70），并暴露一处主题不一致：深色网格比浅色显眼
      近一倍。网格与比例尺**按不同下限判**（装饰参考线 vs 内容图形），理由见设计系统 §2.2.1
- [x] **刻意不搬两样**：`window.vehicleDashboard` 调试桥（无人读它 —— 应用没有，36 条 e2e 断言
      里也没有；把一个接受任意状态的调试面搬进新控制台是白送一个注入点）；两态 `gps|scene`
      地图模式偏好（13A-2 要的是列表/地图/自动三态，现在搬只是搬来一个待删的东西）
- 自检 ✅（2026-08-30）：console **156 例**（新增 56）· fleet-core 49 · 后端 287 · 前端 132 ·
  **37 例 e2e 全绿**（新增 1 条：状态点在真后端上到达"实时"，证明 `/ws` 真的连上了 ——
  单测用的是 stub socket，这件事只有 e2e 能答）· lint / format:check / typecheck / build 全过 ·
  console 覆盖率 93.99 / 85.26 / 89.28 / 93.99，statements/lines 门槛 92 → 93

#### 13A-2a 地图底座搬迁（不含界面）

> **13A-2 又拆了一次，边界是"要不要看着屏幕才能判"。** 底层这一半（引擎、点云、AMap、持久化）
> 可以完全用单测判定对错；两张地图的重建要对着渲染结果判。混在一个 PR 里，等于让 2000 行没有
> 回归网的代码和一堆视觉决策同时进来。

- [x] 搬 `useSvgViewport`(706) —— **原样搬，不重写**。它是 v1.0.0 里花三次尝试才定位到根因
      （bounds watcher 的 `immediate: true` 早于 `onMounted` 测量面板）的文件，重写一遍会重踩所有坑。
      唯一的行为改动是每次 wheel 只测一次 `getBoundingClientRect`（原来两次）
- [x] 补测试：`useSvgViewport` 覆盖率 **1.07% → 98.16%**（35 例）。每一条都钉住源码注释里
      记着的一处缺陷：占位面板尺寸、世界原点移动、22.22x 默认特写、定位偏心
- [x] 搬 `point-cloud`(375)，并**按"要不要 DOM"切成两半**：解析/几何/分类/栅格化（纯运算，
      375 行里的绝大部分）进 `packages/fleet-core/src/pointCloud.ts` 拿到 **30 个测试**，画到
      canvas 的最后 20 行留在各自前端。旧前端改为 import 共享部分，**并刻意继续传原来那对深色
      写死值**，保证生产镜像里的图字节不变
- [x] **修掉点云的主题缺陷**：调色板改为参数**并计入缓存键**。只改成参数而不改键会更糟 ——
      切主题会拿到上一个主题栅格化的 PNG，看起来像切换本身失效了
- [x] **修掉点云缓存无上界**：v1.0.0 只在出错时 delete，每条缓存是一整张场景 PNG 的 base64
      字符串，一个班次的场景数再乘以两套主题，全都回收不了。改为上限 6 条 + LRU
- [x] 搬 `amap`(91)，**并修掉一处会永久挂起的缺陷**：脚本标签已存在时，旧实现给它挂
      `load`/`error` 监听 —— 如果脚本**已经加载完**，这两个事件永远不会再来，promise 永不 settle，
      GPS 地图停在加载态、无错误、无从重试。而这条路径一步就能走到：第一次尝试脚本加载成功但
      `window.AMap` 缺失会 reject 并清掉单飞 promise，第二次调用正好走进这个分支。改为用
      `data-amap-state` 记录脚本自身状态。测试用"50ms 内必须 settle"判定，退回旧实现即红
- [x] 搬 `useSceneViewportPersistence`(87)，**读走内存、写做合并**。`saveViewportState` 是从
      wheel 处理器里调的，旧实现每次同步 `getItem`+`JSON.parse`+`stringify`+`setItem` ——
      触控板一次手势就是每秒 60–120 次主线程同步存储往返，全发生在输入事件处理器里。
      sessionStorage 是本标签页独占且无人旁写，所以内存副本不可能过期；只需在 `pagehide` /
      隐藏 / 卸载时确保落盘
- [x] 搬 `useSceneOverlay`(146)，把调色板一起纳入 watch（栅格是 PNG，切主题必须重画），9 例测试
- [x] 补 `frontend-next/.env.example` 与 `env.d.ts` 声明 —— 旧 amap 的报错文案指向 `frontend/.env`，
      那是另一个项目的文件，照着改不会生效
- [x] **`pointermove` 不加 rAF 节流，这是判断而不是漏做**：函数体是两次 `reactive` 数字写入，
      Vue 的调度器本来就把同一 tick 内的多次写入合成一次重渲染；推到下一帧只会给拖拽加一帧延迟
      而换不到任何东西。真正贵的是布局读取与存储写入，两者分别在上面两条里处理了
- 自检 ✅（2026-08-30）：fleet-core **79** 例（新增 30）· console **220** 例（新增 22）·
  后端 287 · 前端 132 · **37 例 e2e 全绿**（旧前端的 ROS 地图断言原样通过，这是"共享解析器没改
  行为"的判据）· lint / format:check / typecheck / build 全过 ·
  console 覆盖率 94.66 / 85.29 / 92.61 / 94.66（门槛 93→94 / 85 / 86→90 / 93→94）·
  fleet-core 90.28 / 84.72 / 90.74 / 90.28（门槛 86→89 / 81→83 / 87→89 / 86→89）

#### 13A-2b 设备分区界面

- [x] `SceneMap`(SVG 场景图) / `GpsMap`(高德) 重写为新设计：**地图升为页面主体**，设备列表作为
      `complementary` 侧栏（v1.0.0 里地图只是塞满的仪表盘里的一格，约占视口 40% —— 那种尺寸的
      站点图是"地图的照片"而不是能用的地图）
- [x] 补两个点云调色板 token —— 并且**机检把这件事从"挑颜色"变成了"改 alpha"**：浅色第一版
      三组全 FAIL，而原因不是色相。在近白画布上，**64% 不透明度的洗色无论取什么颜色都到不了
      3:1** —— 剩下 36% 透出来的画布本身就把亮度垫在了 3:1 允许的上限之上。所以 alpha 成了调色板
      的一部分（浅色 obstacle 用 220），这是代数结论，不是看出来的
- [x] alpha 也做成 token（`--ros-cloud-*-alpha`，不带 `--color-` 前缀，因为它们不是颜色），
      机检直接读它们而不是把值再抄一遍 —— 这样检查的就是真正会画出来的那个组合
- [x] `GpsMap` 的 `useTheme()` 从 `{ state }` 对齐到 `{ resolved }`。这是一处**运行时会炸但模板
      看着完全健康**的 API 破裂，原样搬会在切主题时才发现
- [x] **规模退化**（11C 决定 2）：三态「自动 / 列表 / 地图」，阈值 **40 台**；显式选择优先于自动
      判定且被记住。12 个测试。另外补了 v1.0.0 的 `gps|scene` 底图偏好 —— **13A-1 的说明把两件事
      混成了一件**：三态那个是"列表还是地图"，`gps|scene` 是"哪张底图"，两者都需要。底图沿用旧
      key（`navfleet:map-mode`），这样 Phase 14 接管旧前端的 origin 时操作员的选择不会被重置
- [x] e2e 契约保住了，并且**由单测显式钉住**：`.map-surface svg .ros-marker.fusion
.ros-marker-core` 是跨 workspace 的契约（组件在这边，断言在 `e2e/`），此前没有任何东西
      说明这件事
- [x] 新增 `e2e/specs/console-devices.spec.ts`（7 例，真浏览器 + 真后端）：地图确实开在选中车辆
      上（同样用测量法）、适应场景反之、两个偏好各自过 reload
- [~] **`dashboard.spec.ts` 不接进 `SHARED_SPECS`，这条计划要改。** 盘完发现它做不到也不该做：
  那份 spec 断言的是 v1.0.0 的**版面** —— `getByRole("article")` 卡片、标题为 车辆信息 的
  `complementary`、侧栏里的设备按钮 —— 因为在 v1.0.0 里地图是那个塞满的仪表盘的一格。
  而 IA 重构的全部意义就是把它们拆成独立页面。共享这份 spec 等于逼新前端复现它要取代的版面。
  **可共享的是行为，不是版面**：真正要紧的两条（地图开在选中车辆上、适应场景反之）已经用
  与旧 spec 完全相同的测量方式写进 `console-devices.spec.ts`，所以移植后的引擎一旦回归，
  两套 e2e 会同时红
- 自检 ✅（2026-08-30）：console **262** 例（新增 42）· fleet-core 81 · 后端 287 · 前端 132 ·
  **44 例 e2e 全绿**（新增 7）· lint / format:check / typecheck / build 全过 ·
  `check:map-contrast` 10 组全过（新增 6 组带 alpha 合成的）·
  console 覆盖率 94.69 / 85.15 / 91.70 / 94.69（门槛 94 / 85 / 90 / 94）

### PR 13B — 总览页（默认落地页，新增）

- [x] KPI 卡（在线 / 活跃告警 / GPS 覆盖 / 编队）+ **需要处理队列** + 告警摘要 + 快速跳转。
      页面围绕一条排序列表建，计数只是它的上下文 —— 调研说值班第一个问题不是"大家在哪"而是
      "此刻哪几台需要我"。健康车辆**排除而不是排在最后**：一张永远是那四十行的列表没人看；
      全部正常时它用一句话说完，那才是有用的答案
- [x] 卡片是 stat tile 而不是图表：四个单数字没有形状可看，把"6 / 7"画成环形图是更差的读法。
      每张卡都带**一个词**而不只是一个颜色 —— 只靠颜色的数字对色盲用户什么都没说
- [x] `summary.gpsCount` 补上了，但**是本地算的而不是读服务端那份**。服务端的 `summary` 是构建
      *快照*时算的，而之后到达的绝大多数是单设备 delta —— 直接读它会让数字和屏幕上的行对不上，
      那比重算更糟。所以补的是"本地也算这一个"，不是"改成信服务端"
- [x] 服务端 `updatedAt` 接上了，但**是新增一个字段而不是替换**。相对新鲜度（"我看的东西有多旧"）
      必须在同一个时钟上量，否则浏览器时钟一偏就出现"更新于 -8 秒前"；而值得**显示**的绝对时间是
      服务端那个 —— 摄入时间戳在后端早已停止产出时看起来依然很新。所以 `lastUpdateAt`（浏览器）
      与 `serverUpdatedAt`（服务端）并存，各答各的问题
- [x] `formation.description`（下发但 v1.0.0 零展示）进编队卡
- [~] **`LaneletOverlay.stats` 没做成"总览页的场景信息卡"，这条计划要改。** nodeCount / wayCount
  是开发者视角的数字，值班的人不需要在总览页看路网有多少个节点。它**真正有用的位置是地图自己的
  图例**：`路网覆盖 · 128 段` 回答了图例本身答不了的一个问题 —— 覆盖层是不是**完整**加载了，
  而不只是加载了。所以它落在 `SceneMap` 的图例里，一行，并由 e2e 断言
- 自检 ✅（2026-08-30）：console **276** 例（新增 14）· fleet-core 81 · 后端 287 · 前端 132 ·
  **49 例 e2e 全绿**（新增 5 例 `console-overview`）· lint / format:check / typecheck / build 全过 ·
  console 覆盖率 94.94 / 85.93 / 91.70 / 94.94（门槛 94 / 85 / 90 / 94，未调）

### PR 13C — 设备详情页（新增，纵深）

- [x] **报码字典**（`packages/fleet-core/src/reportCodes.ts`，24 条 + 16 个测试）。v1.0.0 根本没有：
      设备在三个通道里发 `{ code, info, stamp }`，控制台就把数字和固件附带的那句话原样打印 ——
      于是 `5102` 在有人解释之前什么都不是，也没有任何东西保证同一个数字两次含义相同。
      **模型照抄两个真标准**，不自创严重度：
      · **VDA 5050** 的 `errorLevel`（WARNING / URGENT / CRITICAL / FATAL）**按"车辆还能做什么"定义**
      而不是按"有多糟"—— 能否继续当前任务、能否接受新任务。这是调度员唯一能据以行动的东西。
      它还把 `errorDescription`（成因）与 `errorHint`（怎么处理）分开，所以字典每条都有这两栏。
      · **SAE J1939** 把码拆成 SPN（*什么*坏了）与 FMI（*怎么*坏的）。四位码沿用同一种分离：
      通道 / 子系统 / 具体条件 —— 而且是从 v1.0.0 已有的 1101 / 2203 / 5102 **反推出来的**，不是另立
- [x] **字典当场暴露了演示数据的一处错**：`1101` 同时被用作 定位稳定 与 远程接管中，同号两义。
      有了权威表才看得见 —— 远程接管改为 `1601`，并由测试断言无重码
- [x] **未知码报为未知**，带原始数字与车端原文，绝不猜。控制台编一个听起来合理的含义比承认不知道
      更糟，因为有人会照着它行动。这也是大多数真实部署在拿到自己码表之前的诚实状态
- [x] 单车体检：报码解读（页面第一屏）+ 实时遥测分组面板 + ECharts 历史曲线
- [x] **速度与电量画两张图，不画双 y 轴**：m/s 与 % 共用坐标轴等于把交点交给挑刻度的人 ——
      `TimeSeriesChart` 每图只收一个 `unit`，双轴在类型上就不可表达
- [x] 接上此前落库却未展示的字段：`speedLimit`（limit / slowdownTime / moduleName）、
      `controlMode` / `gear` / `omega` / `platformTaskStatus`（枚举文案，不是裸数字）
- [x] **面板按"有没有数据"显隐**，不是能力系统（那是 P1-b，刻意不在这里建）：一屏 `--` 比没有这屏
      更糟，它读起来像数据丢了。`gpsEnabled === false` 与"有接收机但暂无定位"是两个不同的答案
- [x] 顺手改掉两条 e2e 断言：详情页标题从"设备 <id>"变成**车辆名**（操作员认的是名字），
      id 留在副标题。两处断言是对着占位页写的，不是回归 —— axe 本身一条没报
- [ ] `tags` 变成可用的筛选与展示维度（6 台车各 2 个标签，现在全链路搬运却零 UI）→ 顺延到 13D，
      它属于"列表筛选"那一批而不是详情页
- [ ] `extra.temperature` / `networkQuality` / `vehicleModel` 仍未展示 → `vehicleModel` 归入 P1-e；
      另两个等 13D 的筛选/列表列一起做
- [ ] `mapProfile` / `runtimeSceneId` vs `sceneId` 的差异是否值得暴露 —— 按 11A 的去留结论执行
- 自检 ✅（2026-08-30）：fleet-core **97** 例（新增 16）· console **292** 例（新增 16）·
  后端 287 · 前端 132 · **50 例 e2e 全绿**（新增 1）· lint / format:check / typecheck / build 全过 ·
  console 覆盖率 95.24 / 85.92 / 91.81 / 95.24（门槛 94 / 85 / 90 / 94，未调）·
  fleet-core `reportCodes.ts` 100% statements

### PR 13D — 告警中心（等价优先，深化留 Phase 16）

> **拆成两个 PR。** 等价 + a11y + URL 状态是一块可独立验证的交付；声音提醒有自己的设计面
> （解锁流程、免打扰、只给 critical）与自己的测试方式（浏览器自动播放策略）。混在一起，
> 声音那部分的判断会被埋在一个大 diff 里。

#### 13D-1 等价与可用性

- [x] 与旧版功能等价：严重度分桶 / 设备筛选 / 搜索 / 确认 / 分页，`aria-pressed` 保留
- [x] **筛选状态进 URL，且 URL 是唯一事实来源**（不是 `ref` 的镜像 —— 两份副本必然漂移）。
      一个把列表收窄到某台车 critical 的主管，现在可以把链接发给值班的人；v1.0.0 里同一个视图
      只能用嘴描述
- [x] 确认按钮是**说明自己是开关的开关**（`aria-pressed` + `aria-label`），不是靠颜色表意的按钮
- [x] 空态是 `role="status"` —— 筛到零必须被念出来，而不是留下一块空白面板
- [x] 行可点进设备详情（此前诊断一条告警要先读设备编号再去找它）
- [x] **批量确认带撤销**，为此给 toast 系统加了 action 支持（`useNotifications` + `NotificationHost`）。
      批量操作既容易误触又难手工还原，而 toast 正是人当时在看的地方。
      两处细节：撤销**只还原这次真正改动的 id**（还原一个本来就已确认的 id 等于抹掉别人的工作）；
      点了撤销就关掉 toast（把"撤销"留在屏幕上等着被再点一次 = 撤销撤销）
- [x] **确认只存浏览器这条限制写在页面上**，不是埋在注释里。已知的限制和沉默的限制对值班的人
      长得一样。落库 / 操作人 / 时间留 Phase 16，`/api/v1/alerts` 也还是零调用
- 自检 ✅（2026-08-30）：console **320** 例（新增 28）· fleet-core 97 · 后端 287 · 前端 132 ·
  **54 例 e2e 全绿**（新增 4 例 `console-alerts`）· lint / format:check / typecheck / build 全过 ·
  console 覆盖率 95.22 / 86.42 / 92.65 / 95.22（门槛 94 / 85 / 90 / 94，未调）

#### 13D-2 声音提醒（11C 决定 4）

- [x] **解锁即是那个可供性本身。** 浏览器不允许在没有用户手势的前提下开始播放（`AudioContext`
      建出来就是 `suspended`），所以控制台不能自己决定要出声 —— 必须有人点一下。于是**报告状态的
      那个控件就是解锁的那个控件**：一个人为了"让声音能响"而点的这一下，正好就是策略要求的手势。
      这不是把解锁塞进某个角落，是让可供性与手势合成一件事
- [x] **只给 critical。** 预警与提示不出声：一个每条预警都叫的控制台，一个班次内就会被拧掉音量，
      而被静音的喇叭比没有喇叭更糟 —— 它看起来像有覆盖，实际没有
- [x] **未解锁时说出来。** 顶栏显示"声音未启用"并解释原因。静默地不响是这里唯一绝对不能有的行为：
      它和"什么事都没有"长得一模一样
- [x] **第一次观测只播种、不出声。** 登录时车队已经有四条 critical，不该响四声。首次调用记下已有的
      集合并保持安静，只有*之后*出现的条件才播报 —— 这也是 `announce` 收整个集合而不是单条的原因
- [x] 静音 / 音量（轻·中·响）/ 免打扰（关闭·夜间 22:00–07:00）三项进用户菜单，与主题偏好同处
- [x] **免打扰窗口跨零点**，这是那种"看着对、实际错"的比较：`from <= h && h < to` 在起点晚于终点时
      会静默地把整个窗口关掉 —— 而每一个夜间窗口都是这样。单独导出 `isQuietAt` 就为了钉住它
- [x] 突发合并（4s 节流）：二十条同时到达，对屋里的人是一件事。**静音/免打扰期间仍然消费 id**，
      所以午饭回来解除静音不会把这段时间发生的一切重播一遍
- [x] **用 Web Audio 生成音调而不是打包音频文件**：public 仓库里不多一个二进制、关键时刻不多一次
      可能失败的 fetch，而决定性的理由是**声音的形状因此可测** —— 假 `AudioContext` 能断言两个音符
      按配置的音量排进了时间线；`<audio>` 元素只能断言"被要求播放过"
- [x] 20 个测试 + 2 条 shell 断言
- [x] **顺带修一处结构性问题：axe 那条"每个路由 × 每个视口"的测试拆成按视口一条。**
      8 路由 × 4 视口 = 32 次 axe 分析，而 axe 不快 —— 合成一条就是几分钟对着 45s 的预算，
      本地（热的 dev server）勉强过、CI 冷机就超时。而超时**什么信息都不给**：不知道是哪个路由、
      哪个宽度慢。拆开后每条 8 次分析、各有各的预算，失败时标题里就写着是哪个视口。
      **正确的修法是拆，不是把超时调大** —— 调大只是让下一次超时来得更晚
- [~] **刻意不加 e2e。** 解锁成不成功取决于浏览器的自动播放策略，而 Playwright 给 Chromium 传的
  策略标记与真实浏览器不同 —— 断言它等于断言测试夹具的开关，不是断言产品。可确定断言的部分
  （控件存在、未解锁文案、`aria-pressed`）已由单测与 axe 覆盖
- [ ] 自定义免打扰时段（任意时间段）留待有设置页时再做 —— 一个时间区间需要一个表单，而这套 IA
      刻意没有设置页。**这是推迟，不是"预设等于自定义"**

### PR 13E — 历史回放

- [x] **历史回放不是页面，是设备详情的一个 tab。** `docs/frontend-ia.md` 早就写了理由：独立页的
      代价是工程师查完实时还要在历史页**重新选一次设备** —— 那正是 11B 审计里那条"6 步且拿不到
      答案"排故流程的一半。于是设备详情改成 **实时 · 曲线 · 历史回放** 三个 tab，设备由路由决定，
      剩下要选的只有时间窗
- [x] **tab 名进 `?tab=`。** "看一下 c12 的回放"因此是一个链接而不是一句带步骤的话。用 `replace`
      而非 `push`，所以返回键离开这台设备，而不是在 tab 之间倒着走
- [x] 搬 `useHistoryPlayback`(123)，重写回放条 —— 进度滑块与倍速下拉的 `aria-label` 保留
      （Phase 10 被 axe 抓到的 critical）。附一处行为修正：到达最后一帧**即停**，v1.0.0 要等下一个
      tick，所以按钮在轨迹已经结束后还会显示"暂停"最多 600ms
- [x] **修 `trailsForMap` 的 O(N²)**：位姿改为每条轨道只提取一次（5000 样本 4x 播放从约 1250 万次
      降到 5000 次），轨迹增量维护（+1 就 push，只有拖动才重建）。**测试数 `poseOf` 的调用次数而
      不是计时** —— 在共享 CI runner 上断言耗时是在断言 runner。
      **没有**顺手声称修掉 SVG path 的重建：把不断变长的折线序列化成 `d` 是每帧 O(n) 且是画折线本身
      固有的，几百个点的量级下那是字符串拼接而不是解析。原注释overclaim了，已改
- [x] 回放时的遥测曲线联动：`buildCursorPatch` 只下发一条 `markLine`，**不进 option**。
      游标每秒最多动 12 次，把它折进 option 就会每帧重新推导每条序列的点数组 —— 正是
      `useHistoryPlayback` 要消除的那类错误，只是把分配从轨迹搬到了图表
- [x] 顺带核销 parity 第 5 节里的五处 🟡 与四处 ⚠️：
      **删掉 最大点数 输入框**（它的 `min/max` 因无 `<form>` 从不生效，服务端又按自己的
      `MAX_HISTORY_POINTS` 硬夹，所以填 5000 拿到 500）→ 改为**不发 `limit`**、由部署的上限说话，
      并**如实报出实际覆盖的时间跨度**；是 `<form>` 所以 Enter 能提交；进页面即加载；快捷范围直接
      查询；`from > to` 在发请求前就拒绝；换设备重置回放；拖动滑块即暂停；缺场景定义有自己的空态
      （v1.0.0 那一支同时承担"还没加载"与"有数据但没地图"，于是让人去按一个已经按过的按钮）
- [x] **浏览器套件抓到一处单测看不见的缺陷：窗口的结束时间被向下取整到整分钟。**
      `datetime-local` 的值是一个*分钟*而不是一个瞬间，`slice(0, 16)` 于是把 `now` 抹掉最多 59 秒 ——
      23:14:37 点「最近 1 小时」，请求的窗口在 23:14:00 结束，**最新的那些采样被安静地丢掉了**。
      对一个实时监控台来说那正是最不该截的一端：人打开这个 tab 就是为了看最新的。e2e 里表现为
      滑块 `max="1"`（6 条只回来 2 条）。修法是把分钟精度区间的结束读成**那一分钟的结束**。
      v1.0.0 有同一处取整，只是它的预设不自动查询、按钮总是稍后才按，所以从没露出来
- [x] e2e 新增 `console-playback.spec.ts` 5 例（`history.spec.ts` 不并入 `SHARED_SPECS`：它断言的是
      v1.0.0 那个页面 —— 一个叫「设备」的下拉、一个必须按的「加载轨迹」、一组 `article` 单元格，
      三者都是这次故意去掉的）；axe 路由表加入 `?tab=playback`，因为无名滑块正是 Phase 10 抓到的
      那条 critical，而只审 实时 tab 永远到不了那里
- 自检 ✅（2026-08-30）：console **394** 例（新增 74）· fleet-core 97 · 后端 287 · 前端 132 ·
  **65 例 e2e 全绿**（新增 5 例 `console-playback`）· lint / format:check / typecheck / build 全过 ·
  覆盖率 95.38 / 86.71 / 91.69 / 95.38（门槛 94 / 85 / 90 / 94，未调）

### PR 13F — 管理的两个子页面 · 告警史 · 收尾

> **13F 的原条目与 Phase 11 签字的 IA 冲突，已按 IA 纠正。** 原文写「设置页（主题 / 清本地数据 /
> 连接诊断）」和「404 + 错误页」，而 `docs/frontend-ia.md:26` 的决定是**不做设置页**：
> 「主题等个人偏好进用户菜单，连接诊断进「管理 / 系统状态」」—— 主题已在 13D-2 进了用户菜单，
> 照原条目做等于新建一个 IA 决定要拆掉的页面。404 与错误页则**在 13B/13C 就已经做完**
> （`NotFoundView` 打印实际地址而非静默跳转，`ErrorBoundary` 覆盖率 100%，e2e 有 `not-found.spec.ts`）。
> 真正属于 13F 的，是 `AdminView` 自己标着 `PR 13F` 的两张卡，加上 IA 的 L3 四个 tab 里还缺的告警史。
> 拆成两个 PR，理由同 13D：两块各有独立的设计面与验证方式。

#### 13F-1 管理 / 系统状态 · 管理 / 场景

- [x] `/admin` 按 `/devices` 的既有模式加 children（`""` + `system` + `scenes`）。
      `router-link-active` 跟的是 matched records，所以**嵌套才是让子页保持分区高亮的东西**；
      同时聚合区仍有真落地页而不是重定向进第一个子页（C2）
- [x] **系统状态：这一页回答的是"该打给谁"。** 顶栏那个状态点只报**一条**链路，而看到「重连中」
      的人分不清三件事里坏了哪个：`浏览器→后端`、`后端→broker`、`后端→Mongo`。
      于是两端都读：`/health/ready`（公开、dev 走 Vite 代理、生产走 nginx `location /health`）是
      后端对自己的报告，和控制台对自己 socket 的判断并排放，就把「我连不上后端」和
      「后端连不上 broker」分开了 —— 那是两个不同的电话
- [x] **503 是答案不是错误**：快照初始化期间端点就返回 503，把它当请求失败会正好藏掉它唯一要报的
      那个状态。只有 fetch 抛异常才是"后端不可达"，而那件事本身就是诊断，所以它渲染成诊断而不是
      「加载失败」
- [x] **Mongo 掉线报降级、broker 掉线报故障。** store 没有 Mongo 也照样服务，把运行中的降级部署说成
      critical 就是喊狼来了；真正丢的是历史，页面就这么说。而 broker 断开的表现会被读成「车都停了」，
      所以那一条把界面会长什么样写出来
- [x] **两个时钟并排**：`serverUpdatedAt`（后端打的）与 `lastUpdateAt`（本标签页收到的）。
      时钟偏移只有这样才看得见 —— 否则一个走偏的浏览器读起来像一支不再上报的车队
- [x] **本地留存清单按 `navfleet:` 前缀扫出来，不写死列表。** 手维护的清单正是诊断页最容易过期的
      东西：parity §8.8 记了 5 个 key，今天实际有 **9 个**（13D-2 加三个声音偏好、13A-2b 加
      device-layout）。一个回答"这个浏览器留着什么"的页面，必须**没有能力**跟答案发生漂移；
      不认识的键也列出来，而且那才是有意思的情形
- [x] 清除**之后重新加载**，并把这件事写在页面上。写这些键的模块都是加载时读一次的单例，
      不重载的话旧偏好会继续生效 —— 那种半个动作读起来就像坏了
- [x] **场景页只读，而且这是产品决定不是缺功能。** 改场景等于改车辆定位所依据的地图，
      那不是一个只读监控台该做的事。这一页的职责是**解释**一张地图，不是改一张
- [x] **每个配置了的资源都真去取一次。** 这一页存在的理由：地图上「没配底图」和「配了但 404」
      长得一模一样。Phase 1 就带着 `scenes.json` 指向三个不存在的 SVG 上线过，缺陷 9.4 是栅格底图
      **静默**失败。检查用 `GET` 带 `Range: bytes=0-0` 而不是 `HEAD`：点云可能有几十 MB，
      而有些部署回答 HEAD 的代码路径与 GET 不同 —— 要测的是地图自己会走的那条路
- [x] 落地页上做好的分区是**链接**（solid 边框 + 「已就绪」），没做的是 dashed 且不可点。
      一张看起来能点却不能点的卡片，会让这一页比一份纯列表更糟
- [x] **axe 抓到一处真的结构错误**：我把每条检查写成 `dl > div > div > dt`，而 `<dl>` 只允许
      `dl > div > (dt, dd)`、不能再深，且不能有 `<p>` 兄弟。改法不是加 `role` 绕过去 —— 每行带的是
      标签 + 状态 + 一句"这会让你看不到什么"**三样**东西，那本来就不是术语/定义对，所以改成 `ul`。
      旁边两个真正是 label→value 的小面板仍然是 `dl`
- 自检 ✅（2026-08-31）：console **420** 例（新增 26）· fleet-core 97 · 后端 287 · 前端 132 ·
  **71 例 e2e 全绿**（新增 6 例 `console-admin`）· axe 路由表加入 `/admin/system` 与 `/admin/scenes`
  （11 路由 × 4 视口 × 双主题零违规）· lint / format:check / typecheck / build 全过 ·
  覆盖率 96.14 / 86.44 / 91.05 / 96.14（门槛 94 / 85 / 90 / 94，未调）

#### 13F-2 告警史 tab · 键盘可达性复核 · 代码分割

- [x] **设备详情的第四个 tab「告警史」**，IA 的 L3 四项到齐（实时 · 曲线 · 历史回放 · 告警史）。
      它是 `/api/v1/alerts` 在整个控制台里的**第一个消费者** —— 13D-1 明确记了那个端点当时零调用，
      告警中心用的是 store 里的实时告警
- [x] **查过之后的结论是：不复用告警中心的行，也不抽共享组件。** 两者的数据源本质不同 ——
      告警中心渲染的是**实时**告警，按定义全都活跃，所以它从不显示 `ts` / `clearedAt` / `active`；
      而那三样恰恰就是"历史"的定义：什么时候发生、什么时候结束、现在还在不在。再加上两处在设备
      自己页面上没有意义的东西：跳回设备页的链接（你已经在这台设备上了）与确认开关（确认一条已清除
      的告警等于什么都没确认）。把这些都参数化掉，得到的是一个每个调用点都要关掉一半的组件
- [x] **空态说清缺的是 MongoDB，并链到能回答这件事的那一页。** `queryMemoryAlerts` 只保留活跃告警，
      所以没有 Mongo 时 `status=cleared` 恒返回空 —— 一台出过很多问题的车和一台从没出过问题的车
      长得一模一样。这不是可以耸肩带过的状态：文案说出缺的是什么，并链到 管理 / 系统状态，
      那是唯一能说出"它此刻连上了没有"的页面。**这也是 13F-1 那一页第一次被别处引用**
- [x] 无时间戳的记录排最后并显示 `--`，而不是自称就是现在（`formatDateTime` 内部回退
      `Date.now()`，照抄会把一条没有时间戳的记录标成"这一秒"，还把它排到最前）
- [x] **键盘可达性复核，逐个核了全站 6 处可滚动容器。** ROADMAP 提防的那个坑（`.detail-scroll`：
      可滚动但内部无可聚焦元素，键盘用户到不了里面的内容）真的存在两处，而且都是**我自己引入的**：
      `TimeSeriesChart` 的数据表（`max-h-96` + 最多 500 行）与 系统状态 的留存清单表。
      两者都是纯表格，没有任何可聚焦元素，所以没有指针就无法滚动（WCAG 2.1.1；axe 叫
      `scrollable-region-focusable`，它只在容器**真的溢出时**才报，所以此前没抓到）。
      修法是 `tabindex="0"` + `role="region"` + 可访问名 —— 让那个 tab 停靠点是可被念出来的，
      而不是一个来历不明的落点。另外 4 处（外壳主内容区、设备列表、设备侧栏、总览待处理车辆）
      内部都有可聚焦元素，**确认无需改动**
- [x] **把三个非默认 tab 面板做成异步组件，并按测量决定。** tab 边界正好就是分割点：Reka 不挂载
      未激活的面板，所以"还不需要"和"还没加载"是同一条线。
      量出来的效果比预期大得多 —— 设备详情的 chunk **564 kB → 14.5 kB**（gzip 191 → 5.5 kB），
      ECharts 移入按需加载的 `TimeSeriesChart` chunk（535 kB）。也就是说，在 实时 tab 上打开一台车
      不再为了渲染六个文字面板而下载整个图表库。`>500 kB` 那条警告现在指向库本身而不是某一页，
      这是它该指的地方。e2e 直接断言浏览器实际请求了什么，而不是只信 bundle 报告
- [x] **顺带修一处这次改动引入的测试脆弱性**：动态 import 需要几个 tick 取决于是否有别的测试文件
      预热过模块缓存 —— 正是那种"单独跑绿、一起跑红"的东西。改成等条件（有面板出现内容）而不是
      等固定 tick 数；连跑三遍稳定
- 自检 ✅（2026-08-31）：console **432** 例（新增 12）· fleet-core 97 · 后端 287 · 前端 132 ·
  **73 例 e2e 全绿**（新增 2 例 `console-devices`）· axe 路由表加入 `?tab=alerts`
  （13 路由 × 4 视口 × 双主题零违规）· lint / format:check / typecheck / build 全过 ·
  覆盖率 96.19 / 86.07 / 91.14 / 96.19（门槛 94 / 85 / 90 / 94，未调）

### Phase 13 收口 — ✅ 完成（2026-08-31，PR #118 合入 `f2b506e`）

四个页面与四个 tab 都建完了（13A–13F），**收口的条件是 parity 清单全部勾掉** —— 现已全部勾完：
340 行逐行比对新前端，**271 通过 / 69 未通过**，未通过的每一行都有去处（13S / 13T / Phase 15/16 /
判定为建议未采纳）。这件事以"读旧实现 + 对新实现"为主，独立成 PR #118 的 5 个 commit 完成，
没有塞进任何建设 PR 的尾巴。

**收口不等于缺口清零**：它的产出是**一份有去处的缺口清单** —— 13S 的 5 条缺陷、13T 的约 30 条
能力损失、6 件待负责人定的事 —— 以及一条比人工逐行读更可靠的**可机检指纹**（见下）。

- [x] **`docs/frontend-parity.md` 第 1–4、6–8 节逐条核销** ✅（2026-08-31，第 5 节 ✅ 13E）。
      **全 8 节 340 行核销完毕：271 行通过，69 行未通过。**
  - [x] 第 1 节 应用外壳（19）· 第 4 节 GPS 地图（22）· 第 6 节 告警中心（25）· 第 7 节 设置/登录/404（30）
        —— 96 行里 81 通过，**15 行真丢了能力**
  - [x] 第 3 节 ROS 场景地图（89）—— 64 通过。**两处「不可省的补偿」都在且时机正确**
        （`hasMeasuredPanel` 真的在 setup 期拦住了那次 `immediate` watcher；`rebaseOffsetsToBounds`
        真的排在 hydrate 判断之前），各有一条把因果注释与实测数字钉住的单测。丢的是**视觉编码**
  - [x] 第 8 节 全局机制（53）—— 49 通过。产出是那张**死导出清单**
  - [x] 第 2 节 Dashboard（63）—— 39 通过。**「拆页」影响最大的一节**：编队区整段与设备列表两列 +
        行级视觉是**功能缺席而非形态变化**，2.6 逐字段另查出 4 处字段级损失
  - **69 行未通过的构成**：约 30 行是真能力损失（→ 13T）· 约 20 行是原表标 🟡 的建议未采纳
    （双指缩放 / 缩放按钮 / 平移软边界 / 比例尺 / 加载态等）· 其余归 Phase 15（`meta.roles`、
    全局 401、记住我）与 Phase 16（ack 落库、告警端点接入）
  - **贯穿全节的一条规律**：「声明了但无人消费」是 parity 缺口的**可机检指纹**，三层都成立 ——
    store 导出（12 个死导出，8 个对应缺失 UI）· composable 导出（`cycleTheme` /
    `acknowledgedCount` / `clearAll` / `clearSavedSceneViews`）· 设计 token
    （`--color-ros-lanelet-bg` / `--color-map-scale`）。**13T 之后应当把它做成断言**
- [x] e2e 在新前端全绿：**73 例**（console project 覆盖 shell / 总览 / 设备 / 告警 / 回放 / 管理 /
      图表 / 登录 / 404）
- [x] axe 零违规：**13 路由 × 4 视口 × 双主题**，远超原定的"5 页 × 双主题"
- [x] **第 9 节那 30 条缺陷逐条标注「已修 / 仍在 / 不修及理由」** ✅（2026-08-31，见
      [frontend-parity.md](docs/frontend-parity.md) 第 9 节末「核销结果」）。**原先这里写的是 29 条，
      数错了** —— parity 第 11 节一直写着 30 项。结果：**已修 19 · 部分 3 · 仍在 7 · 不适用 1**，
      每行给 `file:line` 而不是给一个勾
  - 两处对原判断的更正：**9.23 不必等 Phase 15**（12C-1 已做，token 刷新失败必须有人告诉用户）；
    **9.6 的修法与原设想相反** —— 不是补一次落盘，而是去掉「选编队顺手改写用户选的地图模式」那次
    强制。口径不一致的根源是那次强制
  - 「仍在」的分布不随机：5 条归 13S 的里有 3 条（9.4 / 9.7 / 9.28）都在 `SceneMap.vue`，都是
    13A-2a **地图底座搬迁时逐字搬过来的**；另 2 条（9.1 / 9.19）在 `fleet-core`，是 12A「抽取不改
    行为」的刻意结果 —— 它们的测试当时就照着**错误行为**写，修的时候要连测试一起改。
    两次「先搬后修」的决定都是对的（搬迁与修缺陷混在一个 PR 里，出问题分不清是哪一半），
    代价就是收口时要补
  - 2 条留 Phase 15（9.12 登出不清 store · 9.24 无全局 401 拦截）—— 它们是同一处会话边界，
    拆开做会把同一处逻辑写两遍
  - 5 条归 **13S**（见下），其中 9.1 是唯一会改变**已发布产品**行为的一条

**测得的基线（2026-08-31，`main` @ `9f39719`）**：fleet-core **97** · backend **287** ·
frontend **132** · console **443** · e2e **73**。（PR #118 只改文档，这五个数字在 `f2b506e` 上不变。）

> 顺带更正一处记账：13R-A 自检记 436、13R-C 记「447（新增 5）」，两者与这次实测的 443 都对不上，
> 且 436 + 5 也不等于 447。**各 PR 条目里的例数是当时自报的，没有一处是复核过的**，所以从现在起
> 阶段级数字只认这一行实测。这不影响任何 PR 的绿灯结论（每次 CI 都是全绿），但它说明"顺手报个数字"
> 会累积成一串互相矛盾的记录。

（原「Phase 13 收口」一行的三条已并入上面那一节并逐条给出现状，因为其中两条已经超额达成、
另外两条还没开始 —— 合在一句话里读不出这个差别。）

### 13R — 第一轮人工检查的回归（2026-08-31）

负责人在本地起真实链路（真 broker + Mongo + mock 发布器）逐页点过一遍，提了 7 条。逐条核实后
分三个 PR 交付；**其中一条是我把用户的诊断量反了，记在这里因为结论比症状更有用。**

#### 13R-A 控件与可达性

- [x] **列表点设备到不了详情，这是本轮最严重的一条。** 列表页那一格调的是 `selectDevice`，只设置
      地图的选中项、**根本不跳转**；而总览的「需要处理」列表虽然是链接，却 `filter(tone !== "normal")`
      且只取 6 行。合起来的后果是：**一台状态正常的车，它的四个 tab 用鼠标点不到** —— 13C/13E/13F-2
      建的报码解读 / 曲线 / 历史回放 / 告警史对大多数车辆不可达。
      改成链接（离开时仍设置选中项，所以回到地图还落在这台车上）。
      **e2e 里原本有一条测试正在保护这个错误行为**（「picking a vehicle in the list selects it for
      the map」），所以它必须跟着改 —— 断言写成了行为的样子，就会把缺陷一起钉住
- [x] 地图视图也要能进详情（`frontend-ia.md`：从列表、地图或告警任何地方都能进）。地图侧栏那份列表
      点击仍然是**选中**（那是它的职责，地图必须被告知以谁为中心），detail 由选中项带一个链接，
      而不是给每一行加第二个控件
- [x] **GPS/场景 移到 自动/列表/地图 左边。** `PageHeader` 的 actions 是右锚定，所以一个在右侧
      出现/消失的按钮组每次切到地图都会把常驻那组推向左边 —— 控件从指针底下跑掉。让会消失的那组
      排在前面，常驻的那组就钉住了
- [x] **声音按钮解锁之后成为静音开关。** 原来解锁后点它什么都不做 —— 一个报告状态、邀请点击、
      然后无视点击的控件，读起来就是坏的。它拥有的开关是**静音**；免打扰是时段，留在用户菜单里，
      所以免打扰时段内点击仍然翻转静音，title 说清是哪一个在让它不响
- [x] 顺带修正它的可访问名：原来只有状态词（"已静音"），说了状态却没说这是什么控件。改成
      `告警声音：<状态>`，既说明控件又保留状态 —— 也让测试不必按可见文字去找它
- [x] 两处测试脆弱性一并修掉：`find("button[aria-pressed='false']")` 在按钮组换序后**静默地开始点到
      另一个控件**、并因此不再断言任何东西；按可见文字找声音控件会在它显示"已静音"时失效
- 自检 ✅（2026-08-31）：console **436** 例（新增 4）· **73 例 e2e 全绿** ·
  覆盖率 96.25 / 86.34 / 91.47 / 96.25（门槛未调）

#### 13R-B 总览版面与浅色警示色

- [ ] 四张统计卡卡内加分解明细（在线卡列离线车名、告警卡分三档严重度、GPS 卡列无定位的车），
      用已有数据填充，不新增接口
- [ ] **浅色模式的警示信号：用户报「数字颜色不清晰」，但量出来浅色对比度更高** ——
      `warning-ink` 10.59:1 / `critical-ink` 11.05:1（对 white），而深色只有 7.45 / 6.63
      （对 slate-800）。所以不是对比度不足。真正的问题是 `amber-800`/`rose-800` 落在 **L=0.37**，
      在那个明度上**色相辨认不出来**：数字读起来只是"深色文字"，"这是警示色"那层信息没传到；
      深色模式用 L=0.88 的 amber-200/rose-200，一眼就是琥珀/玫红。
      修法按项目图表已在守的规则：**文字穿文字色，颜色靠旁边的标记承担** —— 大数字回 `text-ink`，
      状态交给一个饱和度足够的小色块

#### 13R-C 告警列表抖动

- [x] **排序键每秒都在变。** `allAlerts` 与 store 的 `groupedAlerts` 都按 `ts` 倒序排，而报码告警的
      `ts` 取车端上报的 `stamp`、**每个遥测周期刷新一次**：同一严重度桶内所有行的时间戳每秒一起跳到
      "现在"，先后由毫秒级差异随机决定 → 每秒重排一次，看起来就是闪烁。
      **这不是演示数据的问题**：真实车辆同样周期上报，同一个错误码会带着新 stamp 反复到达
- [x] store 新增 `alertFirstSeen`（`Map<alertId, epochMs>`），`groupedAlerts` 暴露 `firstSeenAt`，
      两处排序都改成 **onset 倒序 + id 兜底**。`id` 那一层不是多余的：两条同一毫秒开始的告警否则
      每次重算都会互换 —— 同一个缺陷的缩小版
- [x] **刻意用普通 `Map` 而不是响应式状态。** `groupedAlerts` 会因为同一次 ingest 里 `devices` 变了
      而重算，所以这个映射不需要成为依赖；而给每条告警建一个响应式条目是没有读者的开销
- [x] **清除时必须剪枝，这不是打扫卫生。** 不剪，映射会随标签页寿命一直长（正是 P0-d 在后端描述的
      那个失效模式）；更直接的是，一条清除后又复发的告警会继承**第一次**的 onset，排起来像是从没
      消失过。测试专门钉了复发拿到新 onset
- [x] 顺带修掉第二个抖动源：告警行原本渲染 `formatDateTime(alert.ts)`，而那个值每秒都在变 ——
      **那一行文字每秒重写一次**。改成显示 onset，这也更符合「一份事件清单」的语义；
      "最后上报"仍在数据里，只是不再决定顺序、也不再显示在这一行
- 自检 ✅（2026-08-31）：console **447** 例（新增 5）· **73 例 e2e 全绿** ·
  覆盖率 96.30 / 86.42 / 91.53 / 96.30（门槛未调）

#### 13R-D 深色边框与回放窗口高度

- [x] **深色模式的 `--color-border` 与 `--color-surface-raised` 是同一个值**（都是 `slate-800`），
      对比度 **1.00:1**。人工检查报的是「顶栏那条竖线看不到」，而那只是最明显的症状：全站每一处
      `border-border` + `bg-surface-raised` 的卡片边框在深色下都是隐形的 —— 卡片还能靠自身填充
      （slate-800）与页面（slate-900）的差别勉强分辨，画在**同一层表面**上的分隔线就彻底消失。
      整体上移一档：`border` 800→700（对 raised 1.47:1）、`border-strong` 700→600（2.15:1）；
      浅色侧 border 对 white 是 1.43:1，改完两个主题基本对称。判定标准取
      `check-map-contrast.mjs` 给装饰性参考线用的 ≥1.3:1 —— 边框正是这一类结构性图形，不是文本
- [x] 改的是 `docs/tools/gen-design-system-preview.py`（`semantic.css` 第一行写着"由它生成，不要
      手改"），然后重新生成 —— 预览页与 token 因此同源
- [x] **加了一条 token 层的回归断言**：任何主题下 `border` / `border-strong` 都不得与三个 surface
      同值。**已验证它能抓到原缺陷** —— 把深色 border 临时改回 slate-800，这条断言立刻红，
      报「border 与某个 surface 同值」
- [x] **回放窗口：量出来主因不是间距，是地图自己 697px 高。** `min-h-80` 只是下限，`SceneMap`
      在无高度约束的 flex 列里长满内容。641px 高的窗口上，地图底边在折叠线下 **421px**、
      进度滑块在折叠线下 **441px** —— 要滚动才能按到「播放」。
      三处改动后（地图高度 `clamp(16rem,42vh,34rem)`、删掉与 tab 名重复的「轨迹回放」标题、
      padding/gap 各收一档）**实测**：地图 308–578、滑块 594–610，**两者都在 641px 折叠线内**
- [x] 删掉那个可见标题不是纯省空间：它就写在标着「历史回放」的 tab 下面，**同一件事说了两遍**。
      section 的可访问名改由 `aria-label` 承担，地标名没丢；进度读数挪到控件行 ——
      它描述的是播放头，本来就该在移动播放头的那个控件旁边
- [x] **第一版用 `42vh`，负责人回说「又调小了点」，量出来他是对的。** 地图上方的内容是**恒定
      308px**（在 641 与 900 两个高度上分别量过，都是 308），所以按视口比例取高度会在大窗口上
      白白浪费：900px 窗口下 `42vh` 只给 378px，**空着 146px**。
      改成 `clamp(16rem, calc(100vh - 23.5rem), 44rem)` —— 减掉那个常量与控件行，地图就**随窗口
      1:1 增长**而不是只拿 42%。实测：641px → 265px（控件底边 613，在折叠线内）；
      900px → **524px**（控件底边 872，在折叠线内）。上下都夹住：矮窗口有下限，4K 有上限
- [x] **设备列表首行恒定高亮，是真 BUG。** `ensureSelectedDevice` 每次 ingest 都会在没有有效选中项
      时选中第一辆车 —— 那是**地图**需要的（`SceneMap` 以 `selectedDevice` 为中心，否则什么都不画），
      但把它画进列表就错了：没人点过，第一行却是高亮的，读起来像「这行有什么特别」，实际只是
      「这是第一行」。列表去掉该高亮（行是链接，hover 才是可供性）；**地图侧栏保留**，那里它确实
      有含义 —— 地图当前显示的是哪辆，而且点击会变
- [x] 回归断言钉住它：列表视图下 store 确实选中了 `agv-01`，但**没有任何一行带 `bg-brand-wash`**

#### 13R 里被推迟的

- [ ] **删掉各页的 lede 说明文字**，负责人的决定是留到 Phase 14 验收前统一清理（现在它们对逐页
      检查还有用）。**注意一处例外**：`场景` 页 lede 里那句「只读 —— 场景是车辆定位的依据，
      不由监控台改写」是产品红线，且是 `console-admin.spec.ts` 唯一断言「只读」的地方 ——
      删 lede 时要把它移到正文，不能一刀切
- [ ] 告警区整体布局再看（负责人只说"可以再看看"，没有具体诉求，留待第二轮）
- [ ] **总览四张卡的改法回退重做**（13R-B 已关闭未合入）。下一版无论版面怎么改，
      **浅色警示色仍然要修** —— 那与"卡里放什么内容"是两个独立问题，只是上一版被我合在一个 PR 里
      提交，所以一起被回退了。两条测量结论留在 #115 的关闭评论与 13R-B 条目里，不必重测
- [ ] **设备列表允许自定义排序**（类似管理系统）。现在排序是 store 里硬编码的 deviceId 升序、
      用户不可改 —— `frontend-parity.md` 第 0 节记过 v1.0.0 同样如此。要先定三件事再动手：
      哪些列可排、是否支持多列、排序状态要不要进 URL（告警中心的筛选进了 URL，两处应当一致）
- [ ] **点击记录行在行下方展开设备信息卡**，而不是直接跳转设备详情。与上一条同属设备列表的一次
      改造，放同一个 PR 更合理

### 13S — 第 9 节核销留下的 5 条缺陷（收口的产出，不是新建设）· [~] 进行中（3 修 / 2 更正 / 2 押 1.0.3）

第 9 节核销把 7 条「仍在」分成了两堆：2 条属会话边界，留 Phase 15；**剩下 5 条在这里收口**。
放在一个 PR 里的理由是它们同源 —— 都是前两次"刻意不夹带行为改动"的搬迁留下的尾巴（12A 抽取、
13A-2a 地图底座），不是五件互不相干的小事。

**开工第一件事改了这批的边界。** 核销时把 9.1 认成"唯一会改变已发布产品行为的一条"，查消费方发现
**9.19 也是**：`frontend/src/views/AlertsView.vue:41` 与 `frontend/src/stores/fleet.ts:297` 都用
`toTimestampMs` 排序告警。两条同属一类 —— **动 `fleet-core` 就等于动已发布的 v1.0.0**，只能是
`fix:`，而 `fix:` 落 main 就注定发版。所以它们一起押到 **1.0.3**（与 P0-b…P0-e 同批），
13S 全部落在 `frontend-next` 内，用不产生发版的 commit type。

- [ ] **9.1 `formatNumber(null)` → `"0.00"`** → 押 **1.0.3**（`packages/fleet-core/src/formatters.ts:12-18`）。
      `Number(null) === 0` 是有限值，所以 `Number.isFinite` 这道门挡不住它。修成与同文件
      `formatValue` 一致的口径：`null` / `undefined` / `""` 一律 `--`，**而 `0` 必须仍然是 `0.00`**
      —— 那是一个真实读数。测试当时照着错误行为写（`formatters.test.ts:40-45` 自带 `DEFECT` 标注），
      修的时候要连测试一起改
- [ ] **9.19 `toTimestampMs` 对空值回退 `Date.now()`** → 押 **1.0.3**（`fleetNormalize.ts:69-82`）。
      与 9.1 同一类错误：**空值伪装成一个看起来像真的值**。这条更麻烦，因为它进排序 —— 返回 `NaN`
      会让比较函数失序，所以修法要连排序端一起定（无时间戳的排最后，而不是排到"现在"）。
      另注：`backend/src/normalize.ts:19` 还有**第四份独立实现**，同样的回退，要一起看，否则前后端
      对"没有时间戳"的判断会分叉
- [x] **9.4 栅格底图 `<image>` 无 `@error`**。补 `@error` + 「底图加载失败」常驻卡，与点云那条并排
      堆叠（两者可同时成立：点云失败会退回栅格图，而栅格图也可能失败）。失败态**按 href 记而不是
      按布尔量记**，所以切场景自己就清干净了 —— 一条压在好地图上的旧失败提示是它自己的缺陷
- [x] **9.7 `!sceneReady` 覆盖层吞事件** —— **原判断错了，改判为有意的区分，不修。**
      `GpsMap` 划的是同一条线：它 `inset-0` 那个"等待接入 / 加载失败"覆盖层也**没有**
      `pointer-events-none`（`GpsMap.vue:329`），只有压在活地图上的那个才有（`:366`）。
      `!sceneReady` 时整个 stage group 都不渲染，底下没有可交互的东西，吞事件不损失什么，反而换来
      两件事：说明文字可选中，且滚轮不被 svg 的 `@wheel.prevent` 吃掉（否则在一张死地图上滚动会把
      页面卡住）。理由写进了模板注释，免得再被当成漏改
- [x] **9.28 `buildWorldPath` 静默直连缺口**。改为按「落笔状态」发指令：非有限点抬笔，下一个有效点
      重新 `M` 开子路径 —— 缺口读起来就是缺口，而不是一条车没走过的直线。`M` 不再由数组下标决定，
      所以首点被丢时路径依然合法（旧实现会以 `L` 开头，那不是合法路径）。两条测试各钉一半
- [x] 顺带（9.3 / 9.5 / 9.30 三条「部分」的剩余部分）：
  - **9.5 修了** —— `loadOverlay` / `loadMetadata` 各自补单调 request-id，`onBeforeUnmount` 三条
    一起失效。守卫**同时挡住 toast**：一条关于已经离开的场景的失败提示，指的是操作员看不见的问题
  - **9.30 的 `hasPose` 收敛了** —— 删掉 `useSvgViewport.ts` 与 `SceneMap.vue` 的就地重定义，统一
    用 `fleet-core` 那一份。场景合并仍两份 → 留 13T
  - **9.3 剩下那一半判定为不修** —— `pointermove` 不按 rAF 合帧是对的：浏览器已把 `pointermove`
    按帧对齐（更细的采样只经 `getCoalescedEvents` 给出），一帧内没有第二个事件可合，rAF 只会
    **多加一帧拖拽延迟**。原注释的结论对、机制说明不准确（Vue 的调度器并不跨 tick 合并 —— 每个
    事件是各自的 task，各自 flush 一次渲染），已一并更正
- 自检 ⏳（2026-08-31，PR 待建）：`npm test` 全绿 —— fleet-core **97** · backend **287** ·
  frontend **132** · console **443 → 450**（新增 7 例：底图失败态 2 / 轨迹缺口 2 / overlay 与
  metadata 竞态 3）；**e2e 73/73**；lint / format:check / typecheck / build 全过；console 覆盖率
  96.29 / 86.36 / 91.47 / 96.29（门槛 94 / 85 / 90 / 94，未调，四项均微升）

### 13T — parity 核销查出的能力损失（全 8 节 340 行的产出）· [~] 进行中（13T-A 已实现）

**340 行核销完毕：271 通过、69 未通过。** 其中约 30 行是真能力损失（本批）、约 20 行是原表标 🟡 的
建议未采纳（见「不属于本批」）、其余归 Phase 15/16。

丢的东西有个共同点：**几乎全是旧实现里那些防御性的小东西** —— 一条 `pointer-events:none`、一次
z-index 抬升、一个重试按钮、一个徽标、一个计数、一条虚线。主干功能在搬迁时被认真对待了，边角没有。
**唯一的例外是第 2 节**：编队区整段与设备列表的两列 + 行级视觉是**功能缺席**，不是边角。

**最有力的检测手段是「声明了但无人消费」，而且三层都成立：**

| 层         | 死声明                                                                                   | 对应缺失的 UI                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| store 导出 | `sortedFormations` / `selectedFormation` / `selectFormation` / `clearFormationSelection` | **编队筛选器整段没建**                                                        |
| store 导出 | `retryBootstrap` / `connectRealtime`                                                     | **离线自救面板没建**（能自动重试，但操作员无法手动踢一脚）                    |
| store 导出 | `clearTrail`                                                                             | 「清除轨迹」按钮                                                              |
| composable | `cycleTheme` / `acknowledgedCount` / `clearAll` / `clearSavedSceneViews`                 | header 主题入口 /「显示已确认（N）」的 N /「清除已确认」/「清除场景视图记忆」 |
| 设计 token | `--color-ros-lanelet-bg` / `--color-map-scale`                                           | lanelet 底色分支 / 比例尺                                                     |

不是巧合：**搬逻辑层的时候搬全了，搬界面层的时候漏了调用它的那个控件。**
另有 4 个 store 导出（`getDeviceTone` / `hasPose` / `round` / `formatDateTime`）是纯冗余可直接删。

- [x] **13T-E 把这条规律做成断言** —— 「store / composable 的每个导出都必须有非测试消费者」。
      它比人工逐行读 340 行可靠得多，而且能防止同类缺口再次出现

#### 要做的（结论明确，不需要再讨论）

- [x] **13T-C 告警数徽标回到导航**（第 1 节）。`summary.alertTotal` 在 store 里活着，外壳零消费。
      现在操作员在设备页 / 报表页 / 管理页**看不见有多少条告警在等他** —— 取消掉的是「不用切页
      就知道该不该切页」这个能力，是本批影响最大的一条
- [x] **13T-E 离线重试按钮**（第 1 节）。接上 `retryBootstrap`；`useNotifications` 已支持 action，
      toast 上挂一个即可。现在后端恢复后用户只能刷新页面
- [x] **13T-B `<main>` 的焦点环**（第 1 节）。`AppShell.vue:130` 的 `focus-visible:outline-none` 与 9.9 的
      全局修复方向相反。**路由切换那条路径新旧大概一致**（程序化 `.focus()` 落在 `tabindex="-1"` 上
      通常不匹配 `:focus-visible`），真正差的是**键盘用户按 skip-link** —— 那恰好是 skip-link 唯一的
      使用场景。**先在真浏览器里确认这个推断，再动手**
- [x] **13T-B 骨架屏组件补回来，这是本批最大的一处**（第 7 节）。`frontend-next` 零 `*keleton*` 文件，
      而 `stores/fleet.ts:106` 还写着「Views render skeletons while it is set」——
      **一条断言了假事实的注释**。连带要补：`aria-busy` 的忙态语义（现在全 `src` 只剩 `LoginForm`
      的表单提交态）、`roadmap-archive.md:117` 实测的 27px 行盒（换成文案后布局会跳）、
      `prefers-reduced-motion` 下的静态色块。设计与原子清单在
      `docs/frontend-design-system.md:297,309` —— **计划在，实现不在**
- [x] **13T-C 告警行的「来源」列与三项视觉编码**（第 6 节）。`alertSourceLabelMap` 四条映射在新前端无
      对应物（`source` 在 `fleetNormalize.ts:237-287` 一直在算，只是没人显示）；严重度从整行边框
      降为一个徽标、选中设备高亮消失、**已确认行的 `opacity:.55` 没了 → 打开「显示已确认」后两种行
      除按钮外完全一样**，批量确认之后人分不清哪些是自己刚确认的
- [x] **13T-C「确认当前筛选」恢复为全集**（第 6 节）。现在缩成「确认本页」，而
      `docs/frontend-research.md:36` 对这条明确写的是「保持能力，补反馈与撤销」—— 反馈补了，能力窄了。
      缩窄**没有在代码或提交信息里给理由**
- [x] **13T-C「清除已确认」控件 + 两个计数**（第 6/7 节）。接上 `clearAll` 与 `acknowledgedCount`。
      管理页那颗按钮不是等价物：它会连主题、侧栏、地图模式、声音偏好一起清掉
- [x] **13T-E 本地数据清除恢复按类粒度**（第 7 节）。接上 `clearSavedSceneViews`。**当前的「全清」会顺带
      删掉旧设置页刻意不碰的 theme / map-mode / device-layout / 声音偏好**，这是行为上的实质变化
- [x] **13T-E「当前生效：深色/浅色」**（第 7 节）。`useTheme.ts` 的 `resolved` 已导出，只缺一个读者；
      选「跟随系统」时界面现在不告知此刻解析成了哪一套
- [x] **13T-C 搜索防抖**（第 6 节）。旧清单标的就是 🟡「加防抖」，现在每次按键还多一次 `router.replace`
- [x] **13T-D 两处 CSS 动画回来**（决策 1）：`realtime-pulse` 顶栏状态点（`AppTopBar.vue`）与
      GPS 选中 marker 的 `pulse` 呼吸环。现在选中态是静态强调（pin 12px→16px + `color-mix()` 外圈），
      **动态是加在它之上而不是替换它**；文字层一个字不动。ROS 图受影响最深 —— 它本来就没有逐车选中
      样式，脉冲环是选中态唯一的动态表达，所以这一条**顺带给 ROS 选中车补上脉冲环**（骨架屏那处动效
      在 13T-B）。**不需要各自写 `prefers-reduced-motion`**：`styles/base.css:67-78` 有一个
      `@layer base` 里的全局 `!important` 总闸，分层的 `!important` 压过未分层声明，scoped 与
      unscoped 块都覆盖到
- [x] **13T-D 高德 `ToolBar` 换自绘、`Scale` 留下**（决策 3 收窄，第 4 节）。见下「实现记录」——
      `Scale` 是这个面上唯一的距离读数，替掉它要自己做纬度投影，而 v1.0.0 也是靠高德提供这个能力的
- [x] **13T-D GPS 标签的防御性 CSS，实际是四条不是两条**（第 4 节）：`pointer-events:none` ·
      **`visibility:hidden`**（`opacity:0` 的卡片仍可命中指针，真正让它退出命中测试的是这一条）·
      `hover` 时 `z-index:200`（旧 CSS 有注释专门说这是为了「密集车群里悬停出的标签不被邻居 pin
      压住」）· **`max-width` 夹取**（`white-space:nowrap` 无上限，长设备名产生无界宽度卡片）

第 2/3/8 节核销追加的条目（同一批，同样按"结论明确"归类）：

- [x] **13T-A 设备列表补回「最近上报」与「电量」两列 + 行级视觉**（第 2.4 节）。**这是全批对值班效率影响
      最大的一条。** 全站「最近上报」只剩详情页一处、「电量」只剩详情页与回放/曲线；配合
      critical/warning 投影与 offline `opacity:.74` 的消失，**扫一屏判断「谁快没电了、谁的数据停了」
      从「看列表」变成「逐台点进详情」**。顺带把每行 DOM 节点数（当前 8 / 上限 16）那条护栏移植过来
      —— 旧清单专门叮嘱不要凭感觉重开虚拟化，判据就是它
- [x] **13T-A 场景名到处可读**（决策 7，第 2.1 节）。列表与详情现在只显示裸 `sceneId`（如
      `yard-north`），「未配置场景」这句降级文案全站搜不到。**统计卡不重建** —— 它回答的是全局而非
      当前选择，且四卡改版已在负责人的 UI 待办里，两件事会撞在一起
- [x] **13T-A 两张图的数据源恢复不对称**（决策 8，第 2.5 节）：GpsMap 收全量（筛选不该让车从地图上
      消失），SceneMap 收编队筛选后。**必须与下面那条同一个 PR** —— 没有编队 UI 时两者恰好等价，
      改了也看不出来
- [x] **13T-A 编队功能整段接上**（第 2.3 节）。这不是形态变化而是功能缺席：`selectFormation` /
      `clearFormationSelection` / `sortedFormations` 零调用者，`formation.color` 仍在
      `packages/shared` 契约里却无人渲染。**先修那处已许诺未接上的交互**：
      `OverviewView.vue:126` 的 note 写「点击查看成员」，而那卡是无任何 `@click` 的 `<article>`
- [x] **13T-A `describeEnum` 的 13 条枚举释义接回 `title`**（第 2.6 节）。函数在 fleet-core 里活得很好、
      有测试，新前端零引用；控制模式 / 挡位 / 车端任务 / 平台任务四个字段的释义都没了
- [x] **13T-A 三处字段级损失**（第 2.6 节）：`speedLimit.stamp`（数据在 `fleetNormalize.ts:161`，界面无处
      显示 → **无法判断当前限速是刚下发的还是一小时前的残留**）· 报码卡的 `stamp`（`DescribedCode`
      结构里就没留这个字段，「这条报码何时发生」在详情页答不出）· 位姿分节空态的替代文案
- [x] **13T-A「电量」格式化在仓库内不自洽**（第 2.6 节）：详情页 `(v,0," %")`、回放 tab `(v,1,"%")` ——
      同一台车两个 tab 显示不同精度。**统一为 `(v, 0, "%")`** —— SOC 遥测给到 0.1% 是虚假精度，
      且无空格与其余百分比写法一致。这一条我直接定了，它没有需要权衡的地方
- [x] **13T-D 一批被静默简化的视觉编码**（第 3.9 节，全部没有注释说明）：lanelet 边界的 `round` cap ·
      选中轨迹的 `2 5` 虚线 + drop-shadow（**当时是实线**）· 僚车轨迹的 `2 6` 虚线 · 僚车标签的
      粗体 + `paint-order: stroke` 描边光晕（浅色底图上少了对比补偿）。两处**语义**变化：
      僚车标记 `normal` 也被染成 brand，于是**「有颜色」不再等于「有状态」**（已改回中性，并给
      `offline` 补自己的规则）；激光标记 `--warning` → `--color-notice`（**保留**，见实现记录）
- [x] **13T-D 世界底色的 `lanelet-mode` 分支**（第 3.9 节）。纯 lanelet 场景不再换底色，
      `--color-ros-lanelet-bg` 成了零消费者的 token —— 已归位

**13T-D 实现记录（2026-08-31）**

**那个死 token 的归属我猜错了地方。** 决策 3 写的是「比例尺接上 `--color-map-scale`」，默认它属于
GPS 图。线索其实一直指向**场景图**：`docs/tools/check-map-contrast.mjs:39` 早就在按 3:1 检查
`map-scale` 对 **`--color-ros-canvas`** 的对比度 —— 那是 ROS 画布底色，不是高德地图。这个归属差别
直接决定工作量：GPS 图的比例尺要按当前纬度投影出每像素多少米（真活儿），而**场景图的世界坐标本来
就是米**，`viewport.scale` 直接就是 px/m。

顺带修掉它替代的东西：场景图原来只有一个裸倍率 `3.2x`，而**那个数字相对的是「适应场景」时的缩放，
取决于面板尺寸与场景范围** —— 换个窗口大小，同一个 `3.2x` 就是不同的距离，它回答不了任何人会问的
问题。比例尺取 1/2/5×10ⁿ 米里能塞进 120px 的最大值。

**决策 3 被我收窄了：`ToolBar` 换自绘，`Scale` 留下。** 前者的缩放组件是高德皮肤，深色主题下一块
亮矩形，自绘两个按钮即可等价替代（顺带从 `AMAP_PLUGIN_LIST` 摘掉 —— 留着照样下载，一个没人构造的
插件是每次首屏的净字节）。后者是这个面上**唯一的距离读数**，替掉要自己做纬度投影，而 v1.0.0 也是
靠高德提供这个能力的。**为了满足一条主题一致性的抱怨，把一个能用的控件换成一个缺失的控件，不是
等价交换。**

**脉冲环放哪里是这批唯一的硬约束。** `.ros-marker-core` 的屏幕盒被两个 e2e spec 量。安全做法是
**同级 `<circle>`** —— SVG 兄弟节点互不影响 bounding box。而 v1.0.0 的 `pulse` keyframe **含
`transform: scale(1.12)`**，原样搬到任何祖先 `<g>` 上都会连带缩放 core 的盒子，这正是这里唯一可犯
的错。同理 GPS 的 pin：新 marker 是 `display: grid; place-items: center`，放大 pin 会动它自己的盒子，
把下方 20px 的标签每周期上下拽一次 —— 所以两处动画都做在 `box-shadow` 扩散上，零布局成本。

**「有颜色 = 有状态」是在两处同时被破坏的**：僚车标记 `normal` 与僚车轨迹 `normal` 都被染成 brand，
叠加效果是**一辆健康僚车和它的轨迹都与选中车同色**，于是「哪一辆是我选的」只剩尺寸和箭头承担。
两处都改回中性，并给 `offline` 补了自己的规则 —— 旧默认色是 `--color-offline`，那把「健康」和
「没上报」混成一件事。

**激光标记 amber → blue 不回退。** 它是**一致改动的**（环、箭头、核心、图例四处一起动），而且更
正确：一个正常传感模式常驻警告琥珀色是虚假告警。记录为有意变更而不是漏改。

**最值得记的一条：仓库里没有任何测试断言过地图元素的颜色。** 几何契约有四处守卫（两个 e2e spec、
`device-views.test.ts` 的 marker 盒断言、path 字符串断言），所以端口的几何完好无损 —— 而两处**语义**
重着色就是这么静默进去的。**没有测试的规则是会被意外改掉的规则。** 已补断言，其中「僚车 `normal`
不得有 brand 规则」是直接读 SFC 源文本断言**规则不存在**（jsdom 不套用 scoped CSS，computed style
两边都报不出来）。

另有一处对自己先前说法的更正：**「新前端零 `@keyframes`」在 13T-B 之后就不成立了** —— `UiSkeleton`
的 `skeleton-sweep` 是我自己加的。而 `styles/base.css:67-78` 的全局 reduced-motion 总闸意味着新增
keyframe **不需要各自写退化分支**，`UiSkeleton` 自己那条仍然保留，因为它还要把渐变换成纯色块，
不只是停掉动画。

**13T-D 与 13T-E 合成一个 PR（#123），这是流程失误。** 13T-D 的勘查连续两次被中断（第二次是电脑
休眠时的 API 错误），所以先做了不依赖勘查的 13T-E，勘查回来后又在**同一分支上**做了 13T-D。
`AppTopBar.vue` / `stores/fleet.ts` / `device-views.test.ts` 被两批都改过，逐 hunk 拆分的风险大于收益。
开始 13T-D 时就该另起分支。

- 自检 ✅（2026-08-31，PR #123）：`npm test` 全绿 —— fleet-core **99** · backend **287** ·
  frontend **132** · console **473 → 509**（新增 36 例：死导出断言 3 / 重试与清除轨迹 5 /
  视觉编码 5 / 其余为两批的控件与豁免面变更）；**e2e 75/75**；lint / format:check / typecheck /
  build 全过。

  > **e2e 这次差点没跑成，口径记在这里**：本地 Playwright 的 `chrome-headless-shell`
  > 反复下载失败（缓存目录只拿到完整 chromium），而 **`npm run e2e` 在安装步骤失败时仍然退出 0** ——
  > 74 个用例全部报 "Executable doesn't exist" 而退出码是 0。**所以 e2e 的判据必须是「N passed」
  > 那一行，不是退出码。** 最后用 `E2E_BROWSER_CHANNEL=chromium` 绕过 headless shell 跑通。

- [~] **13T-E（一半）/ 1.0.3（一半）`dataDefaults` 的两个永久空常量**（第 8.7 节）。`sceneCatalog = {}` 与
  `fallbackFleetPayload.devices = []` 被原样照抄，三处查表恒不命中，离线兜底灌进去的是零台设备
  —— 也就是说**「后端不可达时有可视内容」这个承诺从 v1.0.0 起就没有实现过**。
  **结论：删掉这条路径**（决策 2），离线走明确空态 + 重试按钮（与上面那条离线重试同一个 PR）。
  监控系统里显示假数据比显示空白危险得多 —— 操作员分不清看到的是示范数据还是真车
- [x] **13T-E 删掉 store 里 4 个纯冗余再导出**（第 8.6 节）：`getDeviceTone` / `hasPose` / `round` /
      `formatDateTime` —— 所有消费者都直接从 `@navfleet/fleet-core` 导入。顺带给 `ingestPayload`
      的注释标明它是 test seam，否则下一个人会以为它是公共 API。**同批删掉 `cycleTheme`**（决策 5）
- [x] **13T-E 修掉两处注释与实现的分叉**（核销中发现，改注释还是改代码要分别判断）：
      `stores/fleet.ts:100-108` 仍在论证「必须区分『还没有数据』和『没有数据匹配筛选』」并声称
      「views render skeletons while it is set」，而骨架不存在、那条筛选空态文案也没保留 ——
      **这里注释比代码更接近正确，是实现要向注释靠**；`DeviceDetailView.vue:214` 的 panel
      `key: "codes"` 配 `title: "位姿"` 是无害但会误导的命名残留
- [x] **13T-E 补回 e2e「刷新后车辆仍 `<24px`」的断言**（第 3.5 节）。存储能力在，但钉住它的钉子松了 ——
      reload 用例现在只断言底图与版式偏好存活。「适应场景」的断言也从绝对 `>24px` 改成了相对比较

#### 八项待定已定（2026-08-31 与负责人对齐）

核销时刻意没替这八项推断理由 —— 代码里都没写。现在有结论了，一并记下：

| #   | 待定的事                                | 结论                                                                                                                                                                                              |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CSS 动画整体缺席，是决定还是三次遗漏    | **三个都回来**（`realtime-pulse` / GPS `pulse` / `skeleton-sweep`），文字层保留不动，全部带 `prefers-reduced-motion` 退化 → 13T-B / 13T-D                                                         |
| 2   | `dataDefaults` 两个永久空常量：填还是删 | **删掉这条路径** —— 离线走明确空态 + 重试按钮。监控系统里显示假数据比显示空白危险得多。**13T-E 只做得了 frontend-next 那半**：常量本身在 `fleet-core`，v1.0.0 也 import 它 → 常量删除入 **1.0.3** |
| 3   | 高德内置 `Scale` / `ToolBar` 是否自绘   | **隐藏内置，只留自绘**。比例尺接上已备好的 `--color-map-scale`（它正是一个零消费者的死 token） → 13T-D                                                                                            |
| 4   | 13T 约 30 条怎么切 PR                   | **按主题拆 5 个**（见下）                                                                                                                                                                         |
| 5   | 主题入口只剩会话菜单一个                | **接受**（菜单里的显式三选项比原先那个"不知道下一下切到哪"的循环按钮更好），并**删掉 `cycleTheme`** —— 不留着当线索 → 13T-E                                                                       |
| 6   | `registerWindowApi()` 是否刻意舍弃      | **确认舍弃**。可测试性由 450 例单测 + 73 例 e2e + store 可直接导入承担，不再需要从控制台戳全局对象。此条即为记录                                                                                  |
| 7   | 统计卡的「当前场景」要不要回来          | **不要统计卡**（它回答的是全局而非当前选择，且四卡改版已在负责人的 UI 待办里），**但要修好列表与详情到处的裸 `sceneId`**，并拿回「未配置场景」降级文案 → 13T-A                                    |
| 8   | GpsMap / SceneMap 的「有意的不对称」    | **恢复不对称**：GpsMap 收全量（筛选不该让车从地图上消失），SceneMap 收编队筛选后。两张图回答的是不同问题 → 随 13T-A 的编队功能一起接                                                              |

#### 拆成 5 个 PR

| PR        | 内容                                                                                                                                                          | 为什么是一批                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **13T-A** | 设备列表两列 + 行级视觉 · 编队功能整段 · 两图数据源恢复不对称 · 场景名到处可读                                                                                | 都围绕「扫一屏就能判断」这一件事，且编队 UI 一接上，两图的不对称与 `formation.color` 才同时有意义 |
| **13T-B** | 骨架屏组件 + `aria-busy` 忙态 + 行盒实测（27px → **36px**，见下）+ `skeleton-sweep` + reduced-motion + `<main>` 焦点环                                        | 本批最大的一处缺失，自带设计与原子清单（`docs/frontend-design-system.md:297,309`），独立可验收    |
| **13T-C** | 告警中心：来源列 · 三项视觉编码 · 全集确认 · 清除已确认 + 两个计数 · 搜索防抖                                                                                 | 全在 `AlertsView`，一次改完一页                                                                   |
| **13T-D** | 地图与视觉编码：两处 CSS 动画 + ROS 脉冲环 · 虚线与描边光晕 · lanelet 底色分支 · GPS 标签两条防御性 CSS · 高德控件自绘                                        | 全是视觉编码，且需要一起看才知道「有颜色 = 有状态」这条语义是否还成立                             |
| **13T-E** | 清理与断言：删 4 个冗余再导出 + `cycleTheme` · 修两处注释分叉 · 离线路径不再伪造空车队 · 补 e2e `<24px` 断言 · **把「每个导出都必须有非测试消费者」做成断言** | 清理项互不相干但都零风险。**「断言放最后」这条判断反了** —— 见下                                  |

**13T-A 与 13T-B 先合先看** —— 它们是我判断影响最大的两条，负责人可以在余下三个 PR 之前先验收。

**13T-E 实现记录（2026-08-31）·「断言放最后」这条判断反了**

原本写的是「断言放最后，因为前四个 PR 会消耗掉大部分死导出」。实际**先写断言更有用** —— 它一跑就
直接告出还剩哪些没被消耗掉，比逐条回读清单可靠。断言变成了这一批的待办清单，而不是它的收尾。

**它长出三层匹配，每一层都是被自己的假阴性推出来的：**

1. **store 成员按裸标识符搜，全部显示为活的。** 那 4 个纯冗余再导出（`getDeviceTone` / `hasPose` /
   `round` / `formatDateTime`）在 `src` 里到处都是 —— 因为每个组件都直接从 `@navfleet/fleet-core`
   导入同名函数，**而没有一个走 store**。改成按属性访问匹配，3 个立刻现形。
2. **`round` 仍然逃掉了**，因为 `\.round\b` 匹配上了 `Math.round`。所以接收者也得钉住（全仓库
   `useFleetStore()` 只绑给 `fleet` 一个名字）。教训很具体：**属性匹配器还得知道那是谁的属性。**
3. **最重要的漏洞：composable 交出去的东西不是它 `export` 的东西。** `cycleTheme` /
   `acknowledgedCount` / `clearAll` **从来不是 ES 导出** —— 它们是返回对象上的键，一个只读 `export`
   语句的检查会径直走过核销时最有说服力的那三条证据。补这层时第一次运行报了 18 个假阳性（成员几乎
   总是多行解构取出的，而正则要求同一行），折叠空白后 18 降到 3，且 3 个全真。

清掉 9 个：store 的 4 个冗余再导出 · `cycleTheme`（11C 用会话菜单的三个显式选项替代了它 ——
**循环按钮说不出下一次点会切到哪**）· `canSound` 撤为内部（它的三条测试断言旁边都紧跟着一条
`silentReason` 断言，后者说的是同一件事而且带理由）· `THEME_PREFERENCES` / `CHART_SERIES_SLOTS`
（纯别名重导出，零消费者）· `dismissNotification` 与 `runNotificationAction` 撤为内部（只有 `notify`
真的被裸调用）。

**豁免表的设计是这批的关键**：每一条都必须带理由，`__` 前缀按约定自动豁免（前缀本身就是声明）。
往表里加一条是一次可见、需要复核的动作 —— 这就是断言的价值，不在于它此刻是绿的。

三处实现判断：

- **本地数据清除做成逐键，而不是重建 v1.0.0 的类别。** `localState.ts` 的文件头明确论证过「清单必须
  靠扫描发现，写死的清单会过期」，重建一套类别分类恰恰是它反对的东西。逐键比类别更细，且不需要任何
  手工分类表
- **离线路径不再 `ingestPayload` 一个空载荷。** 那等于**把「拿不到数据」打扮成「一支零辆车的车队」**。
  现在只保留那两个确实有值的字段，不动设备表 —— 重连时并入「最后已知状态」而不是并入一个刚被静默
  清空的车队
- **`<24px` 那颗钉子是 13R 之后松掉的**：reload 用例只断言了底图与版式偏好存活，所以**一次「恢复了
  视口却丢了主体」的重载会通过**。补的是同一个绝对判据，不是相对比较

顺带一次近失事故记在这里：网络中断发生在 `git checkout main` 与 `git pull` 之间，而**未提交的改动
被 checkout 带到了 main 上**。没有丢东西（切回分支落成 commit 即恢复），但这说明**两步操作之间工作区
是裸的** —— 以后先 commit 再切分支。

**13T-B 实现记录（2026-08-31）**

`UiSkeleton`（line / value / card 三态）+ 两个页面接上 + `<main>` 焦点环。三处判断值得记：

1. **那个「27px 行盒」的数字不能照抄。** 旧值是 v1.0.0 自己的 `20px × 1.35` 量出来的；新前端统计卡
   的值是 `text-3xl font-semibold` = `30px × 1.2` = **36px**（`ramp.css:109-110`）。照抄 27px 会
   少留 9px，**把这个 variant 存在的理由本身抵消掉** —— 占位符高度不对不会消除布局跳动，只会把跳动
   挪到数据落地那一刻。注释里写明了这一条要跟着 `--text-3xl` 走
2. **`<main>` 的 `focus-visible:outline-none` 不需要真浏览器验证也能判定。** 它在跟一个**本来就正确**
   的机制对抗：`:focus-visible` 的全部意义就是「键盘来的给环、鼠标来的不给」。把它压成 `none`
   等于把这个伪类解决掉的问题又造回来，而它破坏的恰好是 skip-link —— 一个只有键盘用户会用的东西。
   改成 `-outline-offset-2` 而不是直接删：`<main>` 是 `flex-1 overflow-y-auto` 的子元素，画在盒外的
   outline 会被滚动容器裁掉。**e2e 里加了一条读 `outlineWidth` 的断言**，比人工看一眼可靠
3. **顺带修掉一处「对没有的数据下结论」。** 统计卡的 note 全部从计数派生，而快照到达前那些计数都是
   0，于是加载中的 总览 会说 `全部在线 · 无告警级 · 全部已定位` —— 四条关于它还没拿到的数据的断言。
   note 因此也换成占位符。这与 `formatNumber(null)` 渲染 `0.00` 是**同一类错误，只是高一层**

另外把设备页的冷启动从「居中空态卡」换成骨架行：空态卡的版式在说「车队是空的」，而它的文案在说
请求还在路上 —— 两句话互相矛盾。顺带给编队筛选后的空结果单独一句话（「该编队下没有设备」），
它此前与「后端还没有上报任何设备」共用同一段文案。

`stores/fleet.ts:106` 那条断言了假事实的注释同步改掉：现在它说得出是哪两个页面、以及 `aria-busy`
在哪一层。

- 自检 ⏳（2026-08-31，PR 待建）：`npm test` 全绿 —— fleet-core **99** · backend **287** ·
  frontend **132** · console **467 → 473**（新增 6 例：`UiSkeleton` 3 / 行盒与忙态与"假断言"3）；
  **e2e 73/73**（含新加的 `outlineWidth` 断言）；lint / format:check / typecheck / build 全过；
  console 覆盖率 96.42 / 86.77 / 91.93 / 96.42（门槛 94 / 85 / 90 / 94，未调），
  `UiSkeleton.vue` 四项 100%

**13T-C 实现记录（2026-08-31）**

**一处偏离清单的写法，理由记在这里。** 那条待办写的是「接上 `clearAll` 与 `acknowledgedCount`」，
实际把这两个导出**删了**，因为它们的语义都不对 —— 两者都作用于**整个已存储集合**，而那个集合保留
着早已消失的告警的 id：`acknowledgedCount` 会永久向上漂移（一个只显示 3 行的页面可以报「已确认
12」），`clearAll` 会顺手清掉不属于这个按钮职责的 id，撤销也就无法精确还原。页面改成对**当前车队
里**的已确认告警计数与清除，这也正是 v1.0.0 自己那个本地 computed 做的事。
**留着一个死导出只因为清单点了它的名，正是「声明了但无人消费」这个模式最初进到仓库里的方式。**
顺带把 `unacknowledgeMany` 改成返回实际变更的 id，与 `acknowledgeMany` 对称 —— 新的撤销需要它。

导航徽标有两点刻意不照搬 v1.0.0：它当年**永远是 critical 红**（`navigation.css:52-63`，不管实际
最高级别是什么，三条「提示」也看着像车队着火），而且是个**没有任何可读文本的裸数字**（读屏念
「告警 3」，3 可以是任何东西）。现在颜色跟随最高级别，链接自带一句完整说明；折叠态（44px 轨道）
徽标钉在图标角上，因为那里没有标签可以跟随。徽标颜色**不做过渡** —— 与 `ACTIVE_CLASS` 同一个理由，
在两种填充之间插值会经过一对没人验过对比度的中间色，那正是 2026-08-29 那次间歇性 axe 失败。

行级三项视觉编码里第三项（已确认行 `opacity .55`）的价值容易被低估：展开「显示已确认」后，两种行
此前**只差一个按钮的颜色**，所以刚做完批量确认根本看不出哪些是自己刚点的。

搜索防抖不只是加个延时。URL 既是输入框的**来源**又是它要写的**目标**，所以草稿必须是本地的，同时
靠 `lastCommitted` 区分「自己的回声」与「外部改动（后退键 / 重置）」—— 否则要么卡住光标，要么打字
打到一半被自己的导航清掉。抽成 `useDebouncedText` 并单独测（8 例），因为这三种交叉情形用页面级
测试很难说清。

**e2e 抓到一处单测抓不到的契约破坏，值得单独记。** 单测 497 全绿，e2e 三条红：抽屉焦点陷阱、
导航后关抽屉、404 页外壳完整 —— 同一个根因，**徽标改变了「告警」导航链接的可访问名**，三处都用
`{ name: "告警", exact: true }` / `/^告警$/` 精确匹配。而 `e2e/support/ia.ts:28-33` 的注释**早就写明**
这些匹配器用正则的理由是「v1.0.0 的 告警中心 在可访问名里带徽标计数」——
**console 那条被写成锚定的 `/^告警$/`，恰恰是因为 console 丢了徽标；那个锚点是缺失功能留下的化石。**
徽标回来，锚点就该去掉。这也说明这类断言应当匹配"这一项是什么"而不是"它此刻恰好叫什么"。

顺带自查出一处「文案承诺了实现没做的事」：搜索框 placeholder 改成 `标题、详情、设备、来源` 之后
没把 `source` 加进检索字段。已修，且两种形态都搜 —— 操作员在行上看到 `规则引擎`，看日志的部署方
知道的是 `rule-engine`。

- 自检 ✅（2026-08-31）：`npm test` 全绿 —— fleet-core **99** · backend **287** · frontend **132** ·
  console **473 → 497**（新增 24 例：`useDebouncedText` 8 / 行级视觉与来源 6 / 批量与两个计数 5 /
  导航徽标 4 / ack store 面变更 1）；**e2e 73 → 75**（新增：搜索防抖在真浏览器里保住光标与字符、
  导航徽标在非告警页可见）；lint / format:check / typecheck / build 全过；console 覆盖率
  96.52 / 86.92 / 91.77 / 96.52（门槛 94 / 85 / 90 / 94，未调）

**13T-A 实现记录（2026-08-31）**

两处核销时的判断在动手前被查出是错的，都写在这里而不是悄悄改掉：

1. **决策 8 的前提错了，结论仍然对。** parity 第 2.5 节写「现在两者都吃 `filteredDevices`」，
   实际只有 GPS 图变了：v1.0.0 `GpsMap` 收 `sortedDevices`、`RosSceneMap` 收 `sceneDevices`；
   新前端 `GpsMap` 收 `filteredDevices`、`SceneMap` 仍收 `sceneDevices`。**场景图从来没变。**
   修法因此只是一个 prop 表达式，不是重构。核销时接受了那句话没回去查 prop 表。
2. **报码 stamp 比「加个字段」深一层。** `describeCode` 接的 `CodeState` 有 `stamp`，但它只读
   `code` 与 `info` —— 时间戳在这个边界上被丢掉，`DescribedCode` 接口里根本没有这个字段。所以
   要动 `packages/fleet-core`。值得记的是它**从来不是没人用**：`buildCodeAlerts` 一直拿同一个
   `stamp` 当告警的 `ts`（`fleetNormalize.ts:265`）—— 数据在、有人用，只是从「已解释的报码」
   这条路看不见。

三个实现判断：

- **行级视觉没照搬 v1.0.0 的 `box-shadow`。** 旧版是 `0 18px 44px rgba(critical,.14)`，那是卡片
  家具；44px 模糊放在表格行上只会糊到邻行。译成表格是 `inset 3px 0 0` 左边缘 + 行底色。
  `notice` 与旧版一样什么都不给 —— 如果每个非正常状态都高亮，就没有一个是高亮的
- **hover 从 Tailwind 工具类搬进 scoped CSS。** 色调底色与 hover 底色是同一个属性，留在两套系统
  里意味着「谁赢」取决于样式表顺序，那不是模板该赌的事
- **编队筛选器是单向的**：`<select>` 只写 URL，watcher 只写 store。状态不能住在 URL 里
  （`filteredDevices` / `sceneDevices` 从 `selectedFormationId` 派生），但深链必须能复现视图，
  拆成两个方向是避免双向同步的唯一办法。watcher 还依赖编队数量 —— `selectFormation` 会静默忽略
  它还不认识的 id，而编队随第一份快照才到，否则**深链恰好在它存在的意义那个场景里被丢掉**

顺带修掉一处误导命名：位姿面板的 `key` 是 `"codes"`（`:key` 真的在用它）。

- 自检 ⏳（2026-08-31，PR 待建）：`npm test` 全绿 —— fleet-core **97 → 99** · backend **287** ·
  frontend **132** · console **450 → 467**（新增 17 例：列表两列与行级视觉 4 / 编队筛选器 7 /
  枚举释义与限速时间与场景名 4 / 总览编队链接 2）；**e2e 73/73**；lint / format:check /
  typecheck / build 全过；console 覆盖率 96.40 / 86.86 / 91.93 / 96.40（门槛 94 / 85 / 90 / 94，未调）

#### 不属于本批

- 「记住我 / 找回密码 / 验证码」三缺（第 7 节）**v1.0.0 同样没有**，不是搬迁遗漏 → Phase 15
- 约 20 行原表标 🟡 的**建议未采纳**：双指缩放与惯性 / 缩放按钮与键盘 / 平移软边界 / 比例尺
  （`--color-map-scale` 已备好） / 点云与 overlay 的加载态 / HUD 显示倍数 / 设备列表排序与搜索。
  这些不是搬迁损失（v1.0.0 也没有），是 Phase 13 没做的增强 —— **要不要做由负责人按优先级定**，
  其中「设备列表排序 + 点行展开信息卡」已在 13R 推迟项里
- `meta.roles`（8.1）与全局 401 拦截（8.2 / 9.24）→ Phase 15；ack 落库与告警端点接入 → Phase 16

## Phase 14 — 切换与替换（发版 1.1.0）

- [ ] **等价性验收**：parity 清单 + 17 例 E2E + axe 零违规 + **负责人人工验收**（第 5 条决策明确
      要"检查前端是否符合预期且调整后"才进下一步，这里预留调整迭代的余量，不设时限）

### 14A — 人工验收第一轮（负责人 6 条）

> 全部落在 `frontend-next`，没有一条动到已发布的 v1.0.0，所以这一批用 `chore(console)`，不触发发版。
> **5 条落地，第 2 条（浅色配色）负责人决定留到后续统一的主题优化**，第一版方向理解错了，已回滚。
> 落地的 5 条里有 4 条是**同一类问题**：一个正确的机制被放在它的前提不成立的地方。

- [x] **1 · 告警页随机边框高亮** —— 是 13T-C 从 v1.0.0 `alert-drawer.css:138-141` 搬回的
      `.alert-item.focused`。搬迁本身没错，放的位置错了：v1.0.0 那条规则活在**地图旁边的告警抽屉**里，
      选中是操作员刚做的、看得见的动作；而这一页从侧栏进来、页面上没有任何选择控件，于是圆环标的是
      `ensureSelectedDevice()` 自己挑的车 —— 冷启动是 id 最小的那台，否则是几分钟前在设备页点过的那台。
      浏览器实测复现：4 条提示级里恰好 1 条带 `data-focused`，而它是 `agv-a01`。**线索在页面外的提示
      就是噪声**，无论它多忠于原版。已删规则 + 删断言改为反向断言（一条从 v1.0.0 样式表搬过一次的
      规则会被搬第二次，而它错在哪从 CSS 本身看不出来）
- [ ] **2 · 浅色过亮，要「浅绿在外、白色在内」** —— **负责人决定：暂不单独改，留到后续一次统一的主题
      优化**。第一版做错了方向（把页面底色改成 `teal-100`、sunken 改 `teal-200`，卡片仍纯白，并把 18 处
      画在页面底色上的 `ink-subtle` 提升为 `ink-muted`），机检全绿（axe 8 路由 × 4 视口 × 双主题 7/7）
      但理解错了「外 / 内」指哪一层，整批已回滚 —— 生成器、`semantic.css`、预览页、那 18 处都回到原样。
      留给下一轮的事实（量过的，不用重新测）：- 深色下卡片(slate-800)与页面(slate-900)相差 **1.40:1**；浅色下 white 与 slate-25 只有 **1.04:1**。
      同一条卡片边界在两套主题里差一个数量级，这是「浅色看起来像白纸上画了几条浅灰线」的成因。- 浅色页面底色**最多只能压到 teal-25（4.56:1）**，再深一档 teal-50 就是 4.46:1：因为
      `ink-subtle`(slate-600) 现在落在 slate-25 上只剩 4.62:1，余量只有 0.12。想把底色压深，必然
      要同时决定「第三级文字还能不能画在页面底色上」，两件事绑在一起。- 改的入口是 `docs/tools/gen-design-system-preview.py` 的 `SEMANTIC`，不是 `semantic.css`（生成物）。
      机检是 `console-accessibility.spec.ts`（axe 的 color-contrast），不需要新写检查
- [x] **3 · Web 图标与顶栏图标换成 `public/image.png`** —— 顶栏原来是 `NF` 字母块。favicon 与顶栏引用
      同一个文件，两者不可能各自漂移；删掉不再被引用的 `favicon.svg`
- [x] **4 · 刷新后当前 tab 边框高亮 + 声音回到「未启用」** —— 两件事，都不是它们看起来的样子：- 边框：`AppShell` 用 `watch(route.fullPath)` 移焦点，而 `useRoute()` 从 `START_LOCATION`（`path: "/"`）
      起步、鉴权守卫是异步的 —— 刷新任何非总览页时，路径变化发生在组件挂载**之后**，与一次导航无从区分。
      焦点落到 `main`，而刷新本身是键盘操作，`:focus-visible` 就画了整页外框。**总览页幸免恰恰因为它的
      路径就是 `/`** —— 一个只放过一个页面的 bug 必有机制。改用 `router.afterEach`：`from === START_LOCATION`
      精确认出首次解析，比较 path 分开「换页」与「改筛选」（后者原来会把焦点从搜索框里抢走）- 声音：**「选择」能持久化，「手势」不能**。浏览器要求页面加载后先有一次手势才允许出声，这一点
      无法绕过；能修的是把两件事分开 —— 新增 `navfleet:alert-sound-armed` 记住「这个浏览器启用过」，
      armed 状态下页面上任意一次点击/按键自动 resume（**不出声**：一次无事发生的提示音教给人的正好
      相反），读数在此期间显示「声音待就绪」而不是「未启用」。**不默认 arm**：给从没要求过声音的人
      自动开声，正是让人拔音箱的那种失败
- [x] **5 · 系统状态页内外双滚动** —— 这一页 1650px 撞 852px 的内容区，于是整页滚动，而总览/设备/报表/管理
      都是填满视口、面板内滚。`PageHeader` 新增 `scrollContent`，标题与操作留在原位、内容自己滚。
      **修的过程中先自己踩了一次**：加完滚动容器后 `html` 反而能滚 292px —— 滚动容器只裁剪「以它为包含块」
      的绝对定位后代，而表格的 `<caption class="sr-only">` 落在 y=1191 逃出裁剪，把文档撑到 1192px。
      补 `relative` 后归零。1px 的隐形盒子能还原一整条页面级滚动条，这条值得记住
- [x] **6 · 回放地图高度改固定值** —— 13R-D 的 `clamp(16rem, calc(100vh - 23.5rem), 44rem)` 随窗口 1:1 生长，
      在实测过的两个窗高上都对；但它的输出**整个取决于操作员的窗口**：760px 笔电得到 384px，1100px 屏得到
      724px。也就是说地图恰好在被报告的那台机器上最小，而页面上没有任何东西说明为什么。改成 `h-[34rem]`
      —— 纸面上更差、实践中更好：每台机器一样、看得懂、谁在看谁就能调
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
| P0 缺陷在新功能之下被遗忘                  | 生产事故                     | P0-a 立刻单独发 1.0.1；P0-b～e 与 Phase 12–13 并行发 1.0.3；本表每阶段收口时回查               |

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
- 2026-08-29：**追了三个 PR 的 E2E 抖动，最后是一个真缺陷**（#73 诊断能力 → #79 定位 → #80 修复）。
  值得完整记一次，因为过程中我两次猜错，而两次都是被自己的实测推翻的：

  1. **#72 首次遇到**：同一个 commit 一次红一次绿。我拿不到证据 —— job 日志需要 admin 权限（403）、
     artifact 下载 401，红的那次只留下"某个用例失败"。本地 `--repeat-each` 又被一个卡住的 Playwright
     chromium 下载堵着（缓存 4 KB 且不再增长），改用系统 Chrome 跑了 65 例，复现不出来。
     我当时的假设是 `poseOffsetFromPanelCentre` 那条不会自动重试的断言（`expect(await x)` 不重试），
     **但我自己的探针否掉了它** —— 1.4 秒内采样 24 次，offset 恒为 0。既然定位不了，就先修
     **可观测性**：Playwright 加 `github` reporter，让红色 CI 直接在 check 上标出是哪条用例、哪个
     元素、什么数值。
  2. **#79 拿到证据**：新 reporter 报出 `color-contrast 1.38`，`#93a7bd on #4fd6c4`，位置
     `.router-link-active > span:nth-child(1)`。这两个颜色是 `--muted` 落在 `--brand` 上 —— 而 CSS
     里 active 态声明的是 `--brand-contrast`。**这个组合在任何稳定状态下都不存在**，只在过渡中间
     可达。本地 8 次重复 + 8 倍 CPU 降速全绿，复现不出来，我如实说了。
  3. **探针给出准确机制，并纠正了我的第二个猜测**：我猜是**将要点亮**的那一项，实测是**正在熄灭**
     的那一项 —— 导航后立刻取计算值，*离开*的链接仍是 `fg=rgb(4,35,31)` / `bg=rgb(79,214,196)`，
     过渡结束后才变成 `fg=rgb(147,167,189)` / `bg=transparent`。background 与 color 的过渡曲线不同步，
     中间那 160ms 里前景已经走完、背景还没走完。
  4. **修法两条**：`.nav-link.router-link-active` 上 `transition: none`（active 态本就不该淡入，
     它是"你在这里"的即时反馈）；`accessibility.spec.ts` 每次审计前 `settleTransitions(page)`。后者
     必须把 `document.getAnimations()` **过滤到 `CSSTransition`** —— 页面上有一个无限循环的 pulse
     动画，不过滤就永远等不到。
  5. **一条给 P0-f 的硬依据**：`retries: 1` 对这类抖动**完全无效**。重试是把"导航→审计"整段重跑一遍，
     于是再一次落进同一个窗口。它唯一的作用是把一个真缺陷标成 flaky 然后放行。

- 2026-08-29：**CI 每次改动只跑一遍**（`concurrency` group 按 PR 号 / ref，PR 上
  `cancel-in-progress`）。此前一个 PR 的 push 与 pull_request 两个事件各触发一整轮，E2E 跑两遍、
  检查项 11 个；现在 6 个，且 PR 的旧轮次会被新 push 顶掉。

- 2026-08-30：**12C-1 应用外壳落地，而这一步最有价值的产出不是外壳本身，是 axe 抓到的两个缺陷。**
  外壳做完后按 11C §3.3 的要求把审计视口从 1440 一个扩到 1024 / 1440 / 1920 / 2560 四个，
  界面从 5 个扩到 11 个（含抽屉打开、菜单打开两个瞬时态），共 40 次审计。第一轮 13 个
  serious 违规，归成两类，**两类都不是外壳的问题**：
  1. **设计系统的审计表自己漏检。** 深色下 `ink-subtle` 落在 `surface-raised` 上只有 4.06:1，
     而 11D 的配对表只审了四组文本配对，没有这一组。漏检机理值得单独记住：**深色的
     `surface-raised`(slate-800) 比 `surface`(slate-900) 更亮**，所以"在 surface 上够用"
     推不出"在 raised 上也够用" —— 而占位卡、下拉菜单、抽屉的底色全是 raised。
     修在生成器里（配对表 4 组 → 18 组，深色文本整体上移一档），顺带发现
     `ink-subtle` × `surface-sunken` 在浅色下只有 4.43:1 且结构上修不掉（浅色 `ink-subtle`
     必须明显浅于 slate-700，而 slate-600 在任何比 slate-25 更暗的底上都不够 4.5；色阶没有
     650，插一档会改变 `chroma()` 的索引距离、连带动到所有深色端的彩度），因此定为禁用组合
     写进 design-system §2.5。**规则立完之后它立刻发挥了作用** —— 下一轮唯一的红正是会话菜单
     悬停态踩了这条组合，按规则改成 `ink-muted` 即过。
  2. **组件库的默认值与 a11y 冲突。** Reka 的 `DropdownMenu` 默认 `modal`，打开时给页面其余
     部分挂 `aria-hidden`，但不把里面的元素移出 tab 序 —— 屏幕阅读器被告知外壳不存在，键盘却
     还能 Tab 进去，axe 报 `aria-hidden-focus`。菜单不是对话框，ARIA 的 menu-button 模式并不
     要求隐藏页面，所以设 `modal="false"`。**这正是 11D「尽早真用一次组件库」想换到的信息**，
     和 12B 用 token 切片退役 `@theme` 风险是同一个手法。

  搬运 v1.0.0 的外壳时另修了它两个缺陷而不是照抄：token 刷新原本丢弃响应、失败什么都不做
  （parity 9.23，对挂三个月的大屏是致命的）；`useTheme` 的 `watchEffect` 建在第一个调用者的
  组件作用域里，而第一个调用者是会话菜单 —— 登出即卸载，主题切换从此静默失效。

  最后一条工程结论：Playwright 自带浏览器的下载在这台机器上第二次卡住，已加
  `E2E_BROWSER_CHANNEL` 逃生口（CI 不设），本地验证不再被它挡住 —— 17 例旧 e2e 因此能在本地
  实跑确认 `signIn` 的收紧对两套前端都兼容。

- 2026-08-30：**12C-2 把等价性网接到了新前端 —— 34 例 e2e 一次跑两个前端。** 过程中纠正了自己
  两条判断：① 上一版记的「两套 project 会互相覆盖 `outputDir` / 报告，需要参数化」是错的，
  那只在跑两次 `playwright test` 时成立；做成一次运行两个 project 之后 Playwright 自己按
  project 分目录，反而少了一堆会漂的配置。② 11A 那句「17 例可一字不改复用」不完全成立，因为
  11C 决定重构 IA 就意味着导航文案必然变 —— 但**结论不是分叉出第二套 spec**，而是把差异收进
  `e2e/support/ia.ts` 一张表，由 project 名注入。这么做的价值很具体：不在那张表里的一切都是两套
  前端必须一致的行为，而表里每一条都带着理由；分叉会把这两件事一起藏掉。目前网内 4 例
  （登录 3 + 未知地址 1），其中一例一字未改，其余三例改的只是从 `ia` 取文案或多走一步菜单。
  另外顺手核出一条 P0-f 的**过期待办**：「e2e 纳入 `format:check`」早就做了，根脚本里一直有
  `prettier --check "e2e/**/*.{ts,json}"`。清单自己也会过期，值得定期对着代码核一遍。
- 2026-08-30：**12D 图表基座 —— 最有价值的两件事都是"量出来发现自己错了"。**
  1. **第一版性能基线在骗自己。** 数字是 500 点 25ms、3,000 点 1,024ms、12,000 点 531ms ——
     非单调，所以一定不是绘制成本。原因：ECharts 的 `finished` 事件在**进场动画之后**才触发，
     默认约 1 秒，于是量到的是我们自己选的动画常数。关掉动画（`emulateMedia` 减弱动效）之后
     全区间落在 **10–20 ms**，包括 40,000 点那一档 —— **结论反过来了：ECharts 在目标规模内
     完全不是瓶颈，uPlot 的评估可以搁置。** 教训是：一条不单调的曲线就是"你在量别的东西"的信号，
     不要先去解释它。
  2. **对比度 WARN 不是可以忽略的警告。** 系列色按 NavFleet 自己的表面重跑校验器后，硬门禁全过
     （CVD 最差相邻 ΔE 9.1 / 8.4，正常视觉 19.6 / 19.3），但浅色 3 个槽、深色 4 个槽低于 3:1。
     按方法的救济规则这是一条义务：值必须能通过第二通道读到。所以 `TimeSeriesChart` 内置数据表
     视图 —— **删掉它会让这套调色板变成不合规**，而不只是让组件变小。这个因果关系写进了组件注释，
     否则将来一定有人把它当成可选功能删掉。
     另外两条工程结论：`chart-1…8` **不从 ramp 取**，因为 ramp 只有 4 条有彩色相，凑 8 个必然出现
     同色相配对，而那正是分类编码最不该有的东西；以及 zrender 自己解析颜色、**不认识 `oklch`**，
     所以 token 值要过一次 canvas `fillStyle` 让浏览器转换 —— 直接把 `oklch(…)` 递给 ECharts 是
     静默失效。性能基线那条路由只在 dev / `VITE_CHART_PERF` 下注册，并加了构建门禁断言它不会随
     产品发出去；顺手量到图表 chunk 是 519 KB / 176 KB gzip，作为 Phase 13C 之后的成本起点。
- 2026-08-30：**v1.0.2 已发布**（tag `v1.0.2` @ `ae1a192`，Release + 两个 GHCR 镜像齐全），
  1.1.0 回到 Phase 14 该在的位置。发版规则、修正后的版本映射与事故机制见「发版节奏」一节。
  核实镜像时我自己踩了一次坑，值得记：`publish-images.yml` 自己的运行列表里**只有一次**手动
  dispatch，看起来像"镜像根本没发"。实际不是 —— **`workflow_call` 的运行归属于调用方**，所以要去
  release-please 那次运行里找 `images / images (…)` 两个 job。已把这句写进 `publish-images.yml`
  的注释：那份注释本来就在讲"三次发版没有镜像"，读者按它去查，只会查到错的地方。
- 2026-08-30：**Phase 13A 开工，第一刀就挖到一个真缺陷。** 把 `getDeviceTone` 上提到 fleet-core
  时给它写了第一个测试，立刻发现 v1.0.0 的写法 `Number(device.errorCode?.code) !== 0` 对**缺失
  报码**判定错误：`Number(undefined)` 是 `NaN`，而 `NaN !== 0` 为真 —— 于是载荷里没有 `errorCode`
  的设备被报成**告警**。"没上报"被当成"最坏情况"，方向正好反了。
  这段逻辑此前在三处各有一份（store 里的判定 + `GpsMap.vue` / `DashboardView.vue` 里逐字复制的
  文案表），**三份都没有任何直接测试** —— 正是 ROADMAP 把"两个前端各自一份拷贝"列为平行期最大
  隐患的那种形态：改一份漏两份，不报错，只是两个控制台对同一台车说法不一致。现在一份实现、
  11 个测试、两个前端（**含生产中的旧前端**）都从 `@navfleet/fleet-core` 取。
- 2026-08-30：**覆盖率 ratchet 抓到了一次跨 workspace 搬迁，而正确的反应是两边一起调。**
  13A-0 把覆盖良好的 tone 判定从 `frontend` 搬进 `fleet-core`，`frontend` 的比值随之从 58% 掉到
  57.71%，CI 变红。这是 Phase 10「虚假 100%」教训的**反向版本**：分子分母一起少了，而剩下的代码
  平均覆盖更低，所以数字变差**不是因为覆盖变差，是因为被覆盖的代码离开了** —— 总量其实变好了
  （那段逻辑现在有 11 个测试、100% 覆盖）。
  处理方式：`frontend` 降到 57，**同时把 fleet-core 从 85/79 提到 86/81**。两条都必须做 ——
  只降不升的话，"把代码挪个 workspace"就成了一条悄悄卸掉覆盖率的合法路径。两处 vitest 配置里
  都写了理由，并注明「除此之外的降门槛理由都应当拒绝」。
- 2026-08-30：**13A-1 数据层落地，两个缺陷都是"把不可见的东西变成可断言的"抓出来的。**
  一是**连不上的 connect 会终结整个会话的自动恢复**：旧 WS 层没有 open 超时，心跳只在 `open`
  之后启动，于是一个卡在 CONNECTING 的 socket 既不触发 `close`、不武装 pong 定时器、也不推进
  退避 —— 一次这样的尝试之后就再也不会重连，界面停在"正在重连"。它能藏这么久的原因很具体：
  那 130 行住在 `defineStore` 里且**零测试**，而它每一条失败路径都在定时器上。拆成
  `lib/realtimeLink.ts` 之后，一个 fake socket 加 `vi.useFakeTimers()` 就够，于是有了 18 个测试。
  二是**冷启动期间状态点自称"重连中"** —— 把一次从未发生的失败报给值班的人。这条是第一次
  把状态点渲染出来断言时掉出来的：`connecting` 和 `reconnecting` 被并成了一档，而"正在建立"
  和"正在恢复"在屏幕上必须是两句话。
- 2026-08-30：**地图 token 的机检当场推翻了我自己写在注释里的估计值。** 8 个地图 token 进生成器
  时，`map-grid` / `map-scale` 的对比度是我挑的，我按 3.2 / 3.5 写进注释；实测 **1.59 / 2.70**。
  顺带暴露一处主题不一致：深色网格（slate-700）比浅色显眼近一倍，同一个元素在两套主题里轻重
  不同，换 slate-800 后齐平。教训跟 11D 那次同源 —— **oklch 的明度是感知量、对比度是亮度比，
  两者不是一回事**，凡是"看着都行"的颜色判断都该有个脚本。
  另一半价值在于**判定标准本身要想清楚**：我一开始给两个 token 都套 WCAG 1.4.11 的 3:1，跑出来
  两组 FAIL。但网格整条消失也不丢任何信息，是装饰图形、本就在该条款豁免内；给它套 3:1 只会得到
  一张吵到盖住小标记的底图，而车辆必须是最跳的那一层。所以最终是两条不同下限：比例尺 3:1
  （它是"读出距离"的全部依据），网格只保 1.3:1 的可见性下限。**放宽一个门槛和想清楚它该判什么，
  区别在于后者写得出理由** —— 理由写在脚本文件头和设计系统 §2.2.1。
- 2026-08-30：解析 `semantic.css` 时**第三次**踩同一个坑：按裸字符串找 `@theme`，命中的是文件头
  注释里那段**带花括号的示例 CSS**，于是"块体"读成了注释的一部分，症状是"token 缺失"而文件里
  明明有。`tokens.test.ts` 的注释里早就写着它第一次运行时就是这么错的，我照样又错一次。正确写法
  是匹配"选择器 + 紧跟的花括号"（`/^@theme\s*\{/m`）或先剥注释。已写进设计系统 §6.2.1。
- 2026-08-30：**13A-2a 把地图底座搬进新前端，最有价值的产出是一个"永远不会 settle"的缺陷。**
  `amap.ts` 在脚本标签已存在时给它挂 `load`/`error` 监听 —— 若脚本**已经加载完**，这两个事件
  永不再来，promise 永不 settle，GPS 地图停在加载态：无错误、无从重试、也没有任何东西还在尝试。
  这条路径一步就能走到（第一次尝试脚本加载成功但 `window.AMap` 缺失 → reject → 清掉单飞
  promise → 第二次调用正好走进该分支）。测试判定用的是"50ms 内必须 settle"而不是断言异常
  内容 —— 把旧实现放回去，它报的是"promise never settled — the loader is hanging"，正对症状。
- 2026-08-30：**按"要不要 DOM"切点云，是这次唯一让 375 行拿到测试的办法。** 解析 PCD 头、推导
  几何、按 z 分带、装进占用栅格、算像素 —— 全是纯运算，进了 fleet-core 拿到 30 个测试；真正需要
  document 的只有最后 20 行（`createImageData` / `putImageData` / `toDataURL`）。顺带修掉两处：
  调色板写死成深色（改为参数**并计入缓存键** —— 只改参数不改键会更糟，切主题会拿到上一个主题的
  PNG，像是切换失效了），以及缓存从不淘汰（每条是一整张场景 PNG 的 base64，改上限 6 条 + LRU）。
  旧前端改为 import 共享部分但**继续传原来那对深色写死值**：那是生产镜像里的观感，属于要对着
  渲染结果评审的改动，不该塞在重构里顺手改了。
- 2026-08-30：**热路径里真正贵的不是我以为的那个。** 原计划写着"`pointermove` 无 rAF 合帧"要修。
  看清之后没修，并把理由写进了代码：函数体是两次 `reactive` 数字写入，Vue 调度器本来就把同一
  tick 的多次写入合成一次重渲染，推到下一帧只会给拖拽加一帧延迟。真正的问题在 `wheel`：
  每个刻度一次同步 `getItem`+`parse`+`stringify`+`setItem`，触控板一次手势就是每秒 60–120 次
  主线程同步存储往返，全在输入事件处理器里 —— 改成读走内存、写按 250ms 合并、`pagehide` 与
  卸载时落盘。**"计划里写了要修"不等于"那里就是瓶颈"**，这条值得记。
- 2026-08-30：`useSvgViewport` 覆盖率 **1.07% → 98.16%**（35 例）。写测试时被自己的测试挑出两处
  假设错误：harness 里用 `options.bounds ?? WORLD` 让 `bounds: null`（"还没有场景"）被悄悄替换成
  了世界边界，`??` 对 null 也生效；以及"世界缩小后视图会被夹回边界内"是错的 —— 真实行为是
  `restoreViewportState` 拒掉越界的存档，然后**定位车辆优先于夹回**，车在哪就看哪。后者不是缺陷，
  是遥测胜过记忆的正确取舍，测试改成断言真实行为并写下原因。
- 2026-08-30：**13A-2b 里最值钱的一条又是机检推翻了我的做法，而且这次推翻的不是取值、是维度。**
  给点云补浅色调色板时，我按"挑两个在浅底上读得清的颜色"去做，三组机检全 FAIL。原因不在色相：
  在近白画布上，**64% 不透明度的洗色无论取什么颜色都到不了 3:1** —— 剩下 36% 透出来的画布本身
  就把合成后的亮度垫在了 3:1 允许的上限之上。这是代数，不是审美。所以 alpha 必须成为调色板的
  一部分（浅色 obstacle 从 164 提到 220），而不是继续当共享常量。
  顺带把 alpha 也做成了 token，并让机检**直接读 token** 而不是把值抄进脚本 —— 抄一遍就只是在
  验证抄得对；读一遍，验的才是真正会被画出来的那个组合。
- 2026-08-30：**一处计划要改：`dashboard.spec.ts` 不接进 `SHARED_SPECS`。** 盘完发现它做不到也
  不该做 —— 那份 spec 断言的是 v1.0.0 的**版面**（`article` 卡片、标题为 车辆信息 的
  `complementary`、侧栏里的设备按钮），因为在 v1.0.0 里地图只是那个塞满的仪表盘的一格。而 IA
  重构的全部意义就是把它们拆开。共享它等于逼新前端复现它要取代的东西。
  **可共享的是行为，不是版面**：真正要紧的两条已经用与旧 spec 完全相同的测量方式写进了
  `console-devices.spec.ts`（`.map-surface svg .ros-marker.fusion .ros-marker-core` 的屏幕坐标），
  所以引擎一旦回归两套 e2e 会同时红。**"把 spec 接过来"当时听着像个明确的收口条件，其实混淆了
  "证明行为一致"和"证明长得一样"。**
- 2026-08-30：`GpsMap` 的 `useTheme()` 从 `{ state }` 对齐到 `{ resolved }` —— 一处**运行时会炸
  但模板看着完全健康**的 API 破裂。原样搬过来的话，要等到有人切一次主题才会发现，而那不在任何
  一条自检里。它是 13A-2a 盘点时记下来的四条之一，这也是"先盘点再搬"值那一次的地方。
- 2026-08-30：跨 workspace 的 e2e 契约现在**由单测显式钉住**了：
  `.map-surface svg .ros-marker.fusion .ros-marker-core` —— 组件在 `frontend-next/`，断言在
  `e2e/`，而在此之前没有任何东西说明这两者绑在一起。改个 class 名，红的会是另一个 workspace 里
  一条看起来毫不相关的测试。
- 2026-08-30：**13B 里两条"接上被丢弃的服务端数据"，最后都不是照着接的。**
  `summary.gpsCount`：服务端确实算好了下发，但那是构建**快照**时算的，而之后到达的绝大多数是
  单设备 delta —— 直接读它会让数字和屏幕上的行对不上，比重算更糟。所以补的是"本地也算这一个"，
  不是"改成信服务端"。
  服务端 `updatedAt`：不是把 `new Date()` 换掉，而是并存。相对新鲜度必须在**同一个时钟**上量，
  否则浏览器时钟一偏就出现"更新于 -8 秒前"；而值得**显示**的绝对时间是服务端那个 —— 摄入时间戳
  在后端早已停止产出时看起来依然很新。两个字段各答各的问题。**"这个数据被丢弃了"是对的，但
  "所以把它接上"不是自动成立的下一步。**
- 2026-08-30：**又一条计划要改：`LaneletOverlay.stats` 不做成总览页的场景信息卡。** nodeCount /
  wayCount 是开发者视角的数字，值班的人不需要在总览页看路网有多少个节点。它真正有用的位置是
  地图自己的图例：`路网覆盖 · 128 段` 回答了图例本身答不了的问题 —— 覆盖层是不是**完整**加载了，
  而不只是加载了。一行代码，落在 `SceneMap` 里，由 e2e 断言。
  这是 13A-2b 之后第二次把"计划里的一个条目"从"照做"改成"想清楚它要答什么问题"。两次的形状一样：
  **条目记住的是"这个数据没人用"，而不是"谁需要它、在哪需要"。**
- 2026-08-30：总览页的形状本身是一条判断：**健康车辆排除而不是排在最后。** 一张永远是那四十行的
  列表没人看；全部正常时用一句话说完（"全部 N 台设备状态正常"）才是有用的答案。同理四张 KPI 卡的
  颜色只在数字本身说话时才不是中性色 —— 一张永远琥珀色的卡片教会所有人忽略琥珀色。
- 2026-08-30：**13C 的报码字典是这个项目里第一次"照抄标准而不是自创"，而这恰恰是它值钱的地方。**
  调研了 VDA 5050（AGV↔调度系统的事实标准）与 SAE J1939。真正被采纳的是 VDA 的一条设计：
  **严重度按"车辆还能做什么"定义，而不是按"有多糟"** —— 能否继续当前任务、能否接受新任务。
  「严重/一般/提示」对调度员什么都没说；「无法继续当前任务但仍可接单」他立刻知道要绕开这台车
  但不必派人。自创一套严重度是很容易的，也很容易得到一套无法据以行动的。
  J1939 只借了它的"关注点分离"：SPN 说*什么*坏了、FMI 说*怎么*坏的；四位码的通道/子系统/条件
  是从 v1.0.0 已有的 1101 / 2203 / 5102 **反推**出来的，不是另立一套让旧数据失效。
- 2026-08-30：**字典建起来的第一件事就是暴露演示数据的一处错**：`1101` 同时被当作 定位稳定 与
  远程接管中 —— 同一个号，两个无关的含义。这正是没有权威表时看不见、有了表立刻现形的那种漂移。
  远程接管改为 `1601`，并加了一条"无重码"的断言。同一轮里我自己写的 `1501` 处理建议只有"无需处理。"
  五个字，被我自己那条"没有处理建议的条目只是换了个好名字的数字"的断言挡下来 —— 我改的是文案，
  不是断言。
- 2026-08-30：**关于演示码表，划了一条边界并写进了 P1-d 的前置说明**：仓库是 public，
  **厂商手册能下载不等于授权再分发**，所以不逐条抄任何厂商的码表。可以照抄且理直气壮的只有
  VDA 5050 的 `errorType` 枚举（公开标准，本就是给人实现的）；其余按公开文档的*故障类别与分层*
  自己写文案 —— 得到的是真实**形状**而不是真实**内容**。真实码值等设备供应商给。
- 2026-08-30：一轮讨论把**多厂商/多车型适配**这个空洞记成了 P1 批次（a–e + 一个建议的 14.5 调研
  阶段）。现状准确说法是"字段别名容错"而不是"厂商适配"：`normalizeDevice` 宽容命名风格差异，
  但载荷结构是硬编码的一种方言。**展开时机取决于一个还没有答案的问题** —— 第二种车是真要接了，
  还是储备？两者正确做法不同，这与决策 #1 暂缓"数据范围隔离"用的是同一条判据。
  刻意不塞进 Phase 13：13 的目标是"新前端替换旧前端"、14 要发 1.1.0，中途插入跨前后端的架构层
  会让那次发版范围失控。
- 2026-08-30：顺带纠正 ROADMAP 一处过时描述：`topicPattern` **确实已经接进订阅**
  （`buildTopicScheme` → `client.subscribe`），不再是"仅作快照元数据"。
- 2026-08-30：**13D-1 里最值得记的是一条三行的细节：撤销只还原这次真正改动的 id。**
  批量确认时若把"本页所有 id"交给撤销，那些**在这次操作之前就已被确认**的告警会被一起取消 ——
  等于抹掉别人（或自己早先）的工作。所以 `acknowledgeMany` 返回它实际改动的集合，撤销只反转那个集合。
  这类缺陷不会报错、不会红、也几乎不会被发现，因为它只在"部分已确认"这个状态下发生。
- 2026-08-30：给 toast 加 action 支持时顺手定了一条：**点了撤销就关掉这条 toast**。把"撤销"留在
  屏幕上等着被再点一次，就是撤销撤销。
- 2026-08-30：13D 拆成两个 PR。声音提醒有自己的设计面（解锁流程、免打扰时段、只给 critical）与
  自己的测试方式（浏览器自动播放策略），混进等价那一块会让它的判断埋在一个大 diff 里。
- 2026-08-30：**13D-2 里最好的一个决定是让可供性与手势合成一件事。** 浏览器要求先有用户手势才允许
  播放，所以"启用声音"这件事无法由控制台自己完成。常见做法是藏一个 hopeful 的 `play()`，失败了也
  不说；这里改成**报告状态的那个控件就是解锁的那个控件** —— 一个人为了"让声音能响"点的这一下，
  正好就是策略要求的那一下。附带效果是：未解锁时它天然会显示"声音未启用"，而不需要另外找地方提示。
- 2026-08-30：三条把"功能"和"会被关掉的开关"区分开的规则，都写进了代码注释：**只给 critical**
  （每条预警都叫的控制台一个班次内就被拧掉音量，而被静音的喇叭比没有喇叭更糟 —— 看起来像有覆盖）；
  **第一次观测只播种**（登录时已有四条 critical 不该响四声）；**静音期间仍然消费 id**（午饭回来解除
  静音不该把这段时间重播一遍）。
- 2026-08-30：免打扰窗口**跨零点**那条单独导出成 `isQuietAt` 并单测，因为 `from <= h && h < to`
  在起点晚于终点时会静默地把整个窗口关掉 —— 而每一个夜间窗口都是这样。
- 2026-08-30：**刻意没给声音加 e2e**，理由值得记：解锁成不成功取决于浏览器自动播放策略，而
  Playwright 传给 Chromium 的策略标记与真实浏览器不同 —— 断言它等于断言测试夹具的开关，不是断言
  产品。可确定断言的那部分（控件存在、未解锁文案、`aria-pressed`）已由单测与 axe 覆盖。
  **"这件事该由哪一层测"本身是判断，不是默认加一条 e2e 更保险。**
- 2026-08-30：**PR #96 的 CI 红在 e2e，而它不是回归、也不该用"重跑一次"处理。** 失败是
  `Test timeout of 45000ms exceeded`：axe 那条"每个路由 × 每个视口"的测试要做 32 次分析，本地热机
  勉强 19s 过、CI 冷机超时。我这次改动（顶栏多一个按钮、App 多一个 watcher）只是把它推过了线。
  **修法是把测试按视口拆开，不是把超时调大**：调大只让下一次超时来得更晚，而超时本身什么信息都
  不给 —— 不知道是哪个路由、哪个宽度慢。拆开后每条 8 次分析（本地约 5s、CI 有充足余量），失败时
  标题里就写着是哪个视口。e2e 从 54 例变成 60 例，覆盖面没变，只是预算的粒度对了。
