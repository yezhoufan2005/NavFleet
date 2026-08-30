# 设计系统设计（Phase 11D）

配套预览页：**[frontend-design-system-preview.html](frontend-design-system-preview.html)** —— 色阶、
字阶、间距、层级的可视化，**并对每一组语义前景/背景实时计算 WCAG 对比度**并标出不合格项
（`open docs/frontend-design-system-preview.html`）。

输入：[frontend-ia.md](frontend-ia.md)（已定稿的 IA，候选 B）+
[frontend-parity.md](frontend-parity.md)（338 条现状清单）。

## 0. 三条本轮定下来的技术结论

写在最前面，因为它们决定了后面所有代码怎么写：

1. **语义 token 必须进 `@theme` 但绝不能用 `@theme inline`。** `inline` 会把值**嵌进**工具类
   （`.bg-surface { background: var(--color-slate-25) }`），于是按主题重定义 `--color-surface` 就失效了。
   不加 `inline` 时工具类引用的是 token 本身（`var(--color-surface)`），主题覆盖才生效。
   → 这是整套主题机制的枢纽，写错了表现为"深色主题下颜色完全不切换"。
2. **Tailwind 的 `dark:` 变体要重新绑定到 `[data-theme]`**，因为我们已有的主题机制是 `data-theme`
   属性而不是 `.dark` 类：`@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`。
   但绝大多数场景**不该用 `dark:`** —— 语义 token 已经把主题差异吸收掉了，写 `dark:` 说明该处漏了 token。
3. **三态主题（明/暗/跟随系统）的结构与现在一致**，只是 token 数量变多：`:root` 给浅色基线、
   `@media (prefers-color-scheme: dark)` 里用 `:root:not([data-theme="light"])` 覆盖、
   `:root[data-theme="dark"]` 再覆盖一次。现有 `tokens.css` 已经是这个结构，**这部分不推翻，是扩写**。

## 1. 现状：37 个 token 的问题不是数量少

| 现状                                       | 问题                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 8 个几何/排版 + 29 个语义，双主题成对      | 结构是对的，**语义层的做法值得保留**                                                                                    |
| 颜色只有语义层，**没有原始色阶**           | 需要一个"比 `--warning` 浅一点的底"时无处可取，只能现场写 `rgba(255,179,87,0.13)` —— 现有代码里这种硬编码 rgba 有几十处 |
| 间距只有 `--panel-pad` / `--view-gap` 两个 | 组件内部间距全靠手写 px，四个视图曾对同一问题给出四个答案（18 / 18-20 / 20-22 / **0**）                                 |
| **没有字阶**                               | 字号散落在各 partial 里，从 9px 到 22px 至少 11 种，没有刻度                                                            |
| 只有一个 `--transition`                    | 没有区分"状态切换"与"进出场"两类动效                                                                                    |
| 只有 `--shadow` / `--shadow-sm`            | 没有层级语义（浮层 / 抽屉 / 对话框应各有其值）                                                                          |
| `--radius-sm/--radius/--radius-lg`         | 够用，保留                                                                                                              |

**必须原样保留的一处**：`--brand-contrast`（用于**实心** brand 表面）与 `--brand-ink`（用于
`rgba(--brand-rgb, …)` **薄底**）的区分。两者明度需求**相反**，这是 Phase 10 用 axe 才发现的 ——
浅色主题下 `--brand-contrast: #ffffff` 落在中调青绿上只有 **2.99:1**。新体系里这条区分要升级成规则而非
特例（见 3.3）。

## 2. token 体系：三层

```
① 原始层  color ramp / 字阶 / 间距刻度 / 层级 / 动效曲线   —— 与主题无关，进 @theme
② 语义层  surface / ink / border / brand / notice…        —— 按主题覆盖，进 @theme 但不 inline
③ 组件层  按需，且只在"某组件确实需要一个语义层没有的值"时才加
```

第 ③ 层刻意留窄。现有代码的教训是：一旦允许组件自定义颜色，硬编码 rgba 就会回来。

### 2.1 原始层

