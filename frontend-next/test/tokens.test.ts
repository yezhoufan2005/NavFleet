// @vitest-environment node
//
// Node, not the jsdom default: this file reads CSS and component sources off
// disk and never touches a document. It also has to be node for a duller
// reason — under jsdom `import.meta.url` is the document's origin rather than a
// file:// URL, so path resolution silently produced `/src/styles/…` and the
// first read failed with ENOENT.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Machine checks for the token layer, specified in
 * docs/frontend-design-system.md §6.2. They are cheap, they run without a
 * browser, and they guard the two mistakes that are invisible until someone
 * switches themes and finds half the page wrong.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, "..", "src", "styles");
const SRC = join(HERE, "..", "src");

/**
 * Comments are stripped before anything is searched. The file's header comment
 * explains the `@theme inline` trap and in doing so contains both the string
 * `@theme` and a `{ … }` example — so a naive `indexOf("@theme")` finds the prose
 * and extracts a fragment of the explanation instead of the rule. Which is
 * exactly what happened the first time this test ran.
 */
const semantic = readFileSync(join(STYLES, "semantic.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Token names declared inside one `{ … }` block, in source order. */
const tokensIn = (block: string): string[] =>
  [...block.matchAll(/--color-[\w-]+(?=\s*:)/g)].map((match) => match[0]);

const blockAfter = (marker: string): string => {
  const start = semantic.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = semantic.indexOf("{", start + marker.length - 1);
  let depth = 0;
  for (let index = open; index < semantic.length; index += 1) {
    if (semantic[index] === "{") depth += 1;
    else if (semantic[index] === "}") {
      depth -= 1;
      if (depth === 0) return semantic.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
};

const collectFiles = (dir: string, extensions: string[]): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectFiles(full, extensions);
    return extensions.some((extension) => entry.endsWith(extension))
      ? [full]
      : [];
  });

describe("semantic token blocks", () => {
  it("never uses `@theme inline`, which would defeat theme switching", () => {
    // `inline` embeds the resolved value into the utility class, so
    // `.bg-surface` would compile to `background: var(--color-slate-25)` and the
    // per-theme overrides below would have nothing to override. The symptom is
    // "colours do not change at all in dark mode".
    for (const file of collectFiles(STYLES, [".css"])) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@theme\s+inline/);
    }
  });

  it("declares the same token set in the light baseline and both dark paths", () => {
    const light = tokensIn(blockAfter("@theme"));
    const followsSystem = tokensIn(
      blockAfter(':root:not([data-theme="light"])'),
    );
    const explicitDark = tokensIn(blockAfter(':root[data-theme="dark"]'));

    expect(light.length).toBeGreaterThan(20);
    // Sorted comparison, because a missing token is the failure mode — not order.
    expect([...followsSystem].sort()).toEqual([...light].sort());
    expect([...explicitDark].sort()).toEqual([...light].sort());
  });

  it("keeps the two dark paths identical to each other", () => {
    // They exist separately because one wins over the OS and the other follows
    // it, but a value that differs between them means a viewer sees one theme
    // when following the system and a slightly different one after clicking.
    expect(blockAfter(':root[data-theme="dark"]').replace(/\s+/g, " ")).toBe(
      blockAfter(':root:not([data-theme="light"])').replace(/\s+/g, " "),
    );
  });

  it("gives every state colour a -contrast and an -ink companion", () => {
    // The Phase 10 lesson, generalised: `-contrast` goes on a solid surface and
    // `-ink` on a wash, and their lightness requirements are opposite. A state
    // colour missing one of them is how the 2.99:1 defect happened.
    const declared = new Set(tokensIn(blockAfter("@theme")));
    for (const tone of ["brand", "notice", "warning", "critical", "offline"]) {
      expect(declared, `${tone} solid`).toContain(`--color-${tone}`);
      expect(declared, `${tone}-contrast`).toContain(
        `--color-${tone}-contrast`,
      );
      expect(declared, `${tone}-ink`).toContain(`--color-${tone}-ink`);
      expect(declared, `${tone}-wash`).toContain(`--color-${tone}-wash`);
    }
  });
});

describe("component sources", () => {
  it("does not reach for the `dark:` variant", () => {
    // The variant is defined (index.css) for genuine exceptions, but semantic
    // tokens already absorb the theme difference — so a `dark:` in a component
    // almost always means a token is missing. Catching it here keeps that from
    // becoming the path of least resistance.
    const offenders = collectFiles(SRC, [".vue", ".ts"])
      .filter((file) => !file.endsWith(".css"))
      .filter((file) => /\bdark:[a-z[]/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(`${SRC}/`, ""));

    expect(offenders).toEqual([]);
  });

  it("builds class names as literals so Tailwind can see them", () => {
    // Tailwind scans source text. An interpolated `bg-${token}` generates no CSS
    // and fails silently — the element just has no background.
    const offenders = collectFiles(SRC, [".vue"])
      .filter((file) => {
        const body = readFileSync(file, "utf8").replace(
          /\/\*[\s\S]*?\*\//g,
          "",
        );
        return /["'`](?:bg|text|border|shadow|ring)-\$\{/.test(body);
      })
      .map((file) => file.replace(`${SRC}/`, ""));

    expect(offenders).toEqual([]);
  });
});
