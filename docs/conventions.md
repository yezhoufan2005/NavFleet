# NavFleet 开发规范

> 本文是项目的「房规」——描述**现状里占主导的写法**，新代码向它看齐；发现与本文冲突的旧代码，
> 顺手改过来而不是复制它。目的只有一个：保持统一、可靠、可预期的风格。`CONTRIBUTING.md` 讲流程，
> 本文讲**代码本身**。

两条不变的红线贯穿所有规则：**只读监控**（无控制下发）、**单实例内网**（无多租户 / 无水平扩展）。

**项目按整体呈现，不按开发阶段。** 文档、注释、提交说明都描述"现在是什么、为什么这样"，不要用
「Phase 几 / P 几」这类阶段编号来标记内容或当历史线索；需要讲来由时讲清事实本身，而不是指向某个阶段。

---

## 1. 注释语言

- **英文写「为什么」，中文只用于 UI 术语与用户可见文案的引用。** 这是全仓主导约定。
- 例外：`backend/src/reports/*.ts` 与 `packages/shared/src/notify.ts`、`reports.ts` 的块注释整体用中文——
  这些文件成文即如此，保持一致即可。**真正要避免的是在同一文件/同一句里中英混用**。
- 不写复述代码的注释；注释解释意图、权衡、踩过的坑，而不是翻译下一行。
- 不留代码生成痕迹（`PLACEHOLDER_*` / `CHUNK_*` 之类）。
- 注释是会过期的事实：改代码时同步改注释；不把"当前下载量""几天前发布"这类时效信息钉进注释。

## 2. 术语（房规词表）

- `消息` 是大类；`告警`=critical 一档、`预警`=warning、`提示`=notice。**不要用「告警」当大类名**，
  也不要在某个面板把 critical 写成「严重」。
- 严重度的标签、徽章 class、渠道标签只有一个来源：前端 `src/lib/severity.ts`
  （`SEVERITY_LABELS` / `SEVERITY_BADGE` / `CODE_CHANNEL_LABELS`）。需要时从这里取，不要再就地写一份。

## 3. 前端（Vue 3 `<script setup>` + Pinia + Tailwind）

- **Props：响应式解构带内联默认**——`const { a, b = 默认 } = defineProps<{…}>()`。不用
  `const props = defineProps(...)`，也不用 `withDefaults`。
- **Emits：具名元组**——`defineEmits<{ "update:x": [T] }>()`。不用旧调用签名 `(e: "x", v: T): void`。
- **组合式**：`use*` 前缀、`export const useX = () => …`；**文件名与主导出同名**（`useMinWidth.ts` 导出
  `useMinWidth`）。
- **异步取数防竞态**：用 `requestId` 守卫（取前自增、await 后比对、卸载时 +1 丢弃在途），或直接用已封装的
  组合式。慢响应绝不能覆盖新筛选；卸载后的回调/定时器要清理（`onBeforeUnmount`）。
- **分页**：统一用 `useListPagination`（分页随 URL、筛选变更保留密度而页码归 1、列表缩短自动夹取）。
  不要再手写 `page`/`pageSize`/`pageCount`/`pageRows`。
- **加载/错误/空三态**：加载失败用 `role="alert"`（assertive，读屏即时播报），不要用 `role="status"`。
- **周期性"现在"时钟**用 `useNowTicker`，不要各页自起 `setInterval`。
- **图表**：option 由纯 builder 生成（可无画布测试）；ECharts 在 `setOption` 时拷贝颜色，主题切换要重建
  option（`useChartTheme` 监听）；每张图配数据表视图（颜色不是唯一通道）。
- 快照式序列用 ref 在 fetch 的 `.then` 里赋值，不要用 computed 读实时 store——避免每 tick 重绘动画。

## 4. 后端（Express 5 + MongoDB 时序 + TS）