| 组       | 设计                                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 色阶     | 6 条 ramp × 各 **12 阶**（25 / 50 / 100 / 200 … 900 / 950）：`teal`（品牌）、`slate`（中性，**带青绿偏色**而不是纯灰）、`blue`（notice）、`amber`（warning）、`rose`（critical）、`zinc`（offline / 禁用）。用 `oklch()` 定义以保证明度阶梯感知均匀 —— **但注意这不等于对比度达标，见 3.3** |
| 字阶     | `2xs 11 / xs 12 / sm 13 / base 14 / md 15 / lg 17 / xl 20 / 2xl 24 / 3xl 30 / 4xl 38`（px），各自带 `--leading-*`。**基准 14px 而非 16px** —— 这是控制台密度，不是文章                                                                                                                      |
| 大屏字阶 | `wall` 断点下另一套：`wall-sm 20 / wall-base 26 / wall-lg 34 / wall-xl 48 / wall-2xl 72`。两米外可读是硬要求                                                                                                                                                                                |
| 间距     | `--spacing: 4px` 基准，用 Tailwind 的乘数刻度（`p-2` = 8px…）。保留 `--panel-pad` / `--view-gap` 作为**语义**间距，值取自刻度                                                                                                                                                               |
| 圆角     | `xs 6 / sm 10 / md 14 / lg 22 / full`（沿用现值）                                                                                                                                                                                                                                           |
| 层级     | `--shadow-raised`（卡片）/ `--shadow-overlay`（popover、dropdown）/ `--shadow-drawer` / `--shadow-modal`，每档双主题两套值                                                                                                                                                                  |
| 动效     | `--ease-standard`（状态切换 160ms）/ `--ease-entrance`（进场 220ms，减速）/ `--ease-exit`（出场 140ms，加速）。全部包在 `prefers-reduced-motion` 之下                                                                                                                                       |
| 断点     | `md 768 / lg 1024 / xl 1280 / 2xl 1536 / 3xl 1920 / wall 2560`（IA 决定）                                                                                                                                                                                                                   |

### 2.2 语义层

保留现有 29 个的**命名思路**（它们的名字已经是语义而非表象），补齐缺口：

- 表面：`surface` / `surface-raised` / `surface-sunken` / `surface-overlay`
- 文本：`ink` / `ink-muted` / `ink-subtle` / `ink-inverse`
- 边框：`border` / `border-strong` / `border-focus`
- 品牌：`brand` / `brand-hover` / `brand-contrast` / `brand-ink` / `brand-wash`
- 状态四色各三档：`notice|warning|critical|offline` × `{base, ink, wash}`
- 图表：`chart-1…8`（ECharts 系列色，**与状态色分开** —— 状态色有语义，系列色没有）
- 地图：沿用现有 6 个 `--ros-*`，补 `--map-grid` / `--map-scale`

### 2.3 图表系列色：独立一层，不从 ramp 取（12D 落地）

`chart-1…8` **刻意不从上面那 6 条 ramp 里取**，理由是结构性的：分类色靠色相彼此可分，而这套
ramp 只有 4 条有彩色相（teal / blue / amber / rose），凑 8 个系列必然出现"同色相两档"的配对 ——
而同色相配对恰好是分类编码最不该有的东西，第 1 与第 5 条曲线会看起来像同一条。所以系列色是
独立的一层（2.2 已经这么定了，12D 把它落成了 token）。

取值采用 dataviz 方法里那套已文档化、已验证的 8 色分类板，**并按 NavFleet 自己的表面重跑了
校验器**（图表画在 `surface-raised` 上：浅色 `#ffffff`、深色 slate-800 `#384243`）：

| 模式 | 明度带 | 彩度下限 | CVD 最差相邻 ΔE | 正常视觉最差相邻 ΔE | 对比度               |
| ---- | ------ | -------- | --------------- | ------------------- | -------------------- |
| 浅色 | PASS   | PASS     | 9.1（≥8）       | 19.6（≥15）         | WARN（3 个槽 < 3:1） |
| 深色 | PASS   | PASS     | 8.4（≥8）       | 19.3（≥15）         | WARN（4 个槽 < 3:1） |

两条必须记住的规则：

1. **槽位顺序本身就是 CVD 安全机制，不要重排。** 顺序不是审美选择。
2. **对比度 WARN 不是可以忽略的警告，是一条义务**：低于 3:1 的槽要求值能通过第二个通道读到。
   所以 `TimeSeriesChart` 内置数据表视图 —— 删掉它会让这套调色板变成不合规，而不只是让组件变小。

还有一条与状态色的分工：**状态色是保留的**（`notice` / `warning` / `critical` / `offline`），
永远不当"第 4 个系列"用；反过来，当一条曲线本身表达好坏（合格率、故障率）时它穿状态色而不是
系列色。一张图里不混用两套。

