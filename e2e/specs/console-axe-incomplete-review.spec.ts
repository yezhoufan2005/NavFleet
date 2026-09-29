import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { signIn, test } from "../support/fixtures";
import { collectIncomplete, type IncompleteFinding } from "../support/axe";
import { REPO_ROOT } from "../support/harness";

/**
 * axe `incomplete` bucket — the periodic human-review surface.
 *
 * This is NOT a gate. axe's `incomplete` results are checks it could not decide
 * automatically (a `color-contrast` node over a semi-transparent, gradient or
 * overlapping background whose effective colour it cannot compute). Phase 10
 * confirmed the suite cannot catch these: they are neither pass nor violation, so
 * asserting on them would either flake or rubber-stamp. What it *can* do is put the
 * whole bucket in front of a person on demand, so an undecidable finding gets a
 * verdict from someone rather than accumulating unseen.
 *
 * It runs only under AXE_REVIEW (set by `npm run axe:incomplete`); in CI the test
 * skips instantly, so it costs nothing and never gates. It writes a consolidated
 * report to playwright-report/axe-incomplete.md — see
 * docs/accessibility-incomplete-review.md for how to triage each entry.
 */

// The same signed-in surfaces the accessibility gate audits, at one representative
// width. The incomplete bucket is driven by surface composition (overlays,
// gradients, translucency), which does not meaningfully change across the viewport
// scale the way a reflow violation would, so one width keeps the run short while
// still visiting every distinct surface.
const ROUTES: readonly { path: string; heading: string | RegExp }[] = [
  { path: "/", heading: "总览" },
  { path: "/devices", heading: "设备" },
  { path: "/devices/agv-a03", heading: /a03/i },
  { path: "/devices/agv-a03?tab=playback", heading: /a03/i },
  { path: "/devices/agv-a03?tab=alerts", heading: /a03/i },
  { path: "/alerts", heading: "消息" },
  { path: "/alerts?view=history", heading: "消息" },
  { path: "/reports", heading: "报表" },
  { path: "/admin", heading: "管理" },
  { path: "/admin/system", heading: "系统状态" },
  { path: "/admin/scenes", heading: "场景" },
  { path: "/wall", heading: /活跃告警/ },
];

const useTheme = async (page: Page, theme: "light" | "dark"): Promise<void> => {
  await page.addInitScript(
    (value) => window.localStorage.setItem("navfleet:theme", value),
    theme,
  );
};

const REPORT_PATH = path.join(
  REPO_ROOT,
  "playwright-report",
  "axe-incomplete.md",
);

const renderReport = (findings: readonly IncompleteFinding[]): string => {
  const when = new Date().toISOString();
  const rules = [...new Set(findings.map((f) => f.rule))].sort();
  const lines = [
    "# axe `incomplete` review",
    "",
    `生成于 ${when} · 共 ${findings.length} 条待人工判定 · 涉及规则：${rules.join(", ") || "（无）"}`,
    "",
    "> 这些是 axe 无法自动判定的检查（多为半透明/渐变/叠加表面上的对比度）。",
    "> 逐条按 docs/accessibility-incomplete-review.md 的步骤判定：手动量一次有效对比度，",
    "> 达标则记为已复核，不达标则开修复。**空清单是好事，不是出错。**",
    "",
  ];
  if (findings.length === 0) {
    lines.push("本次未发现任何 incomplete 项。");
    return lines.join("\n");
  }
  lines.push("| 规则 | 影响 | 出现位置 | 元素 |", "| --- | --- | --- | --- |");
  for (const f of findings) {
    const selectors = f.selectors.join(" ⏐ ").replace(/\|/g, "\\|");
    lines.push(`| ${f.rule} | ${f.impact} | ${f.view} | ${selectors} |`);
  }
  return lines.join("\n");
};

test("collect the axe incomplete bucket across every console surface", async ({
  page,
}) => {
  // On-demand only: inert in CI, driven by `npm run axe:incomplete`.
  test.skip(
    !process.env.AXE_REVIEW,
    "on-demand review surface — run via `npm run axe:incomplete`",
  );
  test.setTimeout(180_000);
  const findings: IncompleteFinding[] = [];

  for (const theme of ["light", "dark"] as const) {
    const label = theme === "dark" ? "深色" : "浅色";
    await useTheme(page, theme);
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const route of ROUTES) {
      await page.goto(route.path);
      await page
        .getByRole("heading", { name: route.heading })
        .first()
        .waitFor({ state: "visible" });
      findings.push(
        ...(await collectIncomplete(page, `${route.path} — ${label}`)),
      );
    }
  }

  const report = renderReport(findings);
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${report}\n`, "utf8");
  // Also to stdout, so a terminal run needs no second step to see the outcome.
  console.log(`\n${report}\n\naxe incomplete 报告已写入 ${REPORT_PATH}`);
});
