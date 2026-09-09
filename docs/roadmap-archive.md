# 路线图归档：已完成的阶段（Phase 0–13）

> **这是历史记录，不是待办。** 尚未完成的计划见 [ROADMAP.md](../ROADMAP.md)。
>
> 归档的理由是同一条，用过两次：**当前路线图应当只讲往前走的路。** 已完成阶段的取舍依据与每一步
> 修掉的真实缺陷仍有参考价值 —— 尤其那些"看起来像功能、其实是缺陷"的条目 —— 所以原文保留，
> 只是搬出主路线图。
>
> 两次归档：
>
> | 归档时间                   | 搬进来的    | 当时的理由                                     |
> | -------------------------- | ----------- | ---------------------------------------------- |
> | 2026-08-29（v1.0.0 发布）  | Phase 0–10  | v1.0.0 是后续所有改动的起点                    |
> | 2026-09-09（1.1.0 发版前） | Phase 11–13 | 前端焕新已完成并切换上线，ROADMAP 到了 2816 行 |
>
> v1（Phase 0–5）的过程未逐阶段留档，下面从 v2（Phase 6）开始。

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

- [x] 清理遗留 phase 分支、`origin/HEAD` 指向 main —— **2026-08-29 完成**：远端 8 个分支（逐个用
      `git merge-base --is-ancestor` 复核已含于 main 后）+ 本地 41 个已合入分支全部删除，远端只剩 `main`
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

---

## v3 前端焕新（Phase 11–13）✅ 完成

> 2026-09-09 从 ROADMAP.md 搬入，共 1591 行，原文未改一字。
>
> 这三个阶段做完了一件事：把 v1.0.0 那套手搓 demo 前端，换成 `frontend-next/`（`navfleet-console`）
> 这套 TypeScript + Reka UI + Tailwind v4 的控制台，并在 Phase 14 完成切换。**14C–14I 六批人工验收
> 物理上排在 Phase 13 段落里**（它们是在 13 的收口过程中一轮轮追加的），所以一并在这里。
>
> 阅读提示：Phase 13 的 13R / 13S / 13T 三节是「人工检查回归」「收口留下的缺陷」「parity 核销查出的
> 能力损失」，是这三个阶段里信息密度最高的部分 —— 后来多条修复的判断依据都在那里。

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
- [x] e2e 契约保住了，并且**由单测显式钉住**：
      `.map-surface svg .ros-marker.fusion .ros-marker-core` 是跨 workspace 的契约（组件在这边，
      断言在 `e2e/`），此前没有任何东西说明这件事
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

- [x] **删掉各页的 lede 说明文字**（14C 已做），负责人的决定是留到 Phase 14 验收前统一清理（现在它们对逐页
      检查还有用）。**注意一处例外**：`场景` 页 lede 里那句「只读 —— 场景是车辆定位的依据，
      不由监控台改写」是产品红线，且是 `console-admin.spec.ts` 唯一断言「只读」的地方 ——
      删 lede 时要把它移到正文，不能一刀切
- [ ] 告警区整体布局再看（负责人只说"可以再看看"，没有具体诉求，留待第二轮）
- [~] **总览四张卡的改法回退重做**（13R-B 已关闭未合入）。下一版无论版面怎么改，
  **浅色警示色仍然要修** —— 那与"卡里放什么内容"是两个独立问题，只是上一版被我合在一个 PR 里
  提交，所以一起被回退了。两条测量结论留在 #115 的关闭评论与 13R-B 条目里，不必重测
  —— **警示色那半已在 14D 落地；分解明细那半待负责人定（见下）**

#### 14H — 人工验收第五轮（负责人 5 条，2026-09-08）

- [x] **编队面板：三行是量出来的，不是估出来的**。上一轮我按「限高 3 行」写成了 `max-h-52`（208px），
      而这不是任何东西的三行 —— 编队的 description 是可选的，行高因此有两种，同一个整数在不同部署里
      装下不同的行数。现在行高由 `--formation-row` 钉住（50px，实测自然行高 48.1px，**向上取整**取一个
      整像素，好让有无描述的行一样高），面板上限就是 `calc(3 * 行高 + 2 * gap)`。
      **一条都不裁**：待处理项能卡在 5 条是因为它有「查看全部设备」可以交棒，编队面板没有，
      裁掉的那条就真的到不了了 —— 这是负责人这一轮纠正我的原话。
      两个常数由 `console-overview.spec.ts` 在真实排版引擎里量（jsdom 不排版），字号动了就红。
      顺带修掉一处：负外边距原来在链接上，在 `overflow-y-auto` 的滚动盒里会横向溢出 8px，
      移到 `ul` 上（三个编队时不滚动，所以这条一直没被看见）。
