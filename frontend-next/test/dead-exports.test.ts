import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * **Every export must have a non-test consumer.**
 *
 * This is the generalisation of the Phase 13 parity pass, and it is the one artefact from
 * it worth more than the fixes themselves. Reading 340 checklist rows by hand turned up
 * about thirty lost capabilities, and the single most reliable way to find them was not
 * reading the old UI — it was noticing that a symbol had been **declared and never
 * called**. The pattern held at three layers:
 *
 * | layer | dead declaration | the UI that was missing |
 * | --- | --- | --- |
 * | store | `sortedFormations` / `selectFormation` / `clearFormationSelection` | the formation filter, never built |
 * | store | `retryBootstrap` / `connectRealtime` | the offline self-rescue panel |
 * | composable | `cycleTheme` / `acknowledgedCount` / `clearAll` | a theme shortcut, two counts, two clear buttons |
 * | token | `--color-ros-lanelet-bg` / `--color-map-scale` | a lanelet backdrop, a scale bar |
 *
 * It was never a coincidence: **the logic layer was ported whole and the control that
 * drives it was left behind.** A human reading the diff cannot see that, because nothing
 * in the diff is wrong — the dead symbol looks exactly like a symbol that is about to be
 * used. A machine can see it trivially, which is why this file exists.
 *
 * ## What this does and does not catch
 *
 * It catches "declared, nobody calls it". It does **not** catch the mirror image, which
 * 13T-C ran into: an assertion written *tighter* than the contract because the feature was
 * missing when it was written (the `/^告警$/` nav matcher, anchored only because the badge
 * had been dropped). That one has no mechanical test yet.
 */

const SRC = resolve(__dirname, "../src");

/** Every `.ts` / `.vue` file under `src`, so a consumer anywhere counts. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });

/**
 * Comments are stripped before searching, and that is the substantive decision here.
 *
 * A name that appears **only** in a comment is not a consumer — it is documentation of
 * something that may or may not exist. That is not hypothetical: `stores/fleet.ts:106`
 * claimed "Views render skeletons while it is set" for the whole of Phase 13 while no
 * skeleton component existed. Counting prose as usage would have let exactly that through.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

interface Module {
  /** Path relative to `src`, for the failure message. */
  file: string;
  /** The names it publishes. */
  names: string[];
}

/** `export const x` / `export function x` / `export interface x` … */
const EXPORT_PATTERN =
  /export\s+(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

const exportedNames = (source: string): string[] => {
  const clean = stripComments(source);
  const names = new Set<string>();
  for (const match of clean.matchAll(EXPORT_PATTERN)) names.add(match[1]!);
  return [...names];
};

/**
 * The store's public surface is the object its setup function returns, not its ES exports,
 * so it is read out of that `return { … }` block.
 *
 * Deliberately textual rather than importing the store and enumerating keys at runtime:
 * `Object.keys` on a Pinia store also yields Pinia's own members, and telling those apart
 * from ours would mean maintaining a list of framework internals that changes when Pinia
 * does. The `return` block is the thing a reviewer would look at anyway.
 */
const storeSurface = (): Module => {
  const file = "stores/fleet.ts";
  const source = stripComments(readFileSync(join(SRC, file), "utf8"));
  const block = source.match(/\n {2}return \{([^}]*)\};\s*\}\);/);
  if (!block) {
    throw new Error(
      "could not find the store's `return { … }` block — this test needs updating",
    );
  }
  const names = block[1]!
    .split(",")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line));
  return { file, names };
};

const composableSurfaces = (): Module[] =>
  readdirSync(join(SRC, "composables"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => {
      const file = join("composables", name);
      return {
        file,
        names: exportedNames(readFileSync(join(SRC, file), "utf8")),
      };
    });

/**
 * What a composable hands back, which is **not** the same as what it exports.
 *
 * This is where the pattern actually lived. `cycleTheme`, `acknowledgedCount` and
 * `clearAll` were never ES exports — they were keys on the object `useTheme()` /
 * `useAlertAck()` returns, so a check that reads only `export` statements walks straight
 * past the three clearest examples the parity pass found. Every `return { … }` block in
 * the file is collected, for the same reason the store's is.
 */
const RETURN_BLOCK = /return \{([^}]*)\}/g;

