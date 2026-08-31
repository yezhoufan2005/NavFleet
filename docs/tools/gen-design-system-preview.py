#!/usr/bin/env python3
"""生成 Phase 11D 的设计系统预览页（docs/frontend-design-system-preview.html）。

为什么生成而不是手写：72 个色阶值手写必然出现不均匀的台阶，而生成规则本身
（明度阶梯固定、彩度向 500 阶两端线性收敛）就是这套色阶的设计说明 —— 改一个参数
就能重算整条 ramp。语义层成对定义，所以深浅两套**不可能漏 key**。

模板用 __PLACEHOLDER__ 占位而不是 str.format：CSS 满是花括号，转义成 {{ }} 是上一版
连续失败两次的原因。

用法：
    python3 docs/tools/gen-design-system-preview.py
生成后会自动跑一次 prettier —— 替换进去的那几段（色阶、表格行）不可能天然符合 prettier 的
换行规则，而 pre-commit 的 lint-staged 又会格式化它，不在这里定型就会来回颠。
"""

import subprocess
from pathlib import Path

STEPS = {
    25: 0.985, 50: 0.970, 100: 0.940, 200: 0.880, 300: 0.800, 400: 0.710,
    500: 0.630, 600: 0.550, 700: 0.460, 800: 0.370, 900: 0.280, 950: 0.200,
}
ORDER = list(STEPS)

RAMPS = [
    ("teal", 178, 0.100, "品牌"),
    ("slate", 205, 0.020, "中性（带青绿偏色，不是纯灰）"),
    ("blue", 250, 0.150, "notice"),
    ("amber", 72, 0.140, "warning"),
    ("rose", 16, 0.170, "critical"),
    ("zinc", 235, 0.008, "offline / 禁用"),
]

SEMANTIC = [
    ("surface", "slate-25", "slate-900"),
    ("surface-raised", "white", "slate-800"),
    ("surface-sunken", "slate-50", "slate-950"),
    ("ink", "slate-900", "slate-50"),
    # 深色侧原来是 300 / 400，被 12C 的 axe 审计打回：ink-subtle(slate-400) 落在
    # surface-raised(slate-800) 上只有 4.06:1。整体上移一档 —— muted 300→200、
    # subtle 400→300 —— 之后最差一组是 subtle on raised 5.58:1。
    ("ink-muted", "slate-700", "slate-200"),
    ("ink-subtle", "slate-600", "slate-300"),
    # 深色侧原来是 800 / 700，而 surface-raised 也是 slate-800 —— border 与它所画在的
    # 那层表面**同色**，对比度 1.00:1。人工检查报的是「深色模式下顶栏那条竖线看不到」，
    # 而那条线只是最明显的症状：全站每一处 `border-border` + `bg-surface-raised` 的卡片
    # 边框在深色下都是隐形的，只不过卡片还能靠自身填充（slate-800）与页面（slate-900）
    # 的差别勉强分辨，画在同一层表面上的分隔线就彻底消失。
    # 整体上移一档：border 800→700（对 raised 1.47:1）、strong 700→600（2.15:1）。
    # 判定标准取 check-map-contrast.mjs 给装饰性参考线用的那条 ≥1.3:1 —— 边框正是这一类
    # 结构性图形，不是文本。浅色侧 border 对 white 是 1.43:1，改完两个主题基本对称。
    ("border", "slate-200", "slate-700"),
    ("border-strong", "slate-300", "slate-600"),
    # 遮罩。两个主题**故意取同一个值**：遮罩的作用是压暗下层，浅色主题下压暗、深色主题下
    # 压亮是把它的语义反过来了 —— 12C 里第一版抽屉就是这么做的，深色下整块内容被"洗白"。
    # 它总是带透明度使用（bg-scrim/55），所以不进按 4.5:1 判定的审计表。
    ("scrim", "slate-950", "slate-950"),
    # 焦点环。它是非文本 UI 组件，WCAG 1.4.11 要求 3:1 而不是 4.5:1，所以不进
    # 下面那张按 4.5:1 判定的审计表 —— 混进去会用错的标准误报。
    ("border-focus", "teal-600", "teal-400"),
    ("brand", "teal-700", "teal-300"),
    ("brand-hover", "teal-800", "teal-200"),
    ("brand-contrast", "teal-25", "teal-950"),
    ("brand-ink", "teal-800", "teal-200"),
    ("brand-wash", "teal-50", "teal-900"),
    ("notice", "blue-700", "blue-300"),
    ("notice-contrast", "blue-25", "blue-950"),
    ("notice-ink", "blue-800", "blue-200"),
    ("notice-wash", "blue-50", "blue-900"),
    ("warning", "amber-700", "amber-300"),
    ("warning-contrast", "amber-25", "amber-950"),
    ("warning-ink", "amber-800", "amber-200"),
    ("warning-wash", "amber-50", "amber-900"),
    ("critical", "rose-700", "rose-300"),
    ("critical-contrast", "rose-25", "rose-950"),
    ("critical-ink", "rose-800", "rose-200"),
    ("critical-wash", "rose-50", "rose-900"),
    ("offline", "zinc-600", "zinc-400"),
    ("offline-contrast", "zinc-25", "zinc-950"),
    ("offline-ink", "zinc-700", "zinc-300"),
    ("offline-wash", "zinc-100", "zinc-800"),
]