- **Express 5 会自动转发 async 处理器的 reject** 到错误中间件；新路由不必写 `try/catch + next(e)` 样板。
- 错误响应体统一为 `{ error, detail?, issues?, requiredCapability?, requestId? }`：`error` 是客户端据以分支的稳定码，
  `detail` 是给人看的原因（哪个字段、哪个引用），5xx 不带 `detail` 只带 `requestId`。不要另起 `message` 等字段名。
- 入参一律 zod 校验，失败走 `respondValidationError`（统一 400 形状）；能力门禁用 `requireCapability`，
  同一前缀的多个路由用 `router.use("/x", …)` 一次性 gate。
- 写配置（整档替换）走 `configRegistry.writeWholeConfig`（parse→原子写→reload→读回）；原子写用
  tmp+rename 并在失败时清 tmp。写盘是运维域配置，**不是控制下发**，红线仍在。
- 外发（HTTP/SMTP）重试统一用 `notify/retry.ts` 的 `withRetry`，失败折成 `AttemptOutcome` 从不抛。
- 内存缓存（如 RBAC）的变更：先快照、改内存、`await persist()`，失败回滚内存（`persistWithRollback`），
  内存不得领先磁盘。
- TTL 索引只在集合缺失时创建；保留期变更交给 `migrations/ttl.ts` 的 `reconcileTtls`（collMod 原地改），
  绝不每次连接都用不同 `expireAfterSeconds` 重 `createIndex`（会 `IndexOptionsConflict(85)` 困死连接）。
- `/openapi.json` 是手维护的真相：新增路由/动作要同步；枚举尽量取自源头常量（如 `AUDIT_ACTIONS`）而非硬编码。
- 只导出被跨文件使用的符号；仅本文件用的不要 `export`。

## 5. 包边界与归一化

- `@navfleet/shared`（零依赖）= 领域类型 + 纯逻辑单一真相（告警规则、报码表、RBAC、报表契约、解析器）；
  `@navfleet/fleet-core`（依赖 shared）= 两个前端共用的无框架车队逻辑；`backend` 只依赖 shared。
- 跨前后端共享的**纯**逻辑放 shared，不要在 backend 与 fleet-core 各维护一份（现存的两套归一化
  `normalize.ts` / `fleetNormalize.ts` 是已知结构债，见 ROADMAP）。
- 可变的模块级默认（`DEFAULT_*`、兜底 payload）按只读使用；不要就地改它。

## 6. 报码（codebook）

- 编码方案：**首位 = 渠道**（info `1xxx` / warning `2xxx` / error `5xxx`），第二位 = 子系统；码号不重复。
- 部署 `config-runtime/codebook.json` **与内置表合并**下发，可覆盖同号条目。演示/测试发的每个码都必须能解析到
  标签（在内置表或部署码表里），且遵守编码方案——不要发查无此码的裸数字。

## 7. 测试与演示数据

- 四个 workspace 各有 vitest 覆盖率门槛（见各自 `vitest.config.ts`），只升不降；本机跨 workspace 并行跑
  coverage 会偶发 5s 超时 flaky（见 memory），**串行跑**或信 CI（各 job 隔离）。
- 不写只断言存在性的空测试、不写纯快照测试；核心逻辑（报表聚合、ingest、RBAC、告警去重）要有针对性用例。
- 演示数据要**自洽**：曲线按车有差异、消息与遥测对齐（如电量偏低落在电量谷底），不要一条曲线套全队 + 随机撒点。

## 8. 验证与 Git 流程

- 交付前跑：`typecheck` / `lint`（`--max-warnings 0`）/ `test` / `build`；整栈验收用 `scripts/verify-stack.sh`。
- 每个改动独立分支 → 本地自检 → 推送 → CI 全绿 → `--no-ff` 合并 → 回写 ROADMAP；合并后删已合并分支。
- 破坏性/难撤销的 git 操作逐次确认；本机推 github 反复 HTTP2 报错时用 `git -c http.version=HTTP/1.1`。
- 不回显密钥值（`.env`/凭据），用键名引用。
