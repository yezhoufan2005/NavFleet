# NavFleet

智能车队监控平台：MQTT 上报 → 后端归一化与消息派生 → MongoDB 时序存储 → REST / WebSocket → Vue 控制台。

## 先读

- 房规：@docs/conventions.md
- 术语：@docs/glossary.md
- 流程与命令：`CONTRIBUTING.md`；架构：`ARCHITECTURE.md`；现状与计划：`ROADMAP.md`

## 红线

- **只读监控**：不向设备下发任何控制指令。经 admin API 写 `config-runtime/*.json` 是运维配置，不算下发。
- **单实例内网**：不做多租户、水平扩展、Redis pub-sub。

## 仓库

npm workspaces，单一根 lockfile，一律在仓库根安装（`npm ci`）。

- `packages/shared`（`@navfleet/shared`）：类型、契约与前后端共用的纯逻辑
- `backend`（`navfleet-backend`）：Express 5 + ws + mqtt + MongoDB；`backend/sim` 是演示模拟器
- `frontend-next`（`navfleet-console`）：部署的 Vue 3 控制台；`frontend` 是冻结的旧控制台，正在移除
- `packages/fleet-core`：控制台的无框架逻辑，正在并入控制台
- `e2e`（Playwright + axe）、`config-runtime`（运行期配置与示范车队）、`deploy`（Compose、nginx、运维文档）、`scripts`

## 验证

- 交 PR 前跑和 CI 一致的那串命令（见 `CONTRIBUTING.md`「提 PR 前自检」）。根 `npm test` 不等于 CI：
  它不跑 `test:coverage`、`check:map-contrast`、`check:deploy`、`check:markers`。
- 整栈验收：`scripts/verify-stack.sh`（`--down` 停栈保留卷；`--purge` 删卷，执行前先问负责人）。
- 界面走查用 Playwright，只在负责人要求时做。视觉与版式改动先给方案、确认后再做。

## 工作方式

- 一个改动一个分支（`feat/…`、`fix/…`、`docs/…`），提交按 conventions §10。本地自检与 CI 全绿后 `--no-ff` 合入 main，
  合并后删分支。release-please 的 release PR 与发版由负责人操作。
- 仓库公开：未修复缺陷的利用细节不写进 issue、PR、ROADMAP；断言与脚本里不写口令字面量。
- 不回显 `.env` 与凭据的值，只引用键名。
- 依赖有增删时，lockfile 在 Linux 容器里生成（命令见 `CONTRIBUTING.md`），不在 macOS 上 `npm install`。
- 默认用中文和负责人交流。
