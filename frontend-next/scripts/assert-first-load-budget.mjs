#!/usr/bin/env node
/**
 * Fails the build if the console's **first-load** payload outgrows its budget.
 *
 * This exists because of a regression I shipped and did not notice: 14A put the
 * product's logo in `public/image.png` at 564×579 / 246 KiB, referenced by both the
 * favicon and the top bar, i.e. fetched on every page. PNG is already compressed, so
 * gzip took nothing off it — that one file was **69% of the first-load transfer**,
 * larger than the whole of v1.0.0's dist. I had looked at the file size and called it
 * "wasteful but acceptable" without measuring it against anything. A number nobody
 * compares to a budget is not a measurement.
 *
 * What is measured: every URL `dist/index.html` references, which is the set a cold
 * visit must fetch before the app can render. Route chunks are excluded by
 * construction — they are lazily imported, so they do not appear in `index.html` —
 * and that is the property worth protecting: ECharts is 181 KiB gzipped and belongs
 * to two tabs, not to the landing page.
 *
 * Budgets are *ceilings with headroom*, not the current value: a budget equal to
 * today's measurement fails on the next legitimate byte and gets deleted. They sit
 * roughly 25% above the measurement at the time of writing (127 KiB gzip / 340 KiB
 * raw) — enough for a view or two, tight enough that another 240 KiB asset cannot
 * walk in unnoticed.
 */
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Ceilings, in KiB. See the header for why they are not the current numbers. */
const BUDGET_GZIP_KIB = 160;
const BUDGET_RAW_KIB = 420;

if (!existsSync(DIST)) {
  console.error(`[first-load] no dist/ at ${DIST} — did the build run?`);
  process.exit(1);
}

const html = readFileSync(join(DIST, "index.html"), "utf8");
// Same-origin absolute URLs only: that is how Vite emits entry, preload and asset
// references, and it keeps an external CDN URL from being counted as local weight.
const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map(
  (m) => m[1],
);
const paths = [...new Set(referenced)].sort();

let raw = 0;
let gzip = 0;
const rows = [];
const missing = [];

for (const path of paths) {
  const file = join(DIST, path);
  if (!existsSync(file)) {
    missing.push(path);
    continue;
  }
  const bytes = readFileSync(file);
  const gz = gzipSync(bytes, { level: 9 }).length;
  raw += bytes.length;
  gzip += gz;
  rows.push({ path, raw: bytes.length, gz });
}

// index.html itself is the request that starts everything, and it is not in its own
// reference list.
const indexBytes = Buffer.byteLength(html);
raw += indexBytes;
gzip += gzipSync(Buffer.from(html), { level: 9 }).length;
rows.push({
  path: "index.html",
  raw: indexBytes,
  gz: gzipSync(Buffer.from(html), { level: 9 }).length,
});

rows.sort((left, right) => right.gz - left.gz);

const kib = (bytes) => (bytes / 1024).toFixed(1);
const overGzip = gzip / 1024 > BUDGET_GZIP_KIB;
const overRaw = raw / 1024 > BUDGET_RAW_KIB;

if (overGzip || overRaw) {
  console.error(
    `[first-load] OVER BUDGET — ${kib(raw)} KiB raw / ${kib(gzip)} KiB gzip ` +
      `(ceiling ${BUDGET_RAW_KIB} / ${BUDGET_GZIP_KIB} KiB)\n` +
      `  Biggest contributors, gzip first — an asset here is fetched on every page:\n` +
      rows
        .slice(0, 8)
        .map(
          (r) =>
            `    ${r.path.padEnd(44)} ${kib(r.raw).padStart(8)} KiB  gzip ${kib(r.gz).padStart(7)} KiB`,
        )
        .join("\n") +
      `\n  Either shrink it, load it lazily (a route chunk is not in this set), or ` +
      `raise the ceiling **with the reason written down**.`,
  );
  process.exit(1);
}

if (missing.length) {
  console.error(
    `[first-load] index.html references files that are not in dist/: ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `[first-load] ${kib(raw)} KiB raw / ${kib(gzip)} KiB gzip across ${rows.length} requests ` +
    `— under the ${BUDGET_RAW_KIB} / ${BUDGET_GZIP_KIB} KiB ceiling`,
);
