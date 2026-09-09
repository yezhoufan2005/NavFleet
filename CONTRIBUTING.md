# 贡献指南

NavFleet 是一个只读的实时车队监控平台（MQTT → 归一化 → 内存快照 → MongoDB →
REST/WebSocket → Vue）。范围严格锁定**只读监控**：不做控制下发、不做多租户。

## 仓库结构（npm workspaces monorepo）

```
navfleet/
├── package.json          # workspace 根：统一脚本 + 预提交钩子
├── packages/shared/      # @navfleet/shared —— 领域类型单一来源（前后端共用）
├── packages/fleet-core/  # @navfleet/fleet-core —— 两套前端共用的归一化与派生逻辑
├── backend/              # navfleet-backend —— Node + TS，Express/ws/mqtt/mongodb
├── frontend/             # navfleet-frontend —— v1.0.0 控制台，保留作回滚
├── frontend-next/        # navfleet-console —— v3 控制台，**默认部署的这一套**
├── e2e/                  # Playwright + axe-core（唯一不在 workspaces 里的源码树）
├── config-runtime/       # 运行时配置（车辆/编队/场景/地图资源）
└── deploy/               # Docker Compose + nginx + mosquitto + 运维文档
```

**五个 workspace，两套前端。** 1.1.0 起 compose 部署的是 `frontend-next`（compose 里的
服务名是 `web`）；`frontend` 留着是为了一条命令能回滚，见
[deploy/docs/deployment.md](deploy/docs/deployment.md) 第 9.6 节。改前端时先确认改的是哪一套 ——
两者共用 `@navfleet/fleet-core`，所以动那个包会同时影响两边。

单一根 lockfile（`package-lock.json`）。**不要**在子目录单独 `npm install`；一律在仓库根安装。

**`"*"` 只用于「根 `package.json` 已经钉住版本」的依赖。** workspace 里写 `"*"` 的意思是
「跟着根走」，前提是根真的钉了它 —— 否则 `"*"` 就是字面意思：装最新的那个。
`frontend-next` 曾有三个依赖踩中这一点（`@vue/tsconfig` / `eslint-plugin-vue` / `jsdom`），
它们只被即将退役的 `frontend` 钉着，一旦那个 workspace 下线就会在下次刷 lockfile 时
静默跳大版本 —— 其中 `jsdom` 恰好是我们刻意推迟的那个升级（#109）。加依赖时按这条自查：
**根没钉的，就在用它的 workspace 里写真实范围。**

**提交 lockfile 前请在 Linux 容器里生成。** 在 macOS（或 Windows）上跑 `npm install` 会把
本机平台的可选依赖写进 lockfile、并漏掉 Linux 的那些（npm#4828），CI 随后在 `npm ci` 阶段就红，
错误信息还指不到原因。所以：

```bash
# 依赖有增删时，在容器里重算 lockfile
docker run --rm -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm node:22-alpine \
    npm install --package-lock-only --ignore-scripts

# 只改了 engines 之类的镜像字段时，直接手改 lockfile 里对应的 workspace 条目，
# 再用同一个容器验一次即可 —— 让 npm 重算会顺带挪动一批无关的 dev 标记
docker run --rm -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm node:22-alpine \
    npm ci --ignore-scripts --dry-run
```

dependabot 的 PR 天然满足这一条（它在 Linux 上生成），所以那些 lockfile 直接合入就好，
不要在本机重算。

## 环境要求

- Node.js ≥ 22，npm ≥ 10 —— **Node 20 于 2026-04-30 EOL**，矩阵与 `engines` 已在
  2026-09-08 上调到 22（CI 跑 22 与 24，后者是当前 active LTS）
- 本地全链路还需要一个 MQTT broker（`deploy/` 的 mosquitto 或本机 broker）

## 安装与常用命令（全部在仓库根执行）

```bash
npm install                     # 安装所有 workspace 依赖

npm run lint                    # 所有 workspace + e2e 的 ESLint
npm run format:check            # Prettier 校验
npm run typecheck               # 所有 workspace + e2e 类型检查
npm test                        # 所有 workspace 单测
npm run build                   # shared → backend(tsc) → frontend(vite) → console(vite)
npm run check:map-contrast      # 地图栅格/比例尺的对比度门禁（画在 canvas 上，逃出无障碍审计）

npm run e2e                     # Playwright 端到端（自动拉起 backend + 两个 vite，
                                # 无需 MongoDB / MQTT；首次先 npx playwright install chromium）

npm run dev:backend             # 后端 dev（tsx watch）
npm run dev:console             # 新前端 dev（vite，:5273）—— 默认部署的这一套
npm run dev:frontend            # 旧前端 dev（vite，:5173）—— 已冻结，仅回滚验证用
npm run mock:mqtt               # 发布确定性演示遥测
```

