# 贡献指南

NavFleet 是一个只读的实时车队监控平台（MQTT → 归一化 → 内存快照 → MongoDB →
REST/WebSocket → Vue）。范围严格锁定**只读监控**：不做控制下发、不做多租户。

## 仓库结构（npm workspaces monorepo）

```
navfleet/
├── package.json          # workspace 根：统一脚本 + 预提交钩子
├── packages/shared/      # @navfleet/shared —— 领域类型单一来源（前后端共用）
├── backend/              # navfleet-backend —— Node + TS，Express/ws/mqtt/mongodb
├── frontend/             # navfleet-frontend —— Vue 3 + Vite + Pinia
├── config-runtime/       # 运行时配置（车辆/编队/场景/地图资源）
└── deploy/               # Docker Compose + nginx + mosquitto + 运维文档
```

单一根 lockfile（`package-lock.json`）。**不要**在子目录单独 `npm install`；一律在仓库根安装。

## 环境要求

- Node.js ≥ 20，npm ≥ 10
- 本地全链路还需要一个 MQTT broker（`deploy/` 的 mosquitto 或本机 broker）

## 安装与常用命令（全部在仓库根执行）

```bash
npm install                     # 安装所有 workspace 依赖

npm run lint                    # 所有 workspace 的 ESLint
npm run format:check            # Prettier 校验
npm run typecheck               # shared / backend / frontend 类型检查
npm test                        # 所有 workspace 单测
npm run build                   # shared → backend(tsc) → frontend(vite)

npm run dev:backend             # 后端 dev（tsx watch）
npm run dev:frontend            # 前端 dev（vite）
npm run mock:mqtt               # 发布确定性演示遥测
```

针对单个 workspace：`npm run <script> -w navfleet-backend`（或 `navfleet-frontend` / `@navfleet/shared`）。

## 分支与提交

- 每个任务开独立分支：`phase-<n><x>-<slug>`（如 `phase-6b-governance`）或 `fix/…`、`feat/…`。
- 提交信息用 **Conventional Commits**：`feat(frontend): …`、`fix(backend): …`、`build(monorepo): …`、
  `refactor`、`docs`、`test`、`ci`、`chore`。发布与 CHANGELOG 依赖这套前缀自动生成。
- 直接推送 `main` 被禁止；通过 PR 合并，CI 全绿方可合入。

## 预提交钩子

`husky` + `lint-staged`：提交时对暂存文件跑 `prettier --write`。完整门禁（lint/typecheck/test/build）在 CI 上强制。

## 提 PR 前自检

`npm run lint && npm run format:check && npm run typecheck && npm test && npm run build` 全绿；
涉及运行时/部署行为的改动请本地或容器验证，并在必要时更新 `ROADMAP.md` 与相关文档。

## 共享类型

跨前后端的数据契约只在 `packages/shared/src/index.ts` 定义一次；前后端通过
`import type { … } from "@navfleet/shared"` 引用（纯类型导入，编译期擦除，不进运行时产物）。
改数据模型时改这里一处即可。