# ---------------------------------------------------------------------------
# 图表系列色（chart-1…8）
# ---------------------------------------------------------------------------
#
# **刻意不从上面那 6 条 ramp 里取。** 分类色靠的是色相彼此可分，而这套 ramp 只有 4 条
# 有彩色相（teal / blue / amber / rose），凑 8 个系列必然出现"同色相两档"的配对 ——
# 而同色相配对恰好是分类编码最不该有的东西：第 1 与第 5 条曲线看起来像同一条。
# 所以系列色是独立的一层，与状态色分开（11D §2.2 已经这么定了）。
#
# 取值来自 dataviz 技能的参考调色板（已文档化的 8 色分类板，含明暗两套），**并按
# NavFleet 自己的表面重跑了校验器**（浅色 #ffffff、深色 slate-800 #384243，
# 图表都画在 surface-raised 上）：
#
#   浅色：明度带 PASS · 彩度下限 PASS · CVD 最差相邻 ΔE 9.1 · 正常视觉最差相邻 ΔE 19.6
#   深色：明度带 PASS · 彩度下限 PASS · CVD 最差相邻 ΔE 8.4 · 正常视觉最差相邻 ΔE 19.3
#
# 两套都是**对比度 WARN**（浅色 3 个槽、深色 4 个槽低于 3:1）。按该方法的"救济规则"，
# 这不是可以忽略的警告，而是一条义务：组件必须同时提供可见标签或数据表视图。
# TimeSeriesChart 因此内置了表格视图，不是附加功能。
#
# 槽位**顺序本身就是 CVD 安全机制**，不是审美选择 —— 不要重排。
CHART = [
    ("chart-1", "#2a78d6", "#3987e5"),  # blue
    ("chart-2", "#eb6834", "#d95926"),  # orange
    ("chart-3", "#1baf7a", "#199e70"),  # aqua
    ("chart-4", "#eda100", "#c98500"),  # yellow
    ("chart-5", "#e87ba4", "#d55181"),  # magenta
    ("chart-6", "#008300", "#008300"),  # green
    ("chart-7", "#4a3aa7", "#9085e9"),  # violet
    ("chart-8", "#e34948", "#e66767"),  # red
]

# 图表的坐标轴与网格。它们是**非文本 UI**，WCAG 1.4.11 要 3:1 而不是 4.5:1，所以不进
# 下面那张按 4.5:1 判定的审计表 —— 混进去会用错的标准误报。
CHART_FRAME = [
    ("chart-grid", "slate-200", "slate-700"),
    ("chart-axis", "slate-400", "slate-500"),
]

