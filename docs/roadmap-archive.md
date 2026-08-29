# 路线图归档：v1.0.0 之前（Phase 0–10）

> **这是历史记录，不是待办。** v1.0.0（2026-08-29）之后的计划见 [ROADMAP.md](../ROADMAP.md)。
>
> 归档的理由：v1.0.0 是后续所有改动的起点，当前路线图应当只讲往前走的路。这些阶段的取舍依据
> 与每一步修掉的真实缺陷仍有参考价值 —— 尤其是那些"看起来像功能、其实是缺陷"的条目 —— 所以
> 原文保留，只是搬出主路线图。v1（Phase 0–5）的过程未逐阶段留档，下面从 v2（Phase 6）开始。

## v2（Phase 6–10）：工程产品级

v1（Phase 0–5）已交付：MQTT→归一化→内存快照→Mongo→REST/WS→Vue 的完整只读监控系统，含
RBAC、Docker、探针/metrics、文档。本路线图承接 v1，把项目推向**工程产品级可交付**。

范围锁定：只读监控，不做控制下发 / 多租户。四项既定决策：
先工程基座 → 迁 monorepo → 暂不做 i18n → **面向更广交付**（TLS/CD/镜像发布按更高标准）。

工作方式：**每个 Phase 拆为若干 PR**，每个 PR = 独立分支 → 实现 → 本地自检（lint/format/typecheck/test/build）
→ 推送 → CI 全绿 → `--no-ff` 合并 → 更新本文件。每完成一个增量都回来勾选并记录自检结果。

工具选型（本轮）：**npm workspaces**（非 pnpm，最小改动、保留现有 npm/Docker/CI 流、可逆）；
CD 用 **release-please**（贴合现有 conventional-commit 历史，自动 CHANGELOG + GHCR 发布）。

图例：`[ ]` 待办 · `[~]` 进行中 · `[x]` 完成（附自检）

---

## Phase 6 — 工程基座升级 ✅ 完成（v0.2.0 已发布）

> 目标：monorepo + 共享类型单一来源 + 治理 + CD/发布，让后续重构都在统一流水线与单一类型源上进行。

### PR 6A — monorepo 基座 + 共享类型包

- [x] npm workspaces 根 manifest（`backend` / `frontend` / `packages/*`），单一根 lockfile
- [x] `packages/shared`（`@navfleet/shared`）：领域类型单一来源，前后端共同引用
- [x] 后端 `types.ts` 与前端 `types.ts` 收敛为 `export type *` 引用 shared，删除重复源
- [x] CI 改为 workspace 感知（单根 lockfile，`npm ci` + 各 workspace `-w` 门禁）
- 自检 ✅（2026-08-26）：根 `typecheck`（shared/backend/frontend 三包全过）· `test` 后端 56 + 前端 29 全绿 · `lint` 无错 · `format:check` 全过 · `build` 后端 tsc + 前端 vite 均成功；已验证 `import type` 在后端产物中被完全擦除（`dist/types.js` 无 `require("@navfleet/shared")`，运行时零耦合）。

### PR 6B — 仓库治理与预提交护栏

- [x] `husky` + `lint-staged` 预提交（暂存文件 `prettier --write`；完整门禁仍在 CI）
- [x] `dependabot`（npm workspaces @ `/` 分组 + GitHub Actions，每周）
- [x] `CONTRIBUTING.md`、PR 模板、Issue 模板（bug/feature）；`package.json` 标 `UNLICENSED`
- [ ] `LICENSE`（待用户拍板授权类型）、`CHANGELOG.md`（改由 PR 6C 的 release-please 托管）
- 自检 ✅（2026-08-26）：根 `format:check` 全过 · husky 钩子已装（`.husky/pre-commit` → lint-staged）· 既有 lint/typecheck/test/build 未受影响。

### PR 6C — CD 与发布自动化（面向更广交付）

