import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * **No 。 in copy the operator reads.**
 *
 * The house rule, asked for during 14H acceptance and worth a test rather than a style
 * note: a label, a tooltip, an empty state, a toast, a 报码 explanation — none of them end
 * in a full stop. UI copy is a caption, not prose; the period adds a character to every
 * string and tells the reader nothing, and one string carrying it while its neighbour does
 * not is the kind of inconsistency that is invisible while writing and obvious on screen.
 *
 * Sentence *breaks* inside a longer string are fine and keep their punctuation — they just
 * use ，or ；instead, which is what the sweep converted them to. So the rule is exactly
 * "the character does not appear", which is why this can be checked mechanically.
 *
 * `packages/fleet-core` is scanned too, and that is the point of scanning by tree rather
 * than by workspace: the largest single body of copy in the product is the 报码 dictionary,
 * and it lives there rather than in `src` because both front ends read it.
 *
 * Comments are stripped first, for the same reason `dead-exports.test.ts` strips them:
 * prose about the code is not copy. A comment quoting a Chinese sentence — and several
 * quote acceptance reports verbatim — is documentation, and holding it to a UI convention
 * would be a rule about the wrong thing.
 */
const TREES = [
  resolve(__dirname, "../src"),
  resolve(__dirname, "../../packages/fleet-core/src"),
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("UI copy punctuation", () => {
  it("carries no 。 anywhere an operator can read it", () => {
    const offenders: string[] = [];

    for (const tree of TREES) {
      for (const file of sourceFiles(tree)) {
        const lines = stripComments(readFileSync(file, "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (line.includes("。")) {
            offenders.push(
              `${relative(resolve(__dirname, ".."), file)}:${index + 1} ${line.trim()}`,
            );
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
