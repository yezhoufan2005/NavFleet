# 设计系统

NavFleet 控制台（`frontend-next` / `navfleet-console`）的视觉系统。目标是**整套界面读起来像一个系统**，
明暗两套主题一致、对比度达标。配色采 **GitHub Primer**（浅色 = Light default，深色 = dark_dimmed）。

## 令牌在哪、怎么分层

全部令牌在 `frontend-next/src/styles/`，三层，组件只用最上面一层：

| 文件           | 职责                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `ramp.css`     | 原始色阶（slate / 各色相的数值梯度）——**不直接在组件里用**                                        |
| `semantic.css` | 语义令牌（`--color-surface` / `--color-ink` / `--color-brand` / `--color-*-wash` 等），从色阶取值 |
| `base.css`     | 全局 reset、排版基线、焦点环、滚动收敛                                                            |
| `index.css`    | 入口：引入上面三者 + Tailwind，并把 `dark:` 变体重绑到 `data-theme="dark"`                        |

**主题切换走根元素的 `data-theme` 属性**（`useTheme` 写入），不是 `.dark` class。`semantic.css` 在
`:root`（浅）与 `[data-theme="dark"]`（深）两处各定义一遍语义令牌——所以**组件只引用语义令牌，主题差异
由令牌吸收**。组件里出现 `dark:` 往往意味着缺了一个令牌，而不是真需要这个变体。

## 语义令牌（组件只用这些）

- **表面**：`surface`（页面底）/ `surface-raised`（卡片）/ `surface-sunken`（凹槽，如表头）/ `surface-hover`。
- **文字**：`ink`（正文）/ `ink-muted`（次要）/ `ink-subtle`（最弱）。
- **描边**：`border` / `border-strong` / `border-muted` / `border-focus`。
- **品牌/强调**：`brand`（= Primer accent 蓝）/ `brand-hover` / `brand-contrast` / `brand-ink` / `brand-wash`。
- **语义状态**：`notice`（蓝，提示）/ `warning`（琥珀，预警）/ `critical`（红，告警），各带 `-contrast`（其上文字）
  / `-ink`（同色文字）/ `-wash`（浅底）。**严重度三档只用这组**，不要另造颜色。

> 与「消息/告警」术语对应：`critical`=告警、`warning`=预警、`notice`=提示（见 `docs/conventions.md`）。
> 严重度的标签与徽章 class 统一在前端 `src/lib/severity.ts`，不在组件里就地写。

## 对比度（硬约束）

每一组「前景 × 背景」语义搭配都要过 **WCAG AA**（正文 4.5:1、大字/图形 3:1）。浅深两套分别算，
不要让一套达标另一套塌掉。图表/数据可视化的配色另见 `dataviz` 规范：颜色不是唯一通道（必有图例/数据表/
直接标注），且跑校验脚本而不是凭眼睛判断色盲安全。

## 用法要点

- 组件写 Tailwind 工具类，颜色一律走语义令牌（如 `bg-surface-raised text-ink border-border`），
  不写字面 hex、不跨主题硬编码。
- 新增一个语义角色时，先在 `semantic.css` 的**两个主题块都**加令牌，再在组件里用；只加一处会让另一套主题
  读到未定义的颜色。
- 焦点可见：键盘焦点有可见态（`base.css` 的 `:focus-visible`），不要在组件里抹掉。