- [x] Docker 改造为 workspace 感知构建（root context + 根 lockfile + `npm ci --ignore-scripts` 跳过 husky；backend/frontend 均从仓库根构建，前端 context 由 `../frontend` 改为 `..`）
- [x] GHCR 镜像构建并发布（`publish-images.yml`：release published / 手动触发，backend+frontend 矩阵，semver+latest+sha 标签，gha 缓存）
- [x] `release-please`（manifest 模式，单根组件）：语义化版本 + tag + 自动 CHANGELOG + GitHub Release
- [ ] 可选：镜像 SBOM / 签名（延后）
- 自检 ✅（2026-08-26）：本地 `docker compose build backend frontend` 均成功；backend 镜像入口 `backend/dist/index.js` 存在且运行时依赖全部从 hoisted node_modules 解析通过；frontend 镜像 `/usr/share/nginx/html` 资产齐全。两个 CD workflow 为 YAML，合并到 main 后首跑验证（release-please 需仓库开启「Allow GitHub Actions to create and approve pull requests」；GHCR 发布用 workflow 内置 GITHUB_TOKEN + packages:write）。

### PR 6D — 收尾与漂移修复

- [~] 清理遗留 phase 分支、`origin/HEAD` 指向 main（分支清理为纯 git 操作，PR 外单独执行）
- [x] 修 `deploy/docs/deployment.md` 弱口令 drift（最小配置改占位口令）、`config-reference.md` Windows 路径示例改 POSIX
- [x] CI 覆盖率上报（`@vitest/coverage-v8` + 产物上传）+ Node matrix（20/22）
- 自检：_容器验证 test:coverage 通过后回填_

**Phase 6 收口**：根级 `npm run build/test/lint` 全绿；push tag 自动出镜像 + release；shared 包被前后端引用。

---

## Phase 7 — 类型安全与架构重构 ✅ 完成

- [x] 后端 `index.ts`（548→~115 行）拆 `app.ts` + `routes/*`（ops/fleet/scenes/debug）+ `websocket.ts` + `mqtt.ts` + `metrics.ts` + `logger.ts` + `runtimeState.ts`（PR #28，7B）
- [x] 后端 config → zod 校验 + fail-fast（消灭静默兜底），`parseConfig` 单测（PR #27，7A）
- [x] 前端标准 util 全部 .js→.ts：`amap`/`data-defaults`/`point-cloud`（PR #29，7C）、`fleetNormalize`（457 行核心，PR #32）
- [x] `fleet.ts` 去 `Record<string,any>`（用 `@navfleet/shared` 类型 + `unknown` 收窄），前端 `no-explicit-any` 由 off→**error**（PR #33）——至此前端 `src` 下**无显式 `any`**
- [x] 前端 `RosSceneMap.vue`（1162→592 行）拆 `useSvgViewport`/`useSceneOverlay`/`useSceneViewportPersistence`（PR #35；jsdom 10 场景逐字节等价 + Playwright 明暗实测）
- [x] `main.css`（2091 行）拆 19 个 partial + 按级联顺序 `@import`（PR #37）——构建产物 CSS **逐字节一致**（Vite 内容哈希未变），级联零风险
- [x] 抽 `formatters` 共享 util（消除 Dashboard/History 重复，#38）
- [ ] 所有带逻辑 SFC 逐步 `lang="ts"` + typed props —— **本轮未做**，11 个 `.vue` 仍是普通 `<script setup>`；推到 1.1，`vue/block-lang` 已按「允许无 lang」放行
- **收口**：`vue-tsc`/`tsc` strict 全绿、无 `any`、god-file 拆分完成

## Phase 8 — 健壮性与测试深度 ✅ 完成

- [x] store 摄入串行化队列（根治 read-modify-write 竞态，PR #39）——修复前 4 个并发 payload 只剩 1 个，有「修复前必失败」的回归测试
- [x] Mongo 重连 + 真实健康探测（#40，含 topology 事件驱动、有界退避、URI 脱敏）
- [x] MQTT 摄入 zod 校验 + 路径参数校验（#41，含被拒计数指标；保留 `parseOnline` 的明文 status 白名单）
- [x] 前端 error boundary + 全局错误处理 + 路由守卫 + 真 404（#42）
- [x] 后端 supertest 集成测试（路由/鉴权/校验/404/错误中间件）+ configRegistry + WS 单测（#43，97→212）
- [x] 前端 store/实时链路/api/auth·theme 测试（#44，45→115）
- [x] Playwright E2E 入库并进 CI（#45，11 例，无需 Mongo/MQTT/docker）+ 两个 workspace 覆盖率门槛（ratchet）
- **收口达成**：竞态回归通过 · 覆盖率门槛在 CI 生效 · **E2E 在 CI 跑通**（node 20 job 绿）
- 测试总量：**61 → 327**（后端 212 + 前端 115）+ 11 E2E