### 2.4 组件层的准入规则

只有满足**两条**才允许新增组件 token：① 语义层确实没有能表达它的值；② 该值在两个以上组件里复用。
否则用语义 token 的组合。这条规则要写进 CONTRIBUTING。

### 2.5 一条硬规则：凹陷区上的文字至少用 `ink-muted`

**`ink-subtle` × `surface-sunken` 是禁用组合**，浅色下只有 4.43:1。它过不去的原因是结构性的，
所以不要试图靠调值绕过：浅色 `ink-subtle` 必须明显浅于 `ink-muted`(slate-700)，而 slate-600 在
任何比 slate-25 更暗的底上都到不了 4.5；色阶里没有 650 这一档，插一档又会改变 `chroma()` 的
索引距离、连带动到所有深色端的彩度。所以这条组合被显式排除在审计表之外，规则写在这里。

这条是 12C 实测出来的，同时暴露出**审计表本身漏检**：11D 只审了 `ink`/`surface`、
`ink`/`surface-raised`、`ink-muted`/`surface`、`ink-subtle`/`surface` 四组，于是漏掉了
`ink-subtle` 落在 `surface-raised` 上的那一组 —— 深色下只有 4.06:1，而占位卡、下拉菜单、抽屉
全都是 raised。漏检的机理值得记住：**深色的 `surface-raised`(slate-800) 比 `surface`(slate-900)
更亮**，所以"在 surface 上够用"推不出"在 raised 上也够用"。

修法两处，都在生成器里：

1. 审计配对从 4 组扩到「文本 × 表面」的组合（18 组），只排除上面那一组禁用组合；
2. 深色文本整体上移一档 —— `ink-muted` slate-300 → slate-200、`ink-subtle` slate-400 → slate-300。
   之后最差一组是 `ink-subtle` on `surface-raised` **5.58:1**。

## 3. Tailwind v4 接入方案

### 3.1 文件结构

```
frontend-next/src/styles/
├─ index.css          @import "tailwindcss"; 然后按顺序 @import 下面各文件
├─ ramp.css           @theme { 原始色阶 / 字阶 / 间距 / 圆角 / 层级 / 动效 / 断点 }
├─ semantic.css       @theme { 语义 token 的浅色基线 } + 两个主题覆盖块
├─ base.css           @layer base { 元素默认样式、focus-visible、滚动条 }
└─ components.css     @layer components { 少量跨组件的复合样式 }
```

### 3.2 三态主题的确切写法

```css
/* semantic.css */
@theme {
  /* 浅色基线。不加 inline —— 见第 0 节第 1 条 */
  --color-surface: var(--color-slate-25);
  --color-ink: var(--color-slate-900);
  --color-brand: var(--color-teal-600);
  /* … */
}

/* 跟随系统（未标记 data-theme 的默认态）*/
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-surface: var(--color-slate-900);
    --color-ink: var(--color-slate-50);
    --color-brand: var(--color-teal-300);
  }
}

/* 显式选深色，优先于系统 */
:root[data-theme="dark"] {
  --color-surface: var(--color-slate-900);
  /* … */
}
```

工具类 `.bg-surface` 编译为 `background-color: var(--color-surface)`，所以上面两个覆盖块一改，
**所有用到该 token 的地方同时切换** —— 不需要 `dark:` 前缀，也不需要为深色写第二套类名。

一处必须注意的坑：**深浅两套覆盖块必须列出同一组 token**。漏一个的表现是该处在深色下继续用浅色值，
而这正是"artifact 深色不可读"那类 bug 的成因。→ 用一个脚本机检两个块的 key 集合是否相同（见 6.2）。

### 3.3 `-contrast` / `-ink` 升级为规则 —— 而且第一版被机检打回了

Phase 10 的教训不该停留在两个特例上。规则化为：**每个状态色都有 `-contrast` 与 `-ink` 两个配套前景**

| token                | 用在                                   | 取值                        |
| -------------------- | -------------------------------------- | --------------------------- |
| `--color-X`          | 实心表面本身（按钮底、激活态）         | 浅色 `X-700` / 深色 `X-300` |
| `--color-X-contrast` | **实心** X 表面上的文字                | 浅色 `X-25` / 深色 `X-950`  |
| `--color-X-ink`      | X 的**薄底**（`X-wash`）上的文字、徽标 | 浅色 `X-800` / 深色 `X-200` |