- [x] **UI 文案不再出现句号**，`报码解读` 是重灾区（`reportCodes.ts` 的 `meaning`/`description`/`hint`
      共 49 处）。规则是「界面文案不是散文」：句末不加句号，句中的停顿改用逗号或分号。
      两棵源码树共改 152 处，并加了 `copy-punctuation.test.ts` 机检 —— 先剥注释再判，
      因为注释里引用验收原话是文档、不是文案，用界面的规矩去管它是在管错的东西。
- [x] **电量列左移，且不再随选中位移**。它是唯一右对齐的表头，箭头只在选中时渲染就夹在
      字名和单元格边之间，选中 电量 会把它自己的字名往左推 14px —— 这就是负责人报的位移。
      现在箭头**槽位**在每个表头恒定存在（只有字形是条件渲染），数字列吃同一份预留
      （`NUMERIC_CELL_CLASS`），所以表头与它统辖的数字仍是一条边。
      同样加了浏览器实测：点一次 电量，按钮的 `x` 与 `width` 都不许变。
- [x] **「告警待就绪」的语义按登录会话重划**。这是第四次动它，但这次动的不是措辞而是**归属**：
      armed 原来存在 `localStorage`，于是「启用过」成了**机器**的属性 —— 共用的调度终端会把
      armed 状态交给下一个坐下来的人，读数也就永远没机会向新登录的人要那一次点击。
      现在 armed 存 `sessionStorage`（刷新仍在，这是 14A 那条要求，也是前三轮的坑），
      并由 `App.vue` 在会话离开 `authenticated` 时调 `disarmAlertSound()` 清掉；
      `locked` 的标签一并改为「告警待就绪」，与 `pending` 同字不同色（前者是本次登录还没点，
      后者是点过而漏掉了一条告警级 —— 两个 tooltip 不同，所以保留两个原因码）。
      **没有把前几轮的 BUG 改回来**：同一次登录内刷新仍然直接显示「告警响应」，
      不需要再点一次。退出登录时另外三件事一起复位 —— 手势监听器（否则登录表单上的一次点击
      就把控制台重新 arm 了）、已见告警集（重新登录要像首次登录一样安静）、AudioContext（关掉，
      好让 `unlocked === false` 是字面真话）。
- [x] **仓库的 PR 与分支清理**，见下一节。

#### 仓库卫生：5 个 dependabot PR 与 21 个陈旧分支（2026-09-08）

**能合的合了，不能合的都不是"修一下测试"的事**：

| PR          | 内容                                      | CI        | 处置                         |
| ----------- | ----------------------------------------- | --------- | ---------------------------- |
| #133 → #138 | dev-dependencies 组（3 项 → 重开为 6 项） | 8/8       | #138 已合入                  |
| #134        | prod-minor-patch 组 3 项                  | 8/8       | 等 dependabot rebase 后合入  |
| #131 + #135 | vitest / @vitest/coverage-v8 5.0.0        | 各 6/8 红 | **等一个决定，不是等一次修** |
| #132        | eslint 10 + typescript-eslint             | 4/8 红    | **等 flat config 与插件**    |

- **#133 被 dependabot 自己关掉，重开为 #138**（同一组，在新 `main` 上重新解析后从 3 项变 6 项，
  多出 `tsx` / `lint-staged` / **`@playwright/test` 1.62.1 → 1.63.0**）。最后那一项正是等这次
  rebase 的理由：14H 刚加的两条 e2e 断言是**量像素**的，Chromium 换版本可能挪动字体度量，
  所以要让 CI 跑「依赖升级 + 新常数」的组合而不是旧 `main`。跑绿了，合入 `5995d6c`。
- **#131 与 #135 的结论已经变了 —— 见 14I 第 3 条：放弃 Node 20，两个一起抬。** 原始诊断如下：`@vitest/coverage-v8@5` 的 peer 是精确的
  `vitest@5.0.0`，任一单独合入都不解析 —— 这正是 `dependabot.yml` 里 `vitest` 分组要解决的问题，
  但这次 dependabot 仍拆成了两个 PR。**更要紧的是 `vitest@5` 的 `engines` 是
  `^22.12.0 || ^24.0.0 || >=26.0.0`，它不再支持 Node 20**，而 CI 矩阵与根 `engines` 都还带着 20。
  所以这不是依赖问题而是**支持面问题**：要升 vitest 5，得先决定 NavFleet 是否放弃 Node 20。
  这个决定不该由一次依赖升级顺手做掉，留给负责人。