# ---------------------------------------------------------------------------
# 地图表面（13A-1）
# ---------------------------------------------------------------------------
#
# 这 6 个 `ros-*` 是**原值搬迁**，不是重新取色。理由有两条，都不是省事：
#
# 1. 11D §2.2 当时就定了"沿用现有 6 个"。它们是对着点云栅格与 lanelet 叠加层手调出来
#    的 —— canvas 与 free 之间那一点点明度差，决定的是"可通行区域"看不看得出来。
# 2. **改这几个值是对地图外观的改动，而地图要到 13A-2 才在屏幕上。** 在看不见渲染结果的
#    情况下重取一遍，跟 12C 里那个"写死成绿色的状态点"是同一类错误：无法判断，就不该定。
#
# 与 CHART 一样是字面量而非 ramp token，还有一个具体原因：点云栅格化是往 ImageData 里
# 逐像素写值，zrender 与 canvas 都自己解析颜色，两者都不认识 oklch。
MAP = [
    ("ros-canvas", "#e9eef4", "#071119"),
    ("ros-free", "#c4cfdc", "#8c9498"),
    ("ros-lanelet-bg", "#dbe3ec", "#09131b"),
    ("ros-lanelet-line", "rgba(37, 99, 235, 0.55)", "rgba(133, 214, 255, 0.5)"),
    ("ros-lanelet-center", "rgba(30, 41, 59, 0.32)", "rgba(255, 255, 255, 0.28)"),
    ("ros-link", "rgba(30, 41, 59, 0.5)", "rgba(255, 255, 255, 0.72)"),
    # 点云的两个类别色（13A-2b）。深色两个是 13A-2a 从旧前端原值搬来的；浅色那一对是
    # 这一轮新定的 —— 现在地图真在屏幕上，才判得了。**四组都过机检**，判定见
    # check-map-contrast.mjs：它们总是带 alpha 画的，所以按真实 alpha 合成到 ros-canvas
    # 上再判，并且 obstacle 与 floor 之间也要够分（混淆"撞得到"和"开得过"才是真失效）。
    ("ros-cloud-obstacle", "#123a52", "#b6edff"),
    ("ros-cloud-floor", "#5a6b7a", "#6c8494"),
]

# 点云两个类别色的 alpha 下限。**不是颜色，所以不带 --color- 前缀。**
#
# 为什么 alpha 必须跟着主题走：一层半透明的浅色洗在近黑底上读得很清楚，同样 64% 的
# 不透明度洗在近白底上**无论取什么颜色都到不了 3:1** —— 剩下 36% 透出来的画布本身就把
# 亮度垫在了 3:1 允许的上限之上。这不是挑色挑得不好，是 alpha 定死了上限。
# 这条是机检算出来的：浅色第一版按 164 试，三组全 FAIL，且代数上无解。
MAP_CLOUD_ALPHA = [
    ("ros-cloud-obstacle-alpha", 220, 164),
    ("ros-cloud-floor-alpha", 82, 82),
]

# 网格与比例尺是 11D §2.2 承诺要补的两个，取自 ramp（与 chart-grid / chart-axis 同源）。
# 它们画在 ros-canvas 上而不是在语义表面上，所以不在下面那张审计表的覆盖范围内 ——
# 改用 docs/tools/check-map-contrast.mjs 单独机检，两者判定标准不同（比例尺是内容，按
# WCAG 1.4.11 的 3:1；网格是装饰参考线，只保 1.3:1 的可见性下限，理由见该脚本文件头）。
#
# 实测（该脚本输出）：grid 浅 1.59:1 / 深 1.84:1，scale 浅 4.12:1 / 深 10.26:1。
# 深色网格原写 slate-700，实测 2.70:1 —— 比浅色显眼近一倍，同一元素在两套主题里轻重
# 不一致。改 slate-800 后齐平。**这条是机检抓出来的，不是看出来的。**
MAP_FRAME = [
    ("map-grid", "slate-300", "slate-800"),
    ("map-scale", "slate-600", "slate-300"),
]