**这组取值不是我想出来的，是机检逼出来的。** 第一版我写的是实心表面 `X-600` + 配套前景 `X-950`
（两个主题都用 950），预览页一跑就红了 **4 组 / 14 组**：

```
brand-contrast   on brand    3.84:1
notice-contrast  on notice   3.74:1
warning-contrast on warning  3.65:1
offline-contrast on offline  3.34:1
```

根因是一条我原本没意识到的事：**`oklch()` 的感知均匀明度不等于 WCAG 的亮度比。** oklch 的 `L` 是感知量，
WCAG 用线性化后的相对亮度 —— `L 0.55` 对 `L 0.20` 看着差很多，实际只有约 **3.7:1**。所以"明度阶梯均匀"
这个好性质**不会自动带来对比度达标**，两者必须分别验证。

改成上表取值后实测：**浅色 14/14 通过、最低 4.62:1；深色 14/14 通过、最低 5.58:1；跟随系统态同浅色。**

### 3.4 CSS 体积预算

现状基线（实测 `frontend/dist`）：**36.4 KB 未压缩 / 7.7 KB gzip**，2,557 行手写 CSS。

预算：**gzip ≤ 14 KB**。理由与构成：

- Tailwind v4 只输出用到的工具类与 token，一个中等应用通常落在 8–12 KB gzip
- Reka UI 是**无头**的，**不带任何 CSS**（这是选它而非 Naive/Element 的一个具体好处）
- 我们自己的 `@layer components` 要压在 3 KB gzip 内 —— 超了说明该用工具类的地方写了自定义类

超预算的处置：先查是否有 ① 未被 `@theme` 覆盖而手写的颜色 ② 本该是工具类的组件类 ③ 忘删的旧
partial。**不通过提高预算来解决。**

## 4. Reka UI：用哪些、不用哪些

Reka UI（Radix Vue 改名）提供 **40 个无头 primitive**，遵循 WAI-ARIA authoring practices，
带 Focus Scope（焦点陷阱与循环）与 Roving Focus（roving tabindex），并用 `asChild` 把行为组合到
自己的元素上而不额外套一层。

选它的理由是可核销的，不是"看着不错"：我们已有 **axe serious/critical 阻塞**的 CI 门禁，而
[parity 第 9 节](frontend-parity.md) 里有 4 处 a11y 缺陷（无自定义 focus 样式、`aria-label` 挂在无 role 的
div 上、确认按钮缺 `aria-pressed`、可滚动区键盘不可达）。焦点管理与 ARIA 由 primitive 保证，等于把这
一类缺陷从"每次都要记得"变成"默认就对"。

### 4.1 采用（14 个）

| Primitive                            | 用在                                       | 替掉现在的什么                                                                                              |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `Tabs`                               | 设备详情四 tab、告警四 tab                 | 现在没有 tab，靠独立页                                                                                      |
| `Select` / `Listbox`                 | 设备选择、时间范围、倍速                   | 原生 `<select>`（可用但样式与键盘行为不统一）                                                               |
| `Combobox`                           | 设备搜索（IA B 的设备列表需要）            | 现在没有搜索                                                                                                |
| `Dialog` / `AlertDialog`             | 批量确认、删除用户等破坏性确认             | 现在**没有任何确认弹窗**（parity 6 节：批量操作无 toast 无弹窗）                                            |
| `DropdownMenu`                       | 用户菜单（个人偏好从设置页挪进来）、行操作 | 现在没有                                                                                                    |
| `Popover`                            | 筛选面板、图例展开                         | 现在没有                                                                                                    |
| `Tooltip`                            | 图标按钮说明                               | 现在用原生 `title`（触屏不可达、无键盘触发）                                                                |
| `Toast`                              | 通知宿主                                   | 替 `NotificationHost` 的**渲染层**；`useNotifications` 的去重/时长逻辑保留（它已被 12 处调用且有测试）      |
| `Switch` / `Checkbox` / `RadioGroup` | 设置、筛选、"显示已确认"                   | 原生 input（设置页的 radio group 已经做对了，可平移）                                                       |
| `ToggleGroup`                        | GPS/ROS 视图切换、严重度分桶筛选           | 现在是两个 `aria-pressed` 按钮 —— 语义上正是 ToggleGroup                                                    |
| `Slider`                             | 回放进度                                   | 原生 `range`（**`aria-label` 必须保留**，那是 axe critical 修复）                                           |
| `NumberField`                        | 历史 limit 输入                            | 原生 `number`（其 `min/max` 因无 `<form>` 而不生效，见 parity 9.13）                                        |
| `ScrollArea`                         | 设备列表、详情列                           | 原生 overflow（**注意**：`.detail-scroll` 的 `tabindex="0"` 是 axe 修复，换成 ScrollArea 后要确认等效可达） |
| `Separator`                          | 分区线                                     | 手写 border                                                                                                 |