## Phase 9 — 安全硬化与可观测性生产化 ✅ 完成

- [x] `prom-client` 替换手写 metrics + per-route 请求直方图；request-id 贯穿日志与 500 响应（#47，9A）
- [x] 全局限流 + `trust proxy`（修「整个部署共用一个限流额度」）、pino 脱敏落到全部子系统 logger、显式 CSP、生产配置审计 fail-fast、WS 只用 cookie 传 token（#48，9B）
- [x] mosquitto 关匿名 + 双向 ACL + 1883 改绑 127.0.0.1；docker 三网分段；两个 nginx 非 root；edge 下线 `/metrics`、`/openapi.json` 移到鉴权后（#49，9C）
- [x] TLS 叠加编排（HSTS / 308 跳转 / `COOKIE_SECURE` 硬编码 true / 路由表单一来源 `locations.conf`）+ 自签名证书脚本（#50，9D）
- [x] Prometheus + Grafana 叠加编排 + 预置数据源/14 面板 + 9 条告警规则；备份容器 + **恢复演练脚本**（#55，9E）
- [x] `/api/v1` 前缀（双挂载，鉴权保持不加版本）；OpenAPI 入参 schema 由 zod 生成；Swagger UI 同源自带（#55，9F）
- [x] ROS 地图：默认视口改为适应场景（原为 22.22x 的 45m 特写）、演示车沿 lanelet 中心线行驶、场景内全部车辆可见（#55）
- **收口达成**：安全清单达标 · 告警规则全部写在真实暴露的指标上（机检 25 处引用零缺失）· 恢复演练实跑通过 · 入参契约由验证器生成、结构上无法 drift
- 自检 ✅（2026-08-27，9A–9D）：`typecheck`/`lint`/`format:check`/`build` 全过 · 测试 212 → **260**（前端 115 不变）· `e2e` 11/11 · 后端覆盖率 82.4/81.9/85.0/82.4（ratchet 提到 80/79/82/80）· compose 基础与 TLS 两种编排均实跑通过（五容器 healthy）。

## Phase 10 — 产品体验打磨 ✅ 完成（i18n 本轮排除）

- [x] a11y：LoginForm 表单命名/错误播报/自动聚焦、skip-link、唯一 `<main>` 地标 + 导航后焦点转移（#59）
- [x] a11y 自动化：`@axe-core/playwright` 进 E2E，5 个页面 × 明暗两套主题，WCAG 2.1 A+AA
- [x] 骨架屏：`bootstrapPending` 贯穿 store→视图，首屏快照在途时渲染占位而非空态文案
- [x] 设置页 `/settings`（主题单选组、清除本地数据、连接诊断）；404 页此前已在 #42 落地
- [x] `useHistoryPlayback` composable（12 例单测）、GpsMap deep-watch 改签名比对（#59）
- [x] 列表虚拟化：**实测后决定不做**（见下）
- [x] 告警中心：筛选/搜索/批量确认/分页此前已完整，本轮补 `aria-pressed`（严重度筛选此前只有 `active` class，读屏器听到四个一模一样的「按钮」）

**本阶段修掉的真实缺陷**