一键起前后端用 `scripts/dev.sh`（默认起 v3 控制台，`--legacy` 起旧那套）。

**`npm test` 不等于 CI。** CI 跑的是各 workspace 的 `test:coverage`（带覆盖率阈值）外加
`check:map-contrast`，而根 `npm test` 两样都不含 —— 只跑 `npm test` 就交 PR，会在 CI 上
撞见本地从没见过的红。提 PR 前的完整口径见下面「提 PR 前自检」。

`npm run e2e` 使用独立端口 3199（后端）与 5299（vite dev），并且**始终自己拉起服务**、
不复用已有进程 —— 因为每次运行的登录口令是临时生成的，只有它自己启动的后端才认。
所以可以和本地 `npm run dev`（3000/5173）同时跑。若这两个端口被占，用
`E2E_BACKEND_PORT` / `E2E_FRONTEND_PORT` 覆盖。

针对单个 workspace：`npm run <script> -w <name>`，名字是 `navfleet-backend` /
`navfleet-frontend` / `navfleet-console` / `@navfleet/shared` / `@navfleet/fleet-core`。

## 分支与提交

- 每个任务开独立分支：`phase-<n><x>-<slug>`（如 `phase-6b-governance`）或 `fix/…`、`feat/…`。
- 提交信息用 **Conventional Commits**：`feat(frontend): …`、`fix(backend): …`、`build(monorepo): …`、
  `refactor`、`docs`、`test`、`ci`、`chore`。发布与 CHANGELOG 依赖这套前缀自动生成。
- 直接推送 `main` 被禁止；通过 PR 合并，CI 全绿方可合入。

## 预提交钩子

`husky` + `lint-staged`：提交时对暂存文件跑 `prettier --write`。完整门禁（lint/typecheck/test/build）在 CI 上强制。

## 提 PR 前自检

跑这一串 —— **和 CI 的命令集对齐**，注意其中的 `test:coverage` 与 `check:map-contrast`
都不在根 `npm test` 里：

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npm run check:map-contrast
for w in navfleet-backend @navfleet/fleet-core navfleet-console; do
    npm run test:coverage -w "$w" || break
done
npm test -w navfleet-frontend
npm run e2e
```

`navfleet-frontend` 是**冻结**的那一套：它照常跑 `lint` / `format:check` / `typecheck` /
`test` / `build`，唯一去掉的是**覆盖率阈值** —— 那是这里唯一一个「谁都没碰相关代码却会变红」
的门禁：一次 fleet-core 重构改变了旧前端测试走到的分支，棘轮就跳，而唯一的修法是去改一个
**全部价值就在于不被改动**的 workspace 里的测试。它也是挡着 vitest 5 的四个阈值之一，去掉
之后剩三个。

涉及运行时/部署行为的改动请本地或容器验证，并在必要时更新 `ROADMAP.md` 与相关文档。

## 共享类型

跨前后端的数据契约只在 `packages/shared/src/index.ts` 定义一次；前后端通过
`import type { … } from "@navfleet/shared"` 引用（纯类型导入，编译期擦除，不进运行时产物）。
改数据模型时改这里一处即可。

## 版本与发布

版本由 **release-please** 从约定式提交推导：合并到 `main` 后它会开一个 release PR，合并
该 PR 即打 tag、生成 `CHANGELOG.md` 条目、并触发 GHCR 镜像发布。

需要指定版本号时（例如从 0.x 进入 1.0.0），在任意一个进入本次发布范围的提交里加脚注：

```text
Release-As: 1.0.0
```

release-please 只管理**根** `package.json` 的版本。五个 workspace（`backend` / `frontend` /
`frontend-next` / `packages/shared` / `packages/fleet-core`）都是 `private: true` 且从不发布
到 npm，它们的 `version` 仅为可读性与根版本保持一致，**需要手动跟随**大版本更新。

发布出去的镜像是 `navfleet-backend` 与 `navfleet-console` 两个。`navfleet-frontend` 自 1.1.0
起不再发布、停在 1.0.x —— 部署的既然是 v3，用同一个名字推新版本会让 registry 里的标签说谎。