- **#132**：eslint 10 需要 `eslint-plugin-vue` 10，而这个 PR 里 plugin-vue 仍是 `^9.33.0`，
  两个 Vue workspace 因此红；`@eslint/js` 也仍停在 9.39.5。`dependabot.yml` 的注释早就记下了
  这对组合（#110 / #108），分组让它至少能出现在一个 PR 里，但 flat config 的迁移本身仍是活。
- **分支**：12 个已并入 `main` 的本地分支已删。**21 个同样已并入的远端分支只列清单，等负责人授权** ——
  删远端分支是破坏性操作，按既有约定要逐次授权。提交都在 `main` 里、删的只是指针，但规矩是规矩。
  清单：14B / 14C / 14E / 14F、`dependabot-group-toolchains`、13S 与 13T 系列 5 个、
  `14a-acceptance-round1`、`console-admin-children` / `console-alert-history` /
  `console-history-playback`、`103-absent-is-not-zero` / `103-live-verification` /
  `parity-section9-verification`、`console-alert-sort-stability` /
  `console-dark-border-and-playback-height` / `console-review-round1-controls`、
  以及 release-please 的陈旧分支。**dependabot 自己的 5 个分支不动**：删掉会把对应的 PR 一并关掉。
  **`fix/console-review-round1-overview` 留着**：它有一个未合入的提交（2026-08-31，
  「总览卡加分解明细」），其中警示色那半已由 14D 以另一种做法落地，而**分解明细那半正是负责人
  搁置的那一项**。删掉就等于把那份草稿一起删了，所以不动它。

#### 14I — 人工验收第六轮（负责人 5 条，2026-09-08）

- [x] **电量列的数字跟着表头一起左移**。上一轮只修对了一半：箭头槽位消掉了「选中时位移」，
      但那个槽位在**表头自己的盒子里**，于是字名比它统辖的数字还靠左 14px —— 负责人报的就是这个。
      更糟的是我第一版把预留同时加在 `th` 上，等于在表头预留了**两次**（padding 加槽位）。
      现在只有值单元格吃预留（`NUMERIC_VALUE_CLASS`），表头保持 `px-3`（`NUMERIC_HEAD_CLASS`）。
      **这条只能在真实排版引擎里判**：字名与数字各自包了一层 span，`console-devices.spec.ts`
      直接比两个盒子的右边缘。**并且验证过它抓得住** —— 把 bug 放回去，测试报「差 14px」。
- [x] **远端分支清理已获授权并执行**：22 个已并入 `main` 的远端分支删除；
      `fix/console-review-round1-overview` 保留（未合入，且那一个提交里的「分解明细」正是搁置项）；
      dependabot 自己的分支不动。
- [x] **vitest 5 与 Node 20：放弃 Node 20**（负责人授权我自行决定）。理由不是为了升 vitest ——
      **Node 20 已于 2026-04-30 EOL**，四个月来没有安全补丁。所以这不是「为了新版测试框架抬门槛」，
      而是我们本来就该做的事，vitest 5 的 `engines`（`^22.12.0 || ^24.0.0 || >=26.0.0`）
      只是把它顶到了眼前。分三步走，因为三步的风险完全不同 —— 见下面三条。
- [x] **第一步（开发侧，本 PR）**：CI 矩阵 `[20, 22]` → `[22, 24]`、六处 `engines` 改 `>=22`、
      lockfile 里六个 workspace 条目的 `engines` 镜像同步。不动任何交付物。
      顺带解锁了两件之前明确「等 node 20 EOL 再说」的事：jsdom 26 → 30（#109 只在 node 20 红）
      与 vitest 的大版本。
- [~] **第二步（测试框架）—— 试过了，四套单测零改动全过，但覆盖率门禁四个一起红，
  决定推迟到旧前端下线之后**。实测数字与原因见本节后面的「vitest 5 的覆盖率口径」。
  **2026-09-09 更新：14L 去掉了冻结 workspace 的覆盖率阈值，所以现在要重标的是三个
  （backend / fleet-core / console），旧前端那一档不再进这笔账。**