1. **空态文案冒充加载态**。首屏快照到达前，仪表盘渲染的是「当前筛选条件下没有设备数据」——什么都没被筛选，却在让操作员去改筛选条件；同时统计卡显示「在线设备 0 / 0」「活动告警 0」，读起来像全队掉线，而不是像一个还没回答的请求。现在由 `bootstrapPending`（在 `finally` 里清除，所以 bootstrap 失败也不会让页面永久闪烁）驱动骨架屏 + `aria-busy`，占位条本身用 `aria-hidden` 留在无障碍树外。浏览器实测（把 snapshot 请求压住 3 秒）：加载中 10 条占位、两个区域 `aria-busy=true`、**零条空态文案**、统计值留空；到达后 0 条占位、5 台设备、真实数值。
2. **嵌套 `<main>`（我在 #59 引入的回归）**。`App.vue` 加了 `<main id="main-content">` 地标，但 `DashboardView`/`HistoryView` 各自已有一个 `<main>`，于是每页两个 `main` 地标且互相嵌套 —— 非法 HTML，辅助技术会看到两个「主内容」区域。两处改回布局用 `<div>`；四个页面实测均为 `main=1 / 嵌套=0 / h1=1`。
3. **骨架屏自己带来的布局跳动**。统计卡占位是 14px 的行，替代的却是 27px 的行盒，真实数值到达时每张卡长高 13px —— 占位高度不对，等于把跳动从加载时挪到落数据时。加 `skeleton-value`（对齐 `.headline-stat strong` 的 20px×1.35 行盒）后实测位移 **0px**。
4. **覆盖率门槛被「空覆盖」撑高**。v8 对任何测试都没 import 过的文件报 100% functions（没插桩，自然没有遗漏），`DashboardView.vue` 正是其一。给它补上真实的挂载+交互测试后，那个虚的 100% 变成真实的 75%，全局 functions 反而从 91.5% 掉到 84%，而同一改动让语句覆盖率翻倍（31%→62.5%）。门槛已按真实测量重新标定：statements/lines 27→58、branches 82→84、**functions 87→81（唯一下调项，原因是度量口径变了而非代码变差）**。`AlertsView`/`HistoryView` 仍是虚的 100%，将来补测时 functions 会再掉一次、语句会再涨一次。
5. **浅色主题的品牌色对比度整体不合格**。`--brand-contrast: #ffffff` 落在中调青绿 `--brand` 上只有 **2.99:1**（AA 要求 4.5:1），影响登录提交按钮、导航激活态、历史页主按钮；改成与深色主题同一套深墨 `#04231f` 后 5.55:1。另有两处硬编码的深色主题薄荷色（`.pose-status.ready` 的 `#a7ffee`、`.detail-formation-tag` 的 `#bffbf3`）落在浅色品牌浅底上只有 **1.02:1**，抽出 `--brand-ink` 语义 token（深色 `#a7ffee` / 浅色 `#0a5f52`）解决。两个 token 的区别写进注释：`--brand-contrast` 用于**实心** brand 表面，`--brand-ink` 用于 `rgba(--brand-rgb, …)` 薄底 —— 后者贴近周围表面，所以明度需求正好相反。
6. **回放条两个控件没有可访问名称**（`label` / `select-name`，均为 critical）：进度滑块和倍速下拉按设计不带文字，读屏器只会念「滑块」「组合框」。补 `aria-label`。
7. **可滚动区域键盘不可达**（`scrollable-region-focusable`）：`.detail-scroll` 会滚动且内部没有任何可聚焦元素，折叠线以下的遥测对键盘用户完全取不到。补 `tabindex="0"`。

**列表虚拟化：实测后决定不做**

jsdom 四档实测（`frontend/test/views/largeFleet.test.ts`，jsdom 比真实浏览器高估 DOM 成本数倍）：

| 设备数 | 挂载   | 全量更新（含 DOM patch） |
| ------ | ------ | ------------------------ |
| 6      | 2.8ms  | 2.1ms                    |
| 50     | 8.9ms  | 5.2ms                    |
| 200    | 34.5ms | 17.4ms                   |
| 500    | 85.3ms | 43.5ms                   |

本平台实际监控 6 台车，列表成本可忽略；引入虚拟滚动要付出 Ctrl-F 失效、焦点管理复杂化、多一层滚动容器的代价，换不到任何收益。**该测量本身入库**，但断言放在唯一确定的量上——每行 DOM 节点数（当前 8，上限 16）——那才是让长列表变成渲染问题的原因；时间只打印给人看，不作断言（墙钟数在 CI 里必然不稳）。真要重做虚拟化，触发条件是节点数上限被突破或部署规模量级变化，而不是「感觉列表长了」。

