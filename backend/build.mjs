// Backend production build: bundle to a single self-contained dist/index.js.
//
// Why bundle rather than `tsc` emit: the backend imports runtime values from the
// workspace package `@navfleet/shared` (parseCodebook, deviceMatchesScope,
// emptyAlertStatsReport, …, since Phase 16). `tsc` leaves those as a bare
// `require("@navfleet/shared")`, and that package's `exports` resolve to its
// TypeScript *source* (`src/index.ts`) — which node cannot run and which the
// runtime image never copied, so `node dist/index.js` crashed on boot. Bundling
// inlines `@navfleet/shared` from source, so the runtime has no external workspace
// require at all; the image needs only the built file plus real npm deps.
//
// Third-party dependencies stay EXTERNAL (installed via `npm ci --omit=dev` in the
// image, required at runtime as before). Only the `@navfleet/*` workspace packages
// are bundled — read the split straight off package.json so a new dependency cannot
// silently get inlined. Type-checking is not this script's job: `npm run typecheck`
// (tsc --noEmit) still runs in CI and locally.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

// Every declared dependency is external except the workspace packages, which are
// the whole point of bundling.
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@navfleet/"),
);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  // Matches the runtime image (node:24-alpine) and the engines floor.
  target: "node22",
  outfile: "dist/index.js",
  external,
  sourcemap: false,
  logLevel: "info",
});