- [x] **第三步（交付侧）**：三个 Dockerfile 的 `node:20-alpine` → `node:24-alpine`，
      交付镜像不再跑在 EOL 运行时上。三个镜像都在本机重建通过，backend 运行时确认
      `v24.20.0`；后端单容器烟测 `/health` `/health/ready` `/metrics` 200、
      `/api/fleet/snapshot` 401（未登录的正确答案）、9 个 1.0.3 新增的队列与设备指标都在。
      **完整 compose 闭环没能跑完，原因写在下面两条 —— 都不是这次改动引入的，但都是交付面的真问题。**
- [x] **`frontend-next` 三个浮动依赖钉住**（负责人指着 `tsconfig.json` 的 `@vue/tsconfig`
      那一行说「路径有问题」，查下来是另一件事，但确实是问题）。这三个在 `frontend-next`
      里写的是 `"*"`，而 `"*"` 的前提是「根钉了它」—— 根没钉，钉它们的是**即将退役的
      `frontend`**：`@vue/tsconfig` ^0.9.1、`eslint-plugin-vue` ^9.33.0、`jsdom` ^26.1.0。
      也就是说 Phase 14 一旦把旧前端下线，这三个会在下次刷 lockfile 时静默跳大版本 ——
      编译基线、Vue 的 lint 规则、全部单测的 DOM 实现各跳一次，而 `jsdom` 恰好是我们
      刻意推迟的那个升级（#109）。改成真实范围，并在 CONTRIBUTING 写下这条自查。
      **顺带说明那个「路径有问题」**：`@vue/tsconfig/tsconfig.dom.json` 本身解析正常
      （`tsc --showConfig` 通、CI 的 vue-tsc 两档全绿），IDE 报红是因为我在同一时段用容器
      跑 `npm ci` 时它先删了本机 `node_modules`，TS server 在那个窗口里缓存了「文件不存在」。
- [x] **总览四张卡与前端主题**：负责人改口径为「**后续工作完成后再做**」，不是不做。
      见下一节的两条，状态从「搁置」改为「排在切换与发版之后」。
- [x] **前端切换继续等**：Phase 14 的 compose 切换、旧前端下线、改名、P0-f、1.1.0
      都等负责人发话，我不自行启动。

##### 容器闭环里撞出来的两件事（2026-09-08）

**一、`mongo:8.0` 在 Linux 内核 6.19–7.0.13 上起不来。** 这不是我们的配置问题，是 MongoDB 8
自带的 TCMalloc 与这一段内核冲突（SERVER-121912），`mongod` 启动即崩、循环重启。本机
Docker Desktop 的虚拟机内核是 `7.0.12-linuxkit`，正好落在区间里。官方解法是把内核升到
**7.0.14 或更高**。要紧的是它的下游效应：compose 里 `backend` 对 `mongo` 是
`condition: service_healthy`，所以 mongo 起不来时后端根本不会启动，症状是「整栈只有 nginx
和前端在跑」，而错误信息里没有一个字提到 Docker 或 NavFleet。已写进 `deployment.md` 的
「3.1 宿主内核」，因为**任何用了较新内核的客户都会撞上**。

**二、compose 的 mosquitto 与一个长期在跑的联调 broker 抢 1883。** 这台机器上有一个不属于
compose 项目的 `navfleet-review-broker`（`eclipse-mosquitto:2`，已跑 8 天）占着宿主 1883；
而 compose 的 mosquitto 声明了 `ports: 1883`，于是永远起不来，报错只说端口被占、不说被谁占。
**这里我改动了负责人的环境状态并且没能完全复原**：原先在跑的那个 compose mosquitto 容器是
「没有发布宿主端口」的形态，我 `up -d` 时按当前 compose 文件把它重建了，于是它再也起不来 ——
现在留在 `Created` 状态。要恢复，二选一：停掉 `navfleet-review-broker`，或按第 10 节把
mosquitto 的 `ports` 段删掉（容器间走 `bus` 网络，不需要宿主端口）。这属于负责人的环境决定，
我没有替他停那个跑了 8 天的容器。排障步骤已写进 `deployment.md` 的常见问题。

##### vitest 5 的覆盖率口径（2026-09-08 实测）

`vitest` 与 `@vitest/coverage-v8` 一起抬到 5.0.0，lockfile 在 Linux 容器里重算，四套单测
**零改动全过**（104 / 300 / 132 / 548）—— 框架本身没问题。红的是覆盖率门禁，四个 workspace
同时红：

