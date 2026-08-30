#!/usr/bin/env node
/**
 * Fails the build if a development-only chunk reached `dist/`.
 *
 * The chart performance harness (`views/ChartPerfView.vue`) is registered behind
 * `import.meta.env.DEV || VITE_CHART_PERF`, which means a normal production build
 * should contain neither it nor — until a real page uses a chart — ECharts. That is
 * the kind of guarantee that holds right up until someone adds an unconditional
 * import and nobody notices, so it is checked rather than remembered.
 *
 * Deliberately narrow: it looks for the harness chunk only, not for ECharts. Phase
 * 13C will legitimately pull ECharts into a product page, and a check that broke
 * then would be a check people learn to delete.
 */
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const DEV_ONLY = /ChartPerfView/i;

if (!existsSync(DIST)) {
  console.error(`[dev-only-chunks] no dist/ at ${DIST} — did the build run?`);
  process.exit(1);
}

// Opting in is how the bundle cost gets measured, so the check steps aside for it.
if (process.env.VITE_CHART_PERF) {
  console.log(
    "[dev-only-chunks] VITE_CHART_PERF set — harness expected, skipped",
  );
  process.exit(0);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [join(dir, entry.name).slice(DIST.length + 1)],
  );

const offenders = walk(DIST).filter((file) => DEV_ONLY.test(file));

if (offenders.length > 0) {
  console.error(
    `[dev-only-chunks] development-only chunks shipped in dist/:\n  ${offenders.join("\n  ")}`,
  );
  process.exit(1);
}

console.log("[dev-only-chunks] clean — no development-only chunks in dist/");