### 4.2 备选（等到用时再定，3 个）

`DateRangePicker`（历史时间范围，现在是两个 `datetime-local`，缺少先后校验）、`Splitter`（设备列表与
地图之间的可调分隔，值班台宽屏下有价值）、`Stepper`（Phase 18 的设备接入向导）。

### 4.3 不用（自建）

- **两个地图**：SVG 视口与 AMap，没有对应 primitive；`useSvgViewport` 原样搬（决定见 IA 文档）
- **ECharts 封装**：图表是自己的一层
- **骨架屏**：现有 `SkeletonBlock` 的设计（`aria-hidden` 在外层 + 容器 `aria-busy`）已经对了，平移
- **业务组件**：KPI 卡、设备行、告警行、状态徽标、待处理车辆卡 —— 它们是 NavFleet 的领域形状，不是通用件
- **侧栏导航**：`NavigationMenu` 是为顶栏 mega-menu 设计的；我们要的是三态侧栏，自建更直接

## 5. 组件清单

页面级按 [IA 文档](frontend-ia.md) 候选 B 的层级展开。**这份清单是 Phase 12B/12C 与 13A–13F 的工作分解。**

### 5.1 原子（12）

`Button`（primary / secondary / ghost / danger × sm / md）· `IconButton` · `Input` · `NumberInput` ·
`Select` · `Checkbox` · `Radio` · `Switch` · `Badge`（状态徽标，`data-tone` 五档）· `Chip`（可关闭的
筛选条件）· `Skeleton`（line / value / card）· `Spinner`

### 5.2 分子（14）

`Panel`（默认带 `--panel-pad`，新页面无法忘记 —— 这是 Phase 10 的修法，保留）· `PanelHead` ·
`Tabs` · `Toolbar` · `Pagination` · `Toast` · `Dialog` · `Drawer` · `DropdownMenu` · `Popover` ·
`Tooltip` · `EmptyState`（现在有 12 处互斥空态，各自手写）· `ErrorState` · `FreshnessIndicator`
（最后更新时刻 + 超阈值变色，大屏模式的硬要求，普通视图也该有）

### 5.3 领域组件（11）

`KpiTile`（值 + 单位 + 趋势 sparkline）· `DeviceRow` · `DeviceCard`（待处理车辆用）· `AlertRow` ·
`SeverityFilter`（ToggleGroup 封装）· `FormationChip` · `PoseCard` · `CodeCard` · `TelemetryGrid` ·
`TrendChart`（ECharts 封装）· `PlaybackBar`

### 5.4 页面级（按 IA B）

| 路由           | 页面组件           | 备注                                                    |
| -------------- | ------------------ | ------------------------------------------------------- |
| `/`            | `OverviewPage`     | **新页面**，4–5 信号 + 待处理车辆 + 告警热区 + 迷你地图 |
| `/devices`     | `DevicesPage`      | 列表 ⇄ 地图两个视图，首次进入按 40 台阈值自动选         |
| `/devices/:id` | `DeviceDetailPage` | 四个 tab：实时 / 曲线 / 历史回放 / 告警史               |
| `/alerts`      | `AlertsPage`       | 四个 tab：实时 / 历史 / 统计 / 规则                     |
| `/reports`     | `ReportsPage`      | Phase 17 才有内容，12C 只立骨架与空态                   |
| `/admin`       | `AdminPage`        | **真的落地页**（不允许跳第一个子项），子页 Phase 15 填  |
| `/wall`        | `WallPage`         | 独立外壳，不复用侧栏；kiosk 凭据，Phase 17C             |
| `*`            | `NotFoundPage`     | 平移现有                                                |

外壳组件：`AppShell` · `SideNav`（三态）· `TopBar`（面包屑 / 车队 / 会话 / 实时点）· `UserMenu` ·
`Breadcrumb`（按层级自动生成）· `ReturnToPrevious`（跨分支跳转用）。

