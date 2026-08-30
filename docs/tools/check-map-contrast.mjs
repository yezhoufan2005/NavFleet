/**
 * 机检地图网格与比例尺在场景底图上的对比度。
 *
 * 为什么单开一个脚本，而不是塞进预览页那张审计表：那张表按 4.5:1 判定文本×表面，而
 * `map-grid` / `map-scale` 是**画在 `ros-canvas` 上的非文本图形** —— `ros-canvas`
 * 不是语义表面 token，根本不在那张表的配对里。混进去只会用错的标准误报。
 *
 * 为什么要机检：这几个数原本是"我挑的"。挑完看着都行，但明度在 oklch 里是感知量、
 * 对比度是亮度比，两者不是一回事（11D 已经踩过一次）。**第一次跑就抓到我写在注释里的
 * 估计值是错的**：我按 3.2 / 3.5 写，实测 1.59 / 2.70。所以脚本读**生成后的真实
 * token** 而不是把值再抄一遍 —— 抄一遍只是在验证我抄得对。
 *
 * 两个 token 判定标准不同，这是 WCAG 1.4.11 的适用范围决定的，不是宽严之分：
 *
 * - **`map-scale` 是内容。** 比例尺是"读出距离"这件事的全部依据，属于该条款所说的
 *   "理解内容所必需的图形部件"，按 **3:1** 判。
 * - **`map-grid` 是装饰性参考线。** 网格整条消失，车辆、lanelet、可通行区域一个都不少 ——
 *   纯装饰图形本就在该条款豁免之内。给它套 3:1 只会得到一张吵到盖住小标记的底图，
 *   而车辆必须是最跳的那一层。所以这里只设一条**可见性下限 1.3:1**，防止它悄悄变成
 *   看不见；它究竟该多淡，要等 13A-2 地图真在屏幕上才判得了，这里不假装已经定了。
 *
 * 顺带被这个脚本改掉的一处：深色网格原为 slate-700（2.70:1），比浅色的 1.59:1 显眼近一倍 ——
 * 同一个元素在两套主题里轻重不一致。换成 slate-800 后是 1.84:1，两边基本齐平。
 *
 * 用法：node docs/tools/check-map-contrast.mjs
 * 任一组不达各自下限即退出码 1。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "..", "..", "frontend-next", "src", "styles");

/** 待检的配对：前景（图形）× 背景（底图）× 下限与依据。 */
const PAIRS = [
  ["map-grid", "ros-canvas", 1.3, "装饰参考线：只保可见"],
  ["map-scale", "ros-canvas", 3, "内容图形：WCAG 1.4.11"],
];

/**
 * 点云背景的两个类别色（13A-2b）。
 *
 * 它们**总是带透明度画的**，所以不能像上面那样单独判 —— 透明色的对比度取决于它叠在什么
 * 上面。这里叠的东西是确定的（`ros-canvas`），alpha 也是确定的：栅格化时 obstacle 的
 * alpha 下限是 164/255、floor 的默认值是 82/255（见 fleet-core 的 `paintOccupancy`）。
 * 所以按"最不利但真实会出现"的 alpha 合成后再判。
 *
 * 第三组是这里最要紧的一组：obstacle 与 floor 编码的是**两件不同的事**（撞得到 / 开得过），
 * 把它们混起来才是真正的失效模式，所以它们之间也要够分。
 */
const CLOUD_PAIRS = [
  ["ros-cloud-obstacle", "ros-canvas", 3, "障碍物：必须看得见"],
  ["ros-cloud-floor", "ros-canvas", 1.3, "可通行区：可见但不抢戏"],
  ["ros-cloud-obstacle", "ros-cloud-floor", 3, "两类之间：混淆才是真失效"],
];

/**
 * Every custom property in a block, keyed without the `--color-` prefix so that
 * colours read as `ros-canvas` and the non-colour ones (the point-cloud alphas) read
 * under their own names.
 */
const readTokens = (css) => {
  const tokens = new Map();
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const key = name.startsWith("color-") ? name.slice("color-".length) : name;
    if (!tokens.has(key)) tokens.set(key, value.trim());
  }
  return tokens;
};

/**
 * semantic.css 里同一组 token 出现三次（浅色 @theme、跟随系统的深色、显式深色）。
 * 取第一个 `@theme` 块作为浅色，取 `[data-theme="dark"]` 块作为深色 —— 后者是显式
 * 选择，也是 e2e 与截图实际走的那条路径。
 *
 * 匹配"选择器 + 紧跟的花括号"而不是裸字符串：文件头的注释里既写着 `@theme`，也写着
 * 一段带花括号的示例 CSS，按裸字符串找会把那段示例当成块体读出来（第一版就是这么错的，
 * 症状是"token 缺失: --color-map-grid"而文件里明明有）。
 */
