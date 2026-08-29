import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { version as releaseVersion } from "../../package.json";

/**
 * The release version lives in exactly one file: the root manifest. That is what
 * release-please bumps, what it tags, what the runtime image carries, and what
 * `/openapi.json` reports (see openapi.test.ts).
 *
 * The three workspace manifests are `private: true` and are never published, so
 * they declare no version at all. That is the point of this file: a version
 * field there has no consumer and cannot be kept in sync automatically —
 * release-please only owns the root — so it exists only to go stale. This
 * project has already been bitten three times:
 *
 *   1. `openapi.ts` hardcoded `0.1.0` and stayed wrong through two releases.
 *   2. A release PR was titled 1.0.0 while its branch files said 0.4.0; merging
 *      it would have tagged the wrong version.
 *   3. The three workspace manifests were hand-edited to 1.0.0 during the 1.0.0
 *      wrap-up, but the lockfile still recorded them as 0.1.0 — nothing checks
 *      that field, so nobody noticed until the first automated patch release.
 *
 * Asserting absence is what makes the drift structurally impossible rather than
 * merely currently-correct.
 */

const REPO_ROOT = path.join(__dirname, "..", "..");

const WORKSPACE_MANIFESTS = [
  "backend/package.json",
  "frontend/package.json",
  "packages/shared/package.json",
] as const;

const readManifest = (relative: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8")) as Record<string, unknown>;

describe("release version has a single source", () => {
  it("declares a semver version in the root manifest", () => {
    const root = readManifest("package.json");
    expect(root.version).toBe(releaseVersion);
    expect(releaseVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(WORKSPACE_MANIFESTS)("leaves %s without a version field", (relative) => {
    const manifest = readManifest(relative);
    expect(manifest.private).toBe(true);
    expect(manifest.version).toBeUndefined();
  });

  it("records no workspace version in the lockfile either", () => {
    const lockfile = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"),
    ) as {
      version?: string;
      packages: Record<string, { version?: string }>;
    };

    expect(lockfile.version).toBe(releaseVersion);
    expect(lockfile.packages[""]?.version).toBe(releaseVersion);
    for (const relative of WORKSPACE_MANIFESTS) {
      const key = path.dirname(relative);
      expect(lockfile.packages[key], `missing lockfile entry for ${key}`).toBeTruthy();
      expect(lockfile.packages[key]?.version, `${key} should not pin a version`).toBeUndefined();
    }
  });
});