| workspace  | vitest 3 实测（门禁）             | vitest 5 实测                     |
| ---------- | --------------------------------- | --------------------------------- |
| backend    | 82.1 / 81.4 / 84.8（80/79/82/80） | 83.49 / **70.78** / 83.74 / 83.87 |
| fleet-core | 93.09 / 86.39 / 91.37（89/83/89） | 97.04 / **79.89** / 89.18 / 97.14 |
| frontend   | 过 57/84/81 的门禁                | **42.70 / 32.94 / 42.13**         |
| console    | 96.17 / 86.26 / 90.36（94/85/90） | 91.96 / **82.47** / 90.86 / 94.18 |

最可能的机制（未经上游确认，只报实测）：vitest 3 对**没被任何测试 import 过**的文件给的是
「无可测量即 100%」，vitest 5 改成按静态分析给真实的 0% —— 所以 statements 常常上升而
branches 大幅下降。fleet-core 那一档能对上账：`src/index.ts` 是九行 `export * from` 的纯
barrel，vitest 3 记它 0% statements / 100% branches，vitest 5 不再计它，于是 statements
93 → 97、branches 86 → 80。**也就是说我们的 branches 门禁此前有一部分是被这个假象撑着的**，
这本身比升级值钱。

**推迟的理由是顺序而不是难度**：要升就得同时把四个门禁的 16 个数字往下调，而其中最难看的
一档（frontend 的 branches 84 → 31）属于**即将退役的 workspace**。等 Phase 14 把旧前端下线后
再做，只需要重标三个 gate，那一档自己就消失了 —— 把「改动项目主要质量棘轮」这件事塞进一次
依赖升级里，是它最不该出现的地方。

顺带记下：vitest 5 下 `backend` 与 `fleet-core` 的 `vitest.config.ts` 会报
`configLoader: 'native'` 警告（ESM 语法的文件被当 CJS 加载），届时一起改成 `.mts`。

#### 14F/14G — 人工验收第三、四轮（负责人 11 条，2026-09-06 / 09-08）

- [x] **声音读数改成「预报」，这是第三次改它，也是唯一一次真正解决**。前两轮都栽在同一个事实上：
      浏览器不允许**未被交互过的文档**出声，刷新后 `AudioContext` 必定是 suspended，存什么都改不了。
      14A 报「未启用」被读成设置丢了；14E 报「待就绪」被读成同一件事。**问题不在措辞，在于报告一个
      每次刷新都成立、而几乎从不真的造成后果的状态。**
      现在 armed 状态直接报「告警响应」，并让它成为一个**可被推翻的预报**：任意交互静默恢复；
      而如果告警级消息真的在获得交互之前到达，`announce` 立刻置 `missedForGesture` ——
      读数当场变「告警待就绪」+ 警示色，`App.vue` 同时弹一条可见提示。
      **听不到的告警至少不会同时是看不到的**，而控制台只在被证伪的那一刻才收回它的声明。
      唯一真解决不了的是「开机加载、几小时无人触碰」的值班大屏 —— 那是部署问题，
      `deployment.md` 补了 `--autoplay-policy=no-user-gesture-required` 的说明。
      顺带修掉 14E 留下的两处：点击语义原来看**标签**（乐观标签下会去静音一个还没响过的东西），
      改为看 `unlocked`；音量图标抽成 `UiSoundIcon`（顶栏按钮左侧随音量显示 1/2/3 道弧，
      静音/未就绪显示叉），会话菜单的「静音」行也补上图标。
- [x] **总览**：`数据 × 秒前更新`（整句由 computed 给出，否则「数据 尚无数据 更新」）、
      活跃告警 → 活跃消息、去掉「其中」、GPS覆盖、编队 → 设备编队。
      编队面板按**在线数降序 → 总数降序 → 名称**排，并限高 3 行可滑动 ——
      store 的顺序是 `formationId`，那是标识符，用它排一个给人看的清单等于按数据库的口味排。
- [x] **设备页**：排序箭头统一在字段名右侧（电量原来靠 `flex-row-reverse` 翻到左边，
      六个箭头里有一个在另一侧，整排表头就读成了两种控件）。
- [x] **下拉框**：「全部编队 / 全部设备」置顶，其余按**名称**排。置顶的理由不是审美 ——
      它不是同类项，是退出筛选的出口，一个位置会随排序漂移的出口没人敢用。
- [x] **标点**：单句 UI 文案不加句末句号；含多句时句间用句号、末句仍不加。
      已按此改三处（自动视图提示、离线告警 detail 的三份副本、回放已载入行）。