PAIRS = [
    # 文本 × 表面的组合，穷举而非挑几组。原先只审了四组，漏掉的正是 12C 里 axe 抓到的
    # 那一组：深色下 ink-subtle 落在 surface-raised 上只有 4.06:1。漏的原因很具体 ——
    # 深色 surface-raised(slate-800) 比 surface(slate-900) **更亮**，所以"在 surface 上
    # 够用"推不出"在 raised 上也够用"，而占位卡、下拉菜单、抽屉全都是 raised。
    #
    # 少一组：**ink-subtle × surface-sunken 在浅色下只有 4.43:1，是禁用组合**。它过不去
    # 的原因是结构性的：浅色 ink-subtle 必须明显浅于 ink-muted(slate-700)，而 slate-600
    # 在任何比 slate-25 更暗的底上都不够 4.5。色阶里没有 650 这一档，而插一档会改变
    # chroma() 的索引距离、连带动到所有深色端的彩度 —— 代价远大于收益。
    # 所以规则是：**凹陷区上的文字至少用 ink-muted**，见 frontend-design-system.md §2.5。
    ("ink", "surface", "正文"),
    ("ink", "surface-raised", "卡片上的正文"),
    ("ink", "surface-sunken", "凹陷区上的正文"),
    ("ink-muted", "surface", "次要文本"),
    ("ink-muted", "surface-raised", "卡片上的次要文本"),
    ("ink-muted", "surface-sunken", "凹陷区上的次要文本（凹陷区的下限）"),
    ("ink-subtle", "surface", "第三级文本（仅非关键信息）"),
    ("ink-subtle", "surface-raised", "卡片上的第三级文本"),
    ("brand-contrast", "brand", "实心 brand 表面上的文字"),
    ("brand-ink", "brand-wash", "brand 薄底上的文字"),
    ("notice-contrast", "notice", "实心 notice 表面"),
    ("notice-ink", "notice-wash", "notice 薄底"),
    ("warning-contrast", "warning", "实心 warning 表面"),
    ("warning-ink", "warning-wash", "warning 薄底"),
    ("critical-contrast", "critical", "实心 critical 表面"),
    ("critical-ink", "critical-wash", "critical 薄底"),
    ("offline-contrast", "offline", "实心 offline 表面"),
    ("offline-ink", "offline-wash", "offline 薄底"),
]

TYPE_SCALE = [
    ("2xs", 11, 1.45, "表格里的次要注记"),
    ("xs", 12, 1.5, "标签、徽标"),
    ("sm", 13, 1.55, "辅助文本"),
    ("base", 14, 1.6, "正文基准（控制台密度，不是文章）"),
    ("md", 15, 1.6, "强调正文"),
    ("lg", 17, 1.45, "卡片标题"),
    ("xl", 20, 1.35, "统计数值、区块标题"),
    ("2xl", 24, 1.25, "页面标题"),
    ("3xl", 30, 1.2, "总览页的关键数字"),
    ("4xl", 38, 1.1, "少用"),
]

WALL_SCALE = [
    ("wall-sm", 20, "大屏标签"),
    ("wall-base", 26, "大屏正文"),
    ("wall-lg", 34, "大屏卡片标题"),
    ("wall-xl", 48, "大屏统计值"),
    ("wall-2xl", 72, "大屏主指标（两米外可读）"),
]

SPACING_STEPS = (1, 2, 3, 4, 5, 6, 8, 10, 12, 16)


def chroma(peak, step):
    """彩度在 500 阶达峰，向两端线性收敛 —— 浅色端不发灰、深色端不糊成一团。"""
    return round(peak * (1 - 0.11 * abs(ORDER.index(step) - ORDER.index(500))), 4)