const blockAfter = (css, pattern) => {
  const header = css.match(pattern);
  if (header?.index === undefined) {
    throw new Error(`semantic.css 里找不到 ${pattern}`);
  }
  const open = css.indexOf("{", header.index);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`${pattern} 的花括号没有闭合`);
};

const srgbToLinear = (channel) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (channel) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** oklch → 线性 sRGB（Björn Ottosson 的矩阵）。 */
const oklchToLinear = (lightness, chroma, hue) => {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

/**
 * 解析成 8bit sRGB 再回到线性，而不是直接用线性值算亮度：色域裁剪与 8bit 量化都发生在
 * 屏幕上，绕过它们算出来的是理想值而不是用户看到的值。
 */
const toLinearRgb = (value) => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((channel) =>
      srgbToLinear(channel / 255),
    );
  }
  const oklch = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (oklch) {
    return oklchToLinear(
      Number(oklch[1]),
      Number(oklch[2]),
      Number(oklch[3]),
    ).map((channel) =>
      srgbToLinear(
        Math.round(clamp01(linearToSrgb(clamp01(channel))) * 255) / 255,
      ),
    );
  }
  // 半透明值的对比度取决于它叠在什么上面，不能单独判定 —— 与其偷偷放过，不如报错。
  throw new Error(`无法解析颜色: ${value}（只支持 #rrggbb 与 oklch(L C H)）`);
};

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const contrast = (fg, bg) => {
  const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

const ramp = readTokens(readFileSync(resolve(STYLES, "ramp.css"), "utf8"));
const semanticCss = readFileSync(resolve(STYLES, "semantic.css"), "utf8");
const themes = {
  浅色: readTokens(blockAfter(semanticCss, /^@theme\s*\{/m)),
  深色: readTokens(
    blockAfter(semanticCss, /^:root\[data-theme="dark"\]\s*\{/m),
  ),
};

/** 语义 token 可能是 `var(--color-slate-300)`，跟一跳进 ramp。 */
const resolve1 = (tokens, name) => {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`token 缺失: --color-${name}`);
  const indirect = value.match(/^var\(--color-([\w-]+)\)$/);
  return indirect ? (ramp.get(indirect[1]) ?? tokens.get(indirect[1])) : value;
};

/**
 * 把带 alpha 的前景合成到背景上，得到屏幕上真正出现的颜色。
 *
 * 在**线性**空间做合成而不是在 sRGB 空间：alpha 混合是物理光量的加权和，在 gamma 编码的
 * 数值上直接插值会得到偏暗的结果。
 */
const composite = (fgLinear, bgLinear, alpha) =>
  fgLinear.map(
    (channel, index) => channel * alpha + bgLinear[index] * (1 - alpha),
  );

let failed = 0;
const report = (themeName, label, ratio, floor, why) => {
  const pass = ratio >= floor;
  if (!pass) failed += 1;
  console.log(
    `  ${themeName}  ${label.padEnd(38)} ${ratio.toFixed(2)}:1  ≥${floor}  ` +
      `${pass ? "PASS" : "FAIL"}  ${why}`,
  );
};

console.log("地图非文本图形对比度（下限按各自用途，见文件头）\n");
for (const [themeName, tokens] of Object.entries(themes)) {
  for (const [fgName, bgName, floor, why] of PAIRS) {
    const ratio = contrast(
      toLinearRgb(resolve1(tokens, fgName)),
      toLinearRgb(resolve1(tokens, bgName)),
    );
    report(themeName, `${fgName} on ${bgName}`, ratio, floor, why);
  }

  const canvas = toLinearRgb(resolve1(tokens, "ros-canvas"));
  // Read the alphas rather than restating them: the point of generating the tokens
  // is that this check and the renderer cannot disagree about what will be drawn.
  const alphaOf = (name) => {
    const raw = tokens.get(`${name}-alpha`);
    if (raw === undefined) throw new Error(`token 缺失: --${name}-alpha`);
    return Number(raw) / 255;
  };
  const washed = (name) =>
    name === "ros-canvas"
      ? canvas
      : composite(toLinearRgb(resolve1(tokens, name)), canvas, alphaOf(name));

  for (const [fgName, bgName, floor, why] of CLOUD_PAIRS) {
    report(
      themeName,
      `${fgName} on ${bgName}`,
      contrast(washed(fgName), washed(bgName)),
      floor,
      why,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} 组不达下限。`);
  process.exit(1);
}
console.log("\n全部达标。");