- [x] **小屏适配，实测而非猜**：390px 下六个页面**每一页横向溢出 87px**，同一个数说明问题在外壳。
      量出来是顶栏子元素合计 477px：产品名 120 + 会话菜单 159 是大头。产品名在 `sm` 以下改
      `sr-only`（它是文档的 `h1`，只能视觉隐藏、不能删），会话菜单的用户名与角色 `sm` 以下隐藏
      （菜单第一行本来就写着「已登录：xxx · 角色」）。改后六页溢出全部归零。
      顺带把「显示已确认」复选框的目标提到 24px（WCAG 2.5.8，实测 13×13）。

#### 14 后续的两项，排在切换与发版之后（负责人 2026-09-08 定的口径）

- [ ] **总览上部四张信息卡的内容与版面**。14D 只解决了警示色该由谁承担；「卡里放什么」仍未定。
      13R-B 原方案（在线卡列离线车名、告警卡分三档、编队卡列成员）会与页面上已有的
      待处理项 / 消息摘要 / 编队情况三个区块重复，这一点已核实并报给负责人。
- [ ] **前端主题样式**（承接 P2）。两项都**要做**，只是排在 Phase 14 的切换与 1.1.0 发版之后
      —— 负责人 14I 的原话是「完成后续工作后再完成」，不是取消。

#### 14E — 人工验收第二轮（负责人 6 条，2026-09-04）

> 全部落在 `frontend-next`，`chore(console)`。**第 3 条的四张卡样式与第 6 条的管理页拆分不在本批**：
> 前者负责人说「我设计后告诉你」，后者是问我的判断，分析见下。

- [x] **1 · 顶栏与会话菜单**。文案：声音已启用 → 告警响应、已静音 → 告警静音、声音待就绪 → 告警待就绪，
      并把 `声音未启用` 一并改成 `告警未启用`（未在清单里，但留着它会让四个读数里三个叫「告警」、
      一个叫「声音」）。待就绪拿到与未启用相同的**警示色**：这两个状态的含义都是「真出事了也不会响」，
      而静音与免打扰是人自己选的，选择不该被涂成警示色。
      **待就绪的 BUG 是真的，而且原因不是浏览器**：这段代码从来没有*尝试*过 resume，只是挂上手势监听
      等着。而手势并非总是必需 —— Chrome 对常用站点、以及仍有 sticky activation 的文档都允许直接
      启动 `AudioContext`。「没问就报告在等点击」和「报告一个没人量过的值」是同一个错误。现在**先问，
      被拒了才退回等手势**；真被拒时 待就绪 就是事实，无法工程掉，所以它才要穿警示色。
      免打扰独立成区（关闭 / 全天 / 夜间 22:00–08:00，夜间窗口 07:00 → 08:00），
      与告警声音分开两段：声音回答「多大声、现在开着吗」，免打扰回答「什么时候一律不响」；
      合成一段会读成五个平级设置，而且两个「关闭 / 静音」挨在一起像同一个开关写了两遍。
      标题去掉「（仅告警级）」，音量 响 → 重。
- [x] **2 · 侧栏收起时图标上移**。行是 flex box，高度取决于当时最高的子元素：展开时是文字的 24px 行盒
      （`--text-md` 15px × 1.6），收起时是 20px 图标。配 `py-2` 就是 40px 对 36px，而行是堆叠的，
      于是每个图标都比上一个再上移 4px —— 「不流畅的上移视觉」正是累积偏移的样子。修的是**行**
      （`min-h-10`）而不是给图标加上距：让两种模式**由构造相等**，而不是靠一个补偿量，后者会在将来
      改图标尺寸时被悄悄推翻。`console-shell.spec.ts` 在真实布局引擎里量两次，并验过去掉修复会红。
- [x] **3 · 总览文案**（四张卡的样式待负责人设计）：需要处理 → 待处理项且只显 5 条、
      告警摘要 → 消息摘要、告警中心 → 查看全部消息、编队 → 编队情况。
- [x] **4 · 设备页**。默认排序改回**编号**升序 —— 14C 把它改成「状态」，理由是监控列表该开在出事的车上；
      这次退回是对的，因为回答「谁需要我」的页面不是它，是**总览的待处理项**（按紧急度、上限 5）。
      设备列表是**名册**，而一个会随车辆出故障重排的名册是没法保持位置的。「状态」一次点击就到。
      每列三态：升 → 降 → **关（回默认）**。两态无法表达「别再按这一列排了」，一列点过之后就只能被替换、
      不能撤销。自动阈值 40 → **10**（负责人决定，不是 Phase 11 量出来的那个数，两处都记了）。
      GPS 旁的「场景」→「ROS」：两张图都在显示场景，区别是坐标系。
