# NavFleet 升级路线图（v2：工程产品级）

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

## Phase 7 — 类型安全与架构重构 🟢 进行中

- [x] 后端 `index.ts`（548→~115 行）拆 `app.ts` + `routes/*`（ops/fleet/scenes/debug）+ `websocket.ts` + `mqtt.ts` + `metrics.ts` + `logger.ts` + `runtimeState.ts`（PR #28，7B）
- [x] 后端 config → zod 校验 + fail-fast（消灭静默兜底），`parseConfig` 单测（PR #27，7A）
- [x] 前端标准 util 全部 .js→.ts：`amap`/`data-defaults`/`point-cloud`（PR #29，7C）、`fleetNormalize`（457 行核心，PR #32）
- [x] `fleet.ts` 去 `Record<string,any>`（用 `@navfleet/shared` 类型 + `unknown` 收窄），前端 `no-explicit-any` 由 off→**error**（PR #33）——至此前端 `src` 下**无显式 `any`**
- [x] 前端 `RosSceneMap.vue`（1162→592 行）拆 `useSvgViewport`/`useSceneOverlay`/`useSceneViewportPersistence`（PR #35；jsdom 10 场景逐字节等价 + Playwright 明暗实测）
- [x] `main.css`（2091 行）拆 19 个 partial + 按级联顺序 `@import`（PR #37）——构建产物 CSS **逐字节一致**（Vite 内容哈希未变），级联零风险
- [ ] 抽 `formatters` 共享 util（消除 Dashboard/History 重复）
- [ ] 所有带逻辑 SFC 逐步 `lang="ts"` + typed props（渐进）
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

## Phase 9 — 安全硬化与可观测性生产化 🟢 进行中

- [x] `prom-client` 替换手写 metrics + per-route 请求直方图；request-id 贯穿日志与 500 响应（#47，9A）
- [x] 全局限流 + `trust proxy`（修「整个部署共用一个限流额度」）、pino 脱敏落到全部子系统 logger、显式 CSP、生产配置审计 fail-fast、WS 只用 cookie 传 token（#48，9B）
- [x] mosquitto 关匿名 + 双向 ACL + 1883 改绑 127.0.0.1；docker 三网分段；两个 nginx 非 root；edge 下线 `/metrics`、`/openapi.json` 移到鉴权后（#49，9C）
- [x] TLS 叠加编排（HSTS / 308 跳转 / `COOKIE_SECURE` 硬编码 true / 路由表单一来源 `locations.conf`）+ 自签名证书脚本（#50，9D）
- [ ] compose 加 Prometheus + Grafana profile + 预置面板 + 告警规则；备份自动化 + 恢复演练（9E）
- [ ] `/api/v1` 前缀；OpenAPI 由 zod 代码生成 + Swagger UI（9F）
- **收口**：安全清单达标、Grafana 面板+告警可用、契约与实现零 drift
- 自检 ✅（2026-08-27，9A–9D）：`typecheck`/`lint`/`format:check`/`build` 全过 · 测试 212 → **260**（前端 115 不变）· `e2e` 11/11 · 后端覆盖率 82.4/81.9/85.0/82.4（ratchet 提到 80/79/82/80）· compose 基础与 TLS 两种编排均实跑通过（五容器 healthy）。

## Phase 10 — 产品体验打磨 ⚪ 待开始（i18n 本轮排除）

- [ ] a11y 修复（LoginForm 无 aria、focus 管理、skip-link）、骨架屏、404/设置页
- [ ] `useHistoryPlayback` composable、告警中心增强、GpsMap deep-watch 优化/列表虚拟化
- **收口**：Lighthouse a11y 达标、大规模车队渲染无卡顿

---

## 变更日志（本路线图执行记录）

- 2026-08-26：完成三路架构审计（后端/前端/DevOps），生成 v2 路线图，启动 Phase 6 / PR 6A。
- 2026-08-26：PR 6A（monorepo+shared 类型，#1）、PR 6B（治理+预提交，#3）已合并入 main；修复 npm#4828 跨平台 lockfile 陷阱（见记忆 navfleet-ci-lockfile）。
- 2026-08-26：PR 6C —— Docker workspace 化（本地 compose build 通过）+ release-please + GHCR 镜像发布。
- 2026-08-26：PR 6D（#17）—— CI 覆盖率上报 + Node 20/22 矩阵 + 文档漂移修复；release-please 首次发布 **v0.2.0**。Phase 6 收口。
- 2026-08-26：依赖现代化（自做 bump 取代 dependabot PR）—— vue-tsc 3 / lint-staged 17 / vite 8 / @vitejs/plugin-vue 6 / pino 10 / **express 5** / **mongodb 7**，均含运行时/连库冒烟验证；TypeScript 7 因 breaking 暂缓。
- 2026-08-26：Phase 7A（#27 config zod fail-fast）、7B（#28 index.ts 拆分）、7C（#29 utils→TS）合并。
- 2026-08-26：fix(mock)（#30）—— demo 发布器 PID 文件单实例守卫，修复电量每秒在 0/演示值间跳动（根因：两个发布器并发）。
- 2026-08-26：Phase 7D —— fleetNormalize→TS（#32）、store 去 `any` + 开启 `no-explicit-any`（#33）。前端 `src` 无显式 `any`。
- 剩余 Phase 7：抽 `formatters` 共享 util、带逻辑 SFC 渐进 `lang="ts"`。
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
- 剩余 Phase 9：9E（Prometheus + Grafana profile + 面板/告警 + 备份自动化与恢复演练）、9F（`/api/v1` + OpenAPI 由 zod 生成 + Swagger UI）。
