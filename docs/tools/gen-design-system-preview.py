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
    ("border", "slate-200", "slate-800"),
    ("border-strong", "slate-300", "slate-700"),
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
    # 所以规则是：**凹陷区上的文字至少用 ink-muted**，见 frontend-design-system.md §2.3。
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
    return "\n".join(f"    --color-{r[0]}: var(--color-{r[index]});" for r in SEMANTIC)


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
    leftover = [token for token in ("__RAMP", "__SEMANTIC", "__PAIR", "__TYPE", "__WALL", "__SPACING", "__STEP") if token in html]
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
    print(f"  语义 token {len(SEMANTIC)} 个 × 双主题成对定义")
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