- [x] **5 · 消息页**。告警 → 消息（导航项、路由 meta、页标题、面包屑；**URL 仍是 `/alerts`** —— 链接是
      会被互相粘贴的东西，改栏目名不是打断已经在流通的链接的理由）。搜索 placeholder 改成
      `标题/详情/设备/来源`。确认按钮的 hover 原来只换文字颜色 —— 12px 标签上的 muted→ink 只占控件面积
      的几个百分点，所以现在连边框和底色一起动。「确认状态只保存…」那行**修剪而非删除**：事实必须留下
      （确认了二十条、同事一条都看不到，这个沉默会误导人），删掉的是写给我们自己看的那半 ——
      「不入库、不记录操作人与时间」是同一件事的实现措辞，「落库与历史留到 Phase 16」是路线图批注。

##### 顺带查出并修掉的两处（不在清单里）

- **GPS 地图不显示**：不是代码缺陷，是本机缺 `frontend-next/.env` —— 高德的两个变量只存在于旧前端的
  `frontend/.env`，所以 `hasAmapConfig()` 为假、面板显示的是「未配置」提示。已按 `.env.example` 生成
  该文件（值从未进入终端输出，文件已被 gitignore 覆盖），地图随即正常渲染。
  **部署侧不受影响**：`frontend-next/Dockerfile` 早就接了同名 ARG，compose 只需在切换时把 service 指过去。
  顺手修掉一处**依赖环境的测试**：那条「无凭据时显示提示」的用例原来靠「本机没有 .env」成立，我一建文件
  它就红了 —— 一个结果取决于 gitignore 文件的测试报告的是开发者的机器，现在改为 stub。
- **设备页的地图只占页面三分之一**。地图用 `flex min-h-0 flex-1` 去抢空间，而父级**没有高度**：
  `h-full` 一直绑在 `scrollContent` 上，而设备页不能要那个滚动容器。于是地图退回自身固有高度 ——
  实测 **852px 的 `main` 里只有 279px（33%）**，下面空着 570px。而这一页存在的理由就是让地图成为页面
  主体：ROADMAP 批评 v1.0.0 把场景图缩在「约 40% 视口」，这里是 33%。`PageHeader` 新增 `fillHeight`
  （只要高度、不要滚动容器），279 → 775px。e2e 量比例并验过去掉修复会红。

#### 14D — 统计卡的警示色改由色块承担（2026-09-02）

大数字两个主题都回 `text-ink`，卡片拿到 4px 内嵌色边 + 一个满饱和圆点，与 `DevicesView`
给 critical / warning 行的处理同一套视觉语言。规则就是本项目图表已经在守的那条：
**文字穿文字色，状态交给旁边一个饱和的标记。**

一处自己踩出来的坑，记在代码注释里：第一版照搬设备行的 60% wash，而卡片面积是行的二十倍 ——
深色下 `warning-wash` 是 `amber-900`（L≈0.28），60% 混上去成了一片橄榄褐，**正是这次要修的
「色相读不出来」在另一个主题里重现**。所以浅色 22%、深色 0%：两个主题的 wash token 在明度
两端，一个百分比服务不了两边；色边与圆点在两边都是满饱和。这条不对称写成了断言。

**分解明细那半没做，因为它会造重复。** 13R-B 想让在线卡列离线车名、告警卡分三档严重度、
编队卡列成员 —— 但这一页现在已经有「需要处理」（离线车就在里面）、「告警摘要」（正是三档计数）
和「编队」三个区块。照原样做等于在同一屏上把三件事各说两遍。真正**没有任何地方显示**的只有
一条：哪几台没有定位。三个选项已提给负责人：(a) 卡片保持摘要，只补 GPS 那条真缺的；
(b) 把明细全收进卡片、删掉下面重复的区块；(c) 另有想法。

- [x] **设备列表允许自定义排序**（14C 已做）。现在排序是 store 里硬编码的 deviceId 升序、
      用户不可改 —— `frontend-parity.md` 第 0 节记过 v1.0.0 同样如此。要先定三件事再动手：
      哪些列可排、是否支持多列、排序状态要不要进 URL（告警中心的筛选进了 URL，两处应当一致）