- **收口**：大规模车队渲染无卡顿 ✅（以实测数据结论化，而非加复杂度）；a11y ✅ —— 用 `@axe-core/playwright` 进 E2E 取代一次性 Lighthouse 跑分：跑分是某台机器上的一个瞬时数字，进了 CI 的规则集才是回归网。5 个页面（登录 + 4 个已登录视图）× 明暗两套主题，`wcag2a + wcag2aa`，serious/critical 为红线，失败信息打印 axe 报的**全部**违规（规则 id、影响级别、每个失败选择器、以及 `failureSummary` 里的对比度数值），无任何 `exclude` 或 `disableRules`。修完后 10 次审计**零违规**（含 minor/moderate）。

**a11y 自动化的已知边界**（写下来免得把「测过」当成「都覆盖了」）

- 深色主题这一趟是专门加的：Chromium 报 `prefers-color-scheme: light`、应用默认偏好是 `system`，所以不显式播种 `navfleet:theme` 就只会审到浅色，而深色恰恰是本控制台的默认观感。该用例带一条前提断言（`html[data-theme=dark]`），否则偏好一旦失效就会静默变成「又审了一遍浅色」的假绿。
- 单一视口（1440×900）、单一引擎（chromium），无响应式与跨引擎审计。
- 只审各视图的默认状态：告警抽屉、toast、hover/focus 态、`data-tone="normal"` 徽标在 axe 运行时都不在屏上。
- **axe 的 `incomplete` 桶没有断言**。半透明/渐变表面会落进这一桶而不产生违规，所以 `.tab-btn.active`（薄荷渐变）和设置页 `dd[data-tone="ok"]` 都躲过了检查 —— 后者是真实缺陷（`--brand` 作为文字落在近白面板上约 2.6:1），靠读代码发现并改用 `--brand-ink` 修掉了。**这类缺陷这套suite 抓不到**，仍需人看。
- 未跑 `npm ci` 验证重新生成的 lockfile 在 Linux 上干净安装（已独立核对：diff 内 `npmmirror` 命中 0 次，两个新包的 `resolved` 均为 `registry.npmjs.org`，版本精确钉在 `4.13.0`）。

---

## 执行记录（v2）

- 2026-08-26：完成三路架构审计（后端/前端/DevOps），生成 v2 路线图，启动 Phase 6 / PR 6A。
- 2026-08-26：PR 6A（monorepo+shared 类型，#1）、PR 6B（治理+预提交，#3）已合并入 main；修复 npm#4828 跨平台 lockfile 陷阱（见记忆 navfleet-ci-lockfile）。
- 2026-08-26：PR 6C —— Docker workspace 化（本地 compose build 通过）+ release-please + GHCR 镜像发布。
- 2026-08-26：PR 6D（#17）—— CI 覆盖率上报 + Node 20/22 矩阵 + 文档漂移修复；release-please 首次发布 **v0.2.0**。Phase 6 收口。
- 2026-08-26：依赖现代化（自做 bump 取代 dependabot PR）—— vue-tsc 3 / lint-staged 17 / vite 8 / @vitejs/plugin-vue 6 / pino 10 / **express 5** / **mongodb 7**，均含运行时/连库冒烟验证；TypeScript 7 因 breaking 暂缓。
- 2026-08-26：Phase 7A（#27 config zod fail-fast）、7B（#28 index.ts 拆分）、7C（#29 utils→TS）合并。
- 2026-08-26：fix(mock)（#30）—— demo 发布器 PID 文件单实例守卫，修复电量每秒在 0/演示值间跳动（根因：两个发布器并发）。
- 2026-08-26：Phase 7D —— fleetNormalize→TS（#32）、store 去 `any` + 开启 `no-explicit-any`（#33）。前端 `src` 无显式 `any`。
- 2026-08-26：Phase 7 收口（#35 RosSceneMap 拆分、#37 main.css 拆 19 partial 且构建产物逐字节一致、#38 formatters）；fix(mock) #36 电量改为可持续作业循环。
- 2026-08-26：**Phase 8 收口** —— #39 竞态 · #40 Mongo 重连 · #41 摄入校验 · #42 前端韧性 · #43 后端集成测试 · #44 前端 store 测试 · #45 E2E 入 CI + 覆盖率门槛。测试 61 → 327 + 11 E2E。
  期间两件值得记录：GitGuardian 拦住了 E2E harness 里硬编码的测试口令（改为每次运行 `crypto.randomBytes` 生成并压缩提交历史）；GitHub Actions 大范围故障导致 CI 一度无法运行，恢复后 11 项检查全绿方合并。
