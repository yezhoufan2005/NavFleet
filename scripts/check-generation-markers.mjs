#!/usr/bin/env node
/**
 * Fails on a leftover generation marker: a comment line that is nothing but `// PLACEHOLDER_X`,
 * `// CHUNK_2`, `// APPEND-MARKER`, `<!-- WALL_STYLE -->` and the like. They are what an edit in
 * pieces leaves behind, they mean nothing, and a reader takes them for unfinished work
 * (docs/conventions.md §1). Several sat in HEAD for months because nothing looked for them.
 *
 * Only whole-line markers count, so prose that names one (as this file does) passes.
 */
import { spawnSync } from "node:child_process";

const MARKER =
  "^[[:space:]]*(//|#|<!--)[[:space:]]*(PLACEHOLDER_[A-Z0-9_]+|CHUNK_[0-9]+|APPEND[-_]MARKER|[A-Z]+_STYLE)[[:space:]]*(-->)?[[:space:]]*$";

const result = spawnSync(
  "git",
  ["grep", "-nE", MARKER, "--", ".", ":!frontend/**", ":!package-lock.json"],
  { encoding: "utf8" },
);
if (result.status === 0) {
  console.error("Leftover generation markers:\n" + result.stdout);
  process.exit(1);
}
if (result.status !== 1) {
  console.error(result.stderr || "git grep failed");
  process.exit(2);
}
console.log("no generation markers");