## 5.5 预览页是怎么来的

`docs/frontend-design-system-preview.html` **由脚本生成，不要手改**：

```
docs/tools/gen-design-system-preview.py            数据 + 生成逻辑
docs/tools/design-system-preview.template.html     骨架，用 __PLACEHOLDER__ 占位
→ docs/frontend-design-system-preview.html
```

三个设计上的选择值得记：

1. **色阶用程序算而不是手写。** 72 个值手写必然出现不均匀的台阶；而生成规则本身（明度阶梯固定、
   彩度向 500 阶两端线性收敛）就是这套色阶的设计说明，改一个参数能重算整条 ramp。
2. **语义层成对定义**（`(token, 浅色值, 深色值)` 一行一个），所以深浅两套**结构上不可能漏 key** ——
   6.2 那个机检因此变成了冗余保险而不是唯一防线。
3. **对比度不自己解析 `oklch()`**，而是把计算色填进 1×1 canvas 再读回 sRGB —— 让浏览器做色彩空间转换。
   这样任何语法（`oklch` / `color-mix` / 变量链）都能算，且算的就是屏幕上的实际值。

模板用 `__PLACEHOLDER__` 而不是 `str.format`：CSS 满是花括号，转义成 `{{ }}` 让我连续失败两次，
换成占位符替换之后一次就过。

## 6. 验证方式

### 6.1 对比度：预览页实时机检

预览页对每一组配对用 WCAG 相对亮度公式算比值，双主题各算一遍，低于 4.5:1 标红。
**这条替代"记得检查对比度"**，因为 Phase 10 证明人工审阅三轮都没发现 2.99:1。

配对表在 12C 扩到 **18 组**：原来的 `(X-contrast, X)` 与 `(X-ink, X-wash)` 十组，加上「文本 ×
表面」的组合。扩的理由与那次漏检见 2.5 —— 一句话说：只审四组文本配对，会漏掉深色下
`ink-subtle` 落在 `surface-raised` 上的 4.06:1，而那正是占位卡、下拉菜单与抽屉的底色。

### 6.2 深浅 token 集合一致性：脚本机检

写一个测试读 `semantic.css`，断言 `:root` 基线、`prefers-color-scheme` 覆盖块、`[data-theme="dark"]`
覆盖块**三者的 token key 集合完全相同**。漏一个的表现是深色下继续用浅色值，肉眼容易漏。

### 6.3 CSS 体积：CI 门禁

构建后断言 gzip 后的 CSS ≤ **14 KB**，超了红。基线 7.7 KB。

### 6.4 a11y：沿用并扩视口

axe 从单一 1440×900 扩到 **1024 / 1440 / 2560** 三个视口 × 明暗双主题，serious/critical 仍为红线。
Reka 的 primitive 让这一关更容易过，但**不替代跑它** —— parity 第 9 节里 `incomplete` 桶那条已知边界
说明 axe 本身也有盲区。

## 7. 风险

| 风险                                             | 应对                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Tailwind v4 + `@theme` 的主题覆盖没按预期工作    | 12B 第一件事就是把 3.2 那段写成最小可验证切片：一个按钮 + 一次主题切换。若不成立，此时沉没成本只有一个 PR               |
| Reka 的某个 primitive 与我们的键盘/ARIA 期望不符 | 4.1 的 14 个里，风险最高的是 `ScrollArea`（要替掉一处 axe 修复）与 `Toast`（要保留既有去重逻辑）。这两个在 12B 单独验证 |
| `oklch()` 色阶在旧浏览器降级                     | 目标是内网现代浏览器；仍加 `@supports` 兜底为 hex，并在预览页标注                                                       |
| 大屏字阶与普通字阶两套，容易漏                   | 只在 `wall` 断点生效，且 KpiTile / FreshnessIndicator 两个组件承担绝大部分大屏文本                                      |
| 组件层 token 失控                                | 2.3 的准入规则进 CONTRIBUTING；code review 时对新增 token 提问"哪两个组件复用了它"                                      |

## 8. Phase 11 收口

四份文档齐了：[parity](frontend-parity.md) 338 条现状 · [research](frontend-research.md) 24 项任务流 +
8 条约束 · [ia](frontend-ia.md) 定稿 IA · 本文件。加两个可视化页（IA 线框、设计系统预览）。

**下一步需要负责人做一次整体评审**，通过后进 Phase 12 —— 那是 v3 里第一次写产品代码。