- 2026-08-26：Phase 7E（#35 RosSceneMap 拆 composable）、fix(mock)（#36 电量改为可持续作业循环，修掉长跑后归零）、Phase 7F（#37 main.css 拆 19 partial，构建产物逐字节一致）。
- 2026-08-27：Phase 9A–9D（#47 可观测性生产化、#48 应用层硬化、#49 部署硬化、#50 TLS）。这四个 PR 里有五处是**修既有缺陷**而非加功能，都有实测证据：
  1. `trust proxy` 从未配置 → 在 nginx 后面两个限流器把所有请求算到 nginx 一个地址上，登录限流「15 分钟 50 次」是全体用户共享的（有「修复前必失败」的测试）。
  2. 四个子系统各自 `pino({ name })`，不继承 `LOG_LEVEL` 也不继承脱敏 → 实测 `LOG_LEVEL=warn` 下 `config-registry`/`dashboard-store`/`auth` 仍在打 info 行。
  3. mosquitto `allow_anonymous true` 且绑 `0.0.0.0` → 任何能碰到 1883 的东西都能灌假遥测。ACL 双向隔离已用「发布账号能进、后端账号被丢」实测。
  4. 边缘代理了未鉴权的 `/metrics`；`/openapi.json` 对匿名开放。
  5. 直方图 route 标签在错误路径上与成功路径不一致（Express 在 `next(err)` 时已还原 `baseUrl`），一条路由裂成两条序列且错误延迟从面板消失 —— 被自己写的测试抓到。
     过程记录：`prom-client` 已被 npm 标记 deprecated，官方后继 `@prometheus-io/client` 首个稳定版仅 3 天、周下载 ~750（对比 900 万），因此暂留并在代码里注明；E2E 因「每次运行临时口令 + Playwright 默认复用已有 server」在本机必然 401，改为独立端口 3199/5299 且不复用；mosquitto 首次起不来（root 生成的 0600 密码文件在 broker 降权到 uid 1883 后读不了）。
- 2026-08-27：**Phase 9 收口**（#54 GPS 车标锚定、#55 9E+9F+ROS 地图）。几处值得记录：
  1. GPS 车标带着 `translate(-50%,-100%)`，叠加在 AMap 自身锚点之上 —— 实测偏离坐标 71px，而像素偏移在不同缩放下代表不同地面距离（zoom 16 约 170m、zoom 11 约 5km），这就是「车随缩放漂移」的成因。
  2. `gps.heading` 发的是场景 yaw（0=东、逆时针），消费方按罗盘方位角读 —— 方向指示偏 90° 且转反。改为发真方位角后，四台车「上报值 vs 位移推算」误差 0.0°。
  3. ROS 地图 22.22x 是**计算出来的默认值**（`viewport.width / 45` 的特写覆盖了正确的整场景 fit），不是残留状态；改后 7.21x、整张路网可见。
  4. 演示车原先沿 `scene.bounds` 算出的矩形跑，与路网无关；改为沿 lanelet 中心线后实测距路网 0.00–0.01m。样本网络 88 条 lanelet 只有 36 条声明 centerline，其余由左右边界求平均（Lanelet2 本身也这么做）。
  5. 监控用**叠加文件**而非 compose `profiles:` —— compose 会在应用 profile **之前**插值整个文件，profiled 服务上的 `${GRAFANA_ADMIN_PASSWORD:?}` 会让所有没启用监控的部署 `up` 失败。两个方向都实测过。
  6. OpenAPI 的入参 schema 改由 zod 生成后立刻暴露了一处既有 drift：手写的 `LoginRequest` 漏了 `minLength: 1`，文档在承诺空字符串可用。
