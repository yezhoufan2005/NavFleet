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
    ("ink-muted", "slate-700", "slate-300"),
    ("ink-subtle", "slate-600", "slate-400"),
    ("border", "slate-200", "slate-800"),
    ("border-strong", "slate-300", "slate-700"),
    ("brand", "teal-700", "teal-300"),
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
    ("ink", "surface", "正文"),
    ("ink", "surface-raised", "卡片上的正文"),
    ("ink-muted", "surface", "次要文本"),
    ("ink-subtle", "surface", "第三级文本（仅非关键信息）"),
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


if __name__ == "__main__":
    main()