- [x] **点击记录行在行下方展开设备信息卡**（14C 已做），而不是直接跳转设备详情。与上一条同属设备列表的一次
      改造，放同一个 PR 更合理

#### 14C — lede 清理 + 设备列表排序与展开（2026-09-02）

**lede**：9 处里删 6、移 1、留 2。留的两处是 lede 里那句话**本身就是内容**的：404 的解释，
和设备详情的「编号 xxx」。移的是场景页 —— 红线不能删，但它不是"这一页是什么"的描述，所以进正文，
放在三个状态分支之前（loading / 空 / 有数据都要能看到）。`console-admin.spec.ts` 断言的
`getByText("只读")` 照旧通过，已单跑验证。

删掉的理由值得记一句：一个每班开两次「设备」页的人，那行字读零遍，却在每一页content 上方
永久占一条竖向空间。

**排序**：六列全可排，单列 + 固定 tiebreaker（deviceId），状态进 URL（`?sort=soc&dir=desc`）。
三个决定各有依据：

- **默认改成「状态」**（原来是 deviceId 升序）。`DevicesView` 那句注释一直写着「Sorted
  worst-first, so the row that needs attention is the one you land on」，而 `filteredDevices`
  实际按 deviceId 排 —— worst-first 是另一个 computed（`devicesByAttention`），只有总览和大屏
  在用。**意图写下来了，列表没做。** 现在列变成控件，默认就是那个意图。
- **每列首点都是升序**，而这在每一列上恰好都是点它要问的问题：状态=最糟先、电量=最空先、
  最近上报=最旧先、名称/编号/场景=A→Z。最后一列不合表格惯例（多数默认最新先），但健康车队
  1Hz 同步上报，最新先等于按毫秒噪声排序、每 tick 翻一遍；最旧先才把"谁不说话了"顶上来。
- **缺失值两个方向都排最后**。没有电量读数的车不是 0%，stamp 解析不出的车不是 1970 年 ——
  当成极值会把空洞顶到某一端，正是 1.0.3 刚从三处删掉的那类谎。反转排序不该把空洞提到第一行。
- 不进 `localStorage`（布局偏好进了）：布局是一个人的工作习惯，排序是他此刻在问的问题。

**展开**：点行展开信息卡，允许同时展开多行（对比两台车是真实需求）。卡里放的是"把状态点变成一句话"
的字段（控制模式 / 挡位 / 速度 / 任务 / 位置 / 编队 / 告警前 3 条），**不是设备详情的副本** ——
详情页答"把这台车全告诉我"，这里答"第三行是黄的，它怎么了"。其余的一个链接过去。
可达性：chevron 是真 `<button>`（`aria-expanded` + `aria-controls`），`<tr>` 上的 click 只是鼠标
便利；设备链接 `@click.stop`，否则"点行展开"会把"点链接进详情"也变成展开。
展开集合按在场设备剪枝，理由与轨迹映射同一条：不剪就会随标签页寿命一直长。

自检：console 518 → 528（新增 10），e2e **75/75**（真后端跑通），typecheck / lint / format 全过，
首屏预算 341.9 KiB raw / 128.3 KiB gzip 仍在 420 / 160 之下。两条最容易写成"在缺陷上也绿"的用例
逐个验过：去掉链接的 `.stop` 后「点链接不展开」变红，把缺失电量当 0 后「空值排最后」变红。

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

- [x] **13T-E（一半）/ 1.0.3（另一半，已完成）`dataDefaults` 的两个永久空常量**（第 8.7 节）。
      `sceneCatalog = {}` 与 `fallbackFleetPayload.devices = []` 被原样照抄，**两个前端合计五处查表
      从未命中过一次** —— 也就是说「后端不可达时有可视内容」这个承诺从 v1.0.0 起就没有实现过。
      **结论：删掉这条路径**（决策 2），离线走明确空态 + 重试按钮。监控系统里显示假数据比显示空白
      危险得多 —— 而灌进去的零台设备不只是「没内容」，它是一句**更惊人且为假**的话（「所有车都没了」）。
      13T-E 做了 console 那半（只播种两个标签字段、不动设备表，所以重连是并入最后已知状态）；
      1.0.3 删掉常量本身 + 修掉 v1.0.0 那半（它当时仍在 ingest 空载荷），`sceneCatalog` 整体删除，
      五处查表清掉，`FallbackFleetPayload` 收敛成 `FleetLabelDefaults`（只剩确实有值的两个字段）
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