def ramp_css():
    out = []
    for name, hue, peak, _ in RAMPS:
        for step, light in STEPS.items():
            out.append(f"    --color-{name}-{step}: oklch({light} {chroma(peak, step)} {hue});")
        out.append("")
    return "\n".join(out).rstrip()


def semantic_css(index):
    """语义层 + 图表层 + 地图层。前者引用 ramp token，字面值的那些见各自注释。"""
    lines = [f"    --color-{r[0]}: var(--color-{r[index]});" for r in SEMANTIC]
    lines.append("")
    lines.append("    /* 图表：系列色为字面值，坐标轴/网格取自 ramp。 */")
    lines += [f"    --color-{r[0]}: {r[index]};" for r in CHART]
    lines += [f"    --color-{r[0]}: var(--color-{r[index]});" for r in CHART_FRAME]
    lines.append("")
    lines.append("    /* 地图：ros-* 为原值搬迁的字面值，网格/比例尺取自 ramp。 */")
    lines += [f"    --color-{r[0]}: {r[index]};" for r in MAP]
    lines += [f"    --color-{r[0]}: var(--color-{r[index]});" for r in MAP_FRAME]
    lines.append("")
    lines.append("    /* 点云 alpha 下限：不是颜色，所以不带 --color- 前缀。 */")
    lines += [f"    --{r[0]}: {r[index]};" for r in MAP_CLOUD_ALPHA]
    return "\n".join(lines)


def chart_chips():
    """系列色的色板。值随主题切换，所以用 token 而不是写死那一列。"""
    return "".join(
        f'<i style="background: var(--color-{name})" title="{name}">'
        f"<em>{index}</em></i>"
        for index, (name, _light, _dark) in enumerate(CHART, start=1)
    )


def map_chips():
    """地图表面。画在 ros-canvas 上，所以整条带子先铺上它自己的底。"""
    return "".join(
        f'<i style="background: var(--color-{name})" title="{name}">'
        f"<em>{name.replace('ros-', '').replace('map-', '')}</em></i>"
        for name, _light, _dark in MAP + MAP_FRAME
    )


def ramp_rows():
    rows = []
    for name, _, _, use in RAMPS:
        chips = "".join(
            f'<i style="background: var(--color-{name}-{s})" title="{name}-{s}"><em>{s}</em></i>'
            for s in STEPS
        )
        rows.append(
            f'<div class="ramp"><div class="ramp-label"><b>{name}</b>'
            f"<span>{use}</span></div>"
            f'<div class="ramp-strip">{chips}</div></div>'
        )
    return "\n        ".join(rows)


def pair_rows():
    rows = []
    for fg, bg, note in PAIRS:
        rows.append(
            f'<tr data-fg="{fg}" data-bg="{bg}">'
            f"<td><code>{fg}</code></td><td><code>{bg}</code></td><td>{note}</td>"
            f'<td><span class="sample" style="background: var(--color-{bg});'
            f' color: var(--color-{fg})">车队 42 台在线 Aa</span></td>'
            f'<td class="ratio" data-role="ratio">—</td>'
            f'<td class="verdict" data-role="verdict">—</td></tr>'
        )
    return "\n          ".join(rows)


def type_rows():
    return "\n          ".join(
        f"<tr><td><code>text-{k}</code></td><td class=\"num\">{px}px</td>"
        f'<td class="num">{lh}</td>'
        f'<td style="font-size: {px}px; line-height: {lh}">在线设备 42 / 48 · Fleet ready</td>'
        f"<td>{use}</td></tr>"
        for k, px, lh, use in TYPE_SCALE
    )