- 已知遗留：后端测试仍有约 1/6 的偶发失败（issue #53，根因是 supertest 每请求起一个服务器导致端口/socket 串台，#52 已消掉客户端连接池那一半）；`prom-client` 上游已 deprecated，待 `@prometheus-io/client` 有采用度后替换；88 条 lanelet 中 46 条带 `delete="true"` 标记但解析器未过滤，仍被绘制。
- 2026-08-28：Phase 10 完成。骨架屏（含 store 侧 `bootstrapPending`）、设置页 `/settings`、axe-core 进 E2E（5 页 × 明暗双主题）、大规模渲染实测后决定不做虚拟化。修掉 7 处真实缺陷，其中 3 处是我自己前一轮引入或遗留的：嵌套 `<main>` 地标（#59 加地标时没检查视图已有 `<main>`）、骨架屏自身的 13px 布局跳动、设置页 `--brand` 当文字用的 2.6:1 对比度。
  - 浅色主题 `--brand-contrast: #ffffff` 在中调青绿上只有 2.99:1，影响登录按钮/导航激活态/历史页主按钮 —— 这是**产品自始存在**的缺陷，靠机检才浮出来，此前三轮人工审阅都没发现。
  - 覆盖率门槛重标定，`functions` 87→81 是唯一下调项：v8 把「没被 import 过」的文件报成 100% functions，`DashboardView` 补真实测试后由虚的 100% 变成真实 75%，同期语句覆盖率 31%→62.5%。度量变诚实导致数字下降，不是代码变差。
  - 测试总量：后端 279 + 前端 **158**（+26）+ E2E **14**（+3）。
- 2026-08-29：**v1.0.0 发布**（#61 收尾 · #62 间距与版本一致性 · #63 release）。v2 路线图（Phase 6–10）到此全部完成，1.0 作为后续作业的地基。
  - 根治 issue #53：`createTestApp()` 每个测试都 `listen(0)`（整套约 280 次），改为**每文件一个长生命周期服务器池**后降到 12 次。翻转率 10 次 2 红 → 42 次连续通过（30 次由子代理 + 12 次独立复跑），随后 CI 在 node 20/22 上连续三个 PR 全绿，补上了 Linux 侧证据。
  - ROS 地图不定位车辆，**根因不是最初两次猜测的任何一个**：bounds watcher 带 `immediate: true` 在 setup 阶段就跑，早于 `onMounted` 测量面板，于是开屏视图按 1000×620 占位尺寸算完后被 `updateViewportSize` 静默作废，ResizeObserver 再从这个自相矛盾的状态推出「上一个中心点」并忠实保住那个错的点，保存的视图又把偏移持久化 —— 所以逐次刷新累积（276px → 199px → 406px 出屏）。两次失败后停下来做全程打点才定位。修法是**面板测到真实尺寸前拒绝 hydration**。
  - 版本号一度三处漂移：release PR 标题写 1.0.0 而分支文件写 0.4.0（合并会打错版本，已关闭重建）；`openapi.ts` 的 `info.version` 硬编码 `0.1.0` 自首次发版起就错。现在六处版本（根/三个 workspace/manifest/lockfile）全部一致，且 `/openapi.json` 在运行时读根 manifest —— **结构上无法再漂**。
  - 间距体系：四个视图对同一问题给了四个答案（18 / 18-20 / 20-22 / **0**），设置页内容贴在面板边框上。`--panel-pad` 收为 `.panel` 默认值，新页面无法再忘记；四页共享同一条左边界（实测偏差 0px）。
  - 补齐 LICENSE (MIT)、删除三个已验证零引用的文件、修好点云导入脚本、CI 补上此前从未运行的 `lint:e2e` / `typecheck:e2e`、README 完全重写、修掉 ARCHITECTURE.md 一行在安全上主动误导的陈述。
  - 交付量：后端 **279** · 前端 **161** · E2E **17**（含 5 页 × 明暗双主题 axe 审计）。
  - **明确推到 1.1 的**：11 个 SFC 的 `lang="ts"`、MQTT 摄入背压、`prom-client` → `@prometheus-io/client`、Lanelet2 `delete="true"` 过滤、axe `incomplete` 桶的人工审阅。均已写入 README「路线与已知边界」。