const returnedSurfaces = (): Module[] =>
  readdirSync(join(SRC, "composables"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => {
      const file = join("composables", name);
      const source = stripComments(readFileSync(join(SRC, file), "utf8"));
      const names = new Set<string>();
      for (const block of source.matchAll(RETURN_BLOCK)) {
        for (const entry of block[1]!.split(",")) {
          const key = entry.trim();
          // Shorthand keys only. `dismiss: dismissNotification` names an alias whose own
          // definition is checked as an export; asserting on the alias too would demand a
          // consumer for a name that exists purely to read better at the call site.
          if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
        }
      }
      return { file, names: [...names] };
    });

/**
 * Exemptions, each of which is a decision rather than a shrug.
 *
 * Keep this list short and keep the reason attached. An entry here says "this symbol has
 * no product consumer **and that is correct**"; anything else belongs in the product or in
 * the bin.
 */
const ALLOWED = new Map<string, string>([
  /*
   * Storage keys, exported so a test asserts the *real* key rather than a copy of the
   * string. A copy is the failure this prevents: renaming the key would leave stored
   * state orphaned with every test still green.
   */
  ["ALERT_ACK_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["DEVICE_LAYOUT_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["MAP_SURFACE_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["ROS_VIEW_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["SIDEBAR_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["THEME_STORAGE_KEY", "tests assert the real key, not a copy"],
  ["ALERT_SOUND_KEYS", "tests assert the real keys, not copies"],
  /*
   * Tuned numbers, same reasoning: a test that hardcodes 40 or 250 stops testing the
   * threshold the moment someone changes it.
   */
  [
    "MAP_READABLE_LIMIT",
    "the 40-unit map/list threshold, asserted at its own value",
  ],
  ["SOUND_THROTTLE_MS", "asserted at its own value"],
  ["VIEW_FLUSH_DELAY_MS", "asserted at its own value"],
  ["AUTH_REFRESH_INTERVAL_MS", "asserted at its own value"],
  ["AUTH_RETRY_DELAYS_MS", "asserted at its own value"],
  ["NIGHT_WINDOW", "the quiet-hours window, asserted at its own value"],
  /*
   * Pure functions lifted out so the tricky arithmetic can be tested directly rather than
   * through the component that calls it. Their product consumer is their own module.
   */
  ["isQuietAt", "midnight-wrapping window arithmetic, tested directly"],
  ["delayFor", "playback speed → ms, tested directly"],
  /*
   * The store's ingest path. Not a public API — the product feeds the store from the
   * bootstrap and the socket — but tests need a way to put a fleet in front of a view
   * without standing up either.
   */
  ["ingestPayload", "test seam: seeds a fleet without a backend or a socket"],
]);

/**
 * `__`-prefixed exports are test seams by convention, so they are exempt without an
 * entry each. The prefix is the declaration: module-level singletons leak between test
 * files, and every one of these exists to reset one.
 */
const isTestSeam = (name: string): boolean => name.startsWith("__");

/** Names that are types rather than values — absence of a call site means nothing. */
const isTypeOnly = (file: string, name: string): boolean =>
  new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`).test(
    readFileSync(join(SRC, file), "utf8"),
  );

describe("every export has a non-test consumer", () => {
  const files = sourceFiles(SRC);
  const bodies = new Map(
    files.map((path) => [
      relative(SRC, path),
      stripComments(readFileSync(path, "utf8")),
    ]),
  );

  /**
   * The same bodies with whitespace collapsed, for the destructure arm below.
   *
   * A composable's members are almost always taken out in a multi-line destructure, so a
   * single-line pattern reported eighteen live symbols as dead on the first run. Collapsing
   * first keeps the pattern bounded to one object literal (`[^}]*` cannot cross a closing
   * brace) without it having to know how the call was formatted.
   */
  const flatBodies = new Map(
    [...bodies].map(([file, body]) => [file, body.replace(/\s+/g, " ")]),
  );

  /**
   * Two matchers, because a store member and a module export are reached differently —
   * and the difference is not cosmetic.
   *
   * A store member is only ever read as `fleet.thing` or destructured out of
   * `storeToRefs`. Searching for the bare identifier makes the store's four redundant
   * re-exports (`getDeviceTone` / `hasPose` / `round` / `formatDateTime`) look alive:
   * every component that needs them imports the same names straight from
   * `@navfleet/fleet-core`, so the word is all over `src` while **nothing goes through
   * the store**. That is a false negative in exactly the place this test is meant to be
   * sharp, so store members are matched on property access.
   *
   * The receiver is pinned to `fleet` — the name every consumer in `src` binds
   * `useFleetStore()` to — rather than any dot. A bare `\.round\b` matches `Math.round`,
   * which is how `round` slipped through the first version of this check: a *property*
   * matcher still needs to know whose property it is.
   */
  const consumersOf = (
    name: string,
    definedIn: string,
    via: "property" | "identifier" | "member",
  ): string[] => {
    const pattern =
      via === "property"
        ? new RegExp(
            `\\bfleet\\s*\\.\\s*${name}\\b|storeToRefs[^\\n]*\\b${name}\\b`,
          )
        : via === "member"
          ? // A composable's receiver is named by its caller (`sound`, `ack`, `view`), so
            // there is no one name to pin the way `fleet` can be. Property access or a
            // destructure, and collisions stay possible — they make this arm too
            // permissive rather than wrong, which is the safe direction for a gate.
            new RegExp(`\\.\\s*${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`)
          : new RegExp(`\\b${name}\\b`);
    return [...(via === "member" ? flatBodies : bodies)]
      .filter(([file]) => file !== definedIn)
      .filter(([, body]) => pattern.test(body))
      .map(([file]) => file);
  };

  const check = (
    modules: Module[],
    via: "property" | "identifier" | "member" = "identifier",
  ): string[] =>
    modules.flatMap(({ file, names }) =>
      names
        .filter((name) => !ALLOWED.has(name) && !isTestSeam(name))
        .filter((name) => !isTypeOnly(file, name))
        .filter((name) => consumersOf(name, file, via).length === 0)
        .map((name) => `${file} → ${name}`),
    );

  it("holds for the fleet store", () => {
    // Twelve of these were dead when the parity pass found them, and eight of the twelve
    // were the fingerprint of a control that had never been built.
    expect(check([storeSurface()], "property")).toEqual([]);
  });

  it("holds for what every composable hands back", () => {
    // The tier that matters most: `cycleTheme`, `acknowledgedCount` and `clearAll` were
    // all keys on a returned object rather than ES exports, so a check that reads only
    // `export` statements walks past the three clearest cases the parity pass found.
    expect(check(returnedSurfaces(), "member")).toEqual([]);
  });

  it("holds for every composable", () => {
    // `cycleTheme`, `acknowledgedCount`, `clearAll` and `clearSavedSceneViews` were all
    // dead here. Three were deleted and one was wired up; this is what keeps the next one
    // from lasting a whole phase.
    expect(check(composableSurfaces())).toEqual([]);
  });
});