def wall_rows():
    rows = []
    for k, px, use in WALL_SCALE:
        shown = min(px, 44)
        note = use + (f"（此处按 {shown}px 截显，实际 {px}px）" if px > shown else "")
        rows.append(
            f'<tr><td><code>text-{k}</code></td><td class="num">{px}px</td>'
            f'<td style="font-size: {shown}px; line-height: 1.1; font-weight: 600">42 / 48</td>'
            f"<td>{note}</td></tr>"
        )
    return "\n          ".join(rows)


def spacing_rows():
    return "\n          ".join(
        f'<div class="sp"><i style="width: calc(var(--spacing) * {n})"></i>'
        f"<span>{n} · {4 * n}px</span></div>"
        for n in SPACING_STEPS
    )


HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "design-system-preview.template.html"
OUTPUT = HERE.parent / "frontend-design-system-preview.html"


def main():
    html = TEMPLATE.read_text(encoding="utf-8")
    for placeholder, value in (
        ("__RAMP_CSS__", ramp_css()),
        ("__SEMANTIC_LIGHT__", semantic_css(1)),
        ("__SEMANTIC_DARK__", semantic_css(2)),
        ("__RAMP_ROWS__", ramp_rows()),
        ("__CHART_CHIPS__", chart_chips()),
        ("__MAP_CHIPS__", map_chips()),
        ("__PAIR_ROWS__", pair_rows()),
        ("__TYPE_ROWS__", type_rows()),
        ("__WALL_ROWS__", wall_rows()),
        ("__SPACING_ROWS__", spacing_rows()),
        ("__RAMP_COUNT__", str(len(RAMPS))),
        ("__STEP_COUNT__", str(len(STEPS))),
        ("__PAIR_COUNT__", str(len(PAIRS))),
        ("__SEMANTIC_COUNT__", str(len(SEMANTIC))),
    ):
        html = html.replace(placeholder, value)
    leftover = [token for token in ("__RAMP", "__SEMANTIC", "__PAIR", "__TYPE", "__WALL", "__SPACING", "__STEP", "__CHART", "__MAP") if token in html]
    if leftover:
        raise SystemExit(f"模板里还有未替换的占位符: {leftover}")
    OUTPUT.write_text(html, encoding="utf-8")
    subprocess.run(
        ["npx", "prettier", "--write", str(OUTPUT)],
        cwd=HERE.parent.parent,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    html = OUTPUT.read_text(encoding="utf-8")
    print(f"已写出 {OUTPUT.relative_to(HERE.parent.parent)}（{len(html)} 字节，已 prettier 定型）")
    print(f"  色阶 {len(RAMPS)} × {len(STEPS)} = {len(RAMPS) * len(STEPS)} 个值")
    print(f"  语义 token {len(SEMANTIC)} 个 + 图表 {len(CHART) + len(CHART_FRAME)} 个"
          f" + 地图 {len(MAP) + len(MAP_FRAME)} 个 × 双主题成对定义")
    print(f"  待机检的对比度配对 {len(PAIRS)} 组")
    write_styles()



# ── 同一份数据也生成 frontend-next 的真实 token ──────────────────────────────
# 预览页与实际代码由同一处数据产出，所以预览页里那 14 组对比度审计审的就是线上
# 真正用的值 —— 两者结构上无法漂移。

STYLES = HERE.parent.parent / "frontend-next" / "src" / "styles"

TYPE_CSS = "\n".join(
    f"  --text-{k}: {px}px;\n  --text-{k}--line-height: {lh};" for k, px, lh, _ in TYPE_SCALE
)
WALL_CSS = "\n".join(f"  --text-{k}: {px}px;" for k, px, _ in WALL_SCALE)

RAMP_FILE = '''/* 由 docs/tools/gen-design-system-preview.py 生成，不要手改。 */

/*
 * 原始层：与主题无关的刻度。进 @theme 所以 Tailwind 为它们生成工具类
 * （bg-teal-600 / text-lg / p-4 / rounded-md / shadow-raised / ease-standard / 3xl:）。
 *
 * 色阶用 oklch 而非 hex，为的是明度阶梯在感知上均匀。注意一条 11D 用机检才发现的事：
 * 感知均匀**不等于** WCAG 亮度比达标 —— L 0.55 对 L 0.20 看着差很多，实测只有约 3.7:1。
 * 所以语义层的前景/背景配对必须单独验证，见 docs/frontend-design-system-preview.html。
 */
@theme {
__RAMPS__

  --color-white: oklch(1 0 0);

  /* 字阶：基准 14px 而非 16px —— 这是控制台密度，不是文章。 */
__TYPE__

  /* 大屏字阶：仅在 wall 断点下使用，按"两米外可读"设计。 */
__WALL__

  --spacing: 4px;

  --radius-xs: 6px;
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 22px;

  --shadow-raised: 0 1px 2px oklch(0.2 0.02 205 / 0.06), 0 8px 20px oklch(0.2 0.02 205 / 0.07);
  --shadow-overlay: 0 4px 10px oklch(0.2 0.02 205 / 0.1), 0 20px 40px oklch(0.2 0.02 205 / 0.12);
  --shadow-drawer: 0 0 0 1px oklch(0.2 0.02 205 / 0.08), -12px 0 32px oklch(0.2 0.02 205 / 0.14);
  --shadow-modal: 0 8px 20px oklch(0.2 0.02 205 / 0.14), 0 32px 64px oklch(0.2 0.02 205 / 0.18);

  /* 状态切换 / 进场 / 出场三类，用途不同不能共用一条。 */
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-entrance: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);

  /* 断点（11C 决定）：两端是平板与墙面看板，不是手机。 */
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --breakpoint-xl: 1280px;
  --breakpoint-2xl: 1536px;
  --breakpoint-3xl: 1920px;
  --breakpoint-wall: 2560px;

  --font-sans: "IBM Plex Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
'''

SEMANTIC_FILE = '''/* 由 docs/tools/gen-design-system-preview.py 生成，不要手改。 */

/*
 * 语义层。三条必须记住的规则：
 *
 * 1. 进 @theme 但**绝不能加 inline**。inline 会把值嵌进工具类
 *    （.bg-surface { background: var(--color-slate-25) }），于是下面两个覆盖块就失效了。
 *    不加 inline 时工具类引用的是 token 本身，主题覆盖才生效 —— 写错的症状是
 *    「深色主题下颜色完全不切换」。
 * 2. 深浅两套必须列出**同一组 token**。漏一个的表现是该处在深色下继续用浅色值。
 *    这两个块由脚本从同一份成对数据生成，所以结构上不可能漏。
 * 3. 绝大多数场景**不该用 dark: 前缀** —— 语义 token 已经把主题差异吸收掉了，
 *    写 dark: 说明该处漏了 token。
 */
@theme {
__LIGHT__
}

/* 跟随系统：未标记 data-theme 的默认态。 */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
__DARK__
  }
}

/* 显式选深色，优先于系统偏好。 */
:root[data-theme="dark"] {
__DARK__
}
'''


def write_styles():
    STYLES.mkdir(parents=True, exist_ok=True)
    ramp = RAMP_FILE.replace("__RAMPS__", ramp_css()).replace("__TYPE__", TYPE_CSS).replace("__WALL__", WALL_CSS)
    (STYLES / "ramp.css").write_text(ramp, encoding="utf-8")
    semantic = SEMANTIC_FILE.replace("__LIGHT__", semantic_css(1)).replace("__DARK__", semantic_css(2))
    (STYLES / "semantic.css").write_text(semantic, encoding="utf-8")
    subprocess.run(
        ["npx", "prettier", "--write", str(STYLES / "ramp.css"), str(STYLES / "semantic.css")],
        cwd=HERE.parent.parent, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"  也写出了 frontend-next/src/styles/{{ramp,semantic}}.css（与预览页同源）")

if __name__ == "__main__":
    main()
