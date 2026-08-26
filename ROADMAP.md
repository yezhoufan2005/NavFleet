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
- [ ] 前端 `RosSceneMap.vue`（1162 行）拆 `useSvgViewport`/`useSceneOverlay`/`useViewportPersistence`（**需 Playwright 视觉回归**）
- [ ] 抽 `formatters` 共享 util（消除 Dashboard/History 重复）；`main.css`（2091 行）拆 tokens + 模块化（**需视觉回归**）
- [ ] 所有带逻辑 SFC 逐步 `lang="ts"` + typed props（渐进）
- **收口**：`vue-tsc`/`tsc` strict 全绿、无 `any`、god-file 拆分完成

## Phase 8 — 健壮性与测试深度 ⚪ 待开始

- [ ] store 摄入串行化队列（根治 read-modify-write 竞态）
- [ ] Mongo 重连 + 真实健康探测；MQTT 摄入 zod 校验；前端 error boundary + 路由守卫
- [ ] 后端 supertest 集成测试（路由/错误中间件/404/校验）、store/WS/configRegistry/persistence 单测
- [ ] 前端组件测试 + store 测试；Playwright E2E 入库并进 CI（headless）；覆盖率门槛
- **收口**：竞态回归通过、覆盖率达阈值、E2E 在 CI 跑通

## Phase 9 — 安全硬化与可观测性生产化 ⚪ 待开始

- [ ] mosquitto 关匿名 + ACL + 后端凭据、1883 不对宿主暴露
- [ ] 强制 TLS + `COOKIE_SECURE`；WS 只用 cookie 传 token；全局限流；pino 脱敏；helmet CSP
- [ ] edge `/metrics`+`/openapi` 鉴权；docker 三网隔离 + nginx 非 root
- [ ] `prom-client` 替换手写 metrics + 请求直方图/per-route；request-id/correlation-id 贯穿日志
- [ ] compose 加 Prometheus + Grafana profile + 预置面板 + 告警规则；备份自动化 + 恢复演练
- [ ] `/api/v1` 前缀；OpenAPI 由 zod 代码生成 + Swagger UI
- **收口**：安全清单达标、Grafana 面板+告警可用、契约与实现零 drift

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
- 剩余 Phase 7：`RosSceneMap.vue`、`main.css` 结构拆分（需 Playwright 视觉回归）。
