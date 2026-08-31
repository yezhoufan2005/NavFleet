import { effectScope, readonly, ref, watchEffect } from "vue";

/**
 * Theme preference, kept compatible on purpose.
 *
 * The storage key and the three allowed values are identical to the v1.0.0
 * frontend's (`composables/useTheme.ts`), so a person who has already chosen a
 * theme there does not have to choose again here — the two consoles run side by
 * side for the whole of Phase 12–13, and having them disagree about dark mode
 * would be a small papercut on every switch between them.
 *
 * Differences from the old one, both deliberate:
 *
 * - `resolved` is derived rather than assigned, so there is no window in which
 *   the reactive state and the DOM attribute disagree.
 * - The `matchMedia` listener is torn down. The old one registered it and never
 *   removed it, which is harmless in a singleton but wrong to copy forward.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "navfleet:theme";
const PREFERENCES: readonly ThemePreference[] = ["dark", "light", "system"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

const media = (): MediaQueryList | null =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(DARK_QUERY);

const readStored = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && (PREFERENCES as readonly string[]).includes(stored)
      ? (stored as ThemePreference)
      : "system";
  } catch {
    return "system";
  }
};

const preference = ref<ThemePreference>(readStored());
const systemPrefersDark = ref(media()?.matches ?? false);

/** What the page is actually showing, whichever way the preference got there. */
const resolved = ref<ResolvedTheme>("light");

let started = false;

/**
 * Detached scope, and this matters more than it looks.
 *
 * `watchEffect` called during a component's setup belongs to that component and
 * stops when it unmounts. The first caller of `useTheme()` therefore used to own
 * the effect that writes `data-theme` — and the first caller is the session menu,
 * which unmounts on sign-out. The theme would keep switching until someone logged
 * out, and silently stop afterwards. An unowned scope makes the singleton's
 * lifetime actually match the singleton's state.
 */
const scope = effectScope(true);

const start = (): void => {
  if (started) return;
  started = true;

  const query = media();
  const onChange = (event: MediaQueryListEvent): void => {
    systemPrefersDark.value = event.matches;
  };
  query?.addEventListener("change", onChange);
  // Nothing unmounts this singleton in the app, but a test that imports the
  // module twice would otherwise stack listeners.
  if (typeof window !== "undefined") {
    window.addEventListener(
      "beforeunload",
      () => query?.removeEventListener("change", onChange),
      {
        once: true,
      },
    );
  }

  scope.run(() => {
    watchEffect(() => {
      const next: ResolvedTheme =
        preference.value === "system"
          ? systemPrefersDark.value
            ? "dark"
            : "light"
          : preference.value;
      resolved.value = next;

      if (typeof document === "undefined") return;
      const root = document.documentElement;
      // "system" removes the attribute rather than stamping a value: that is what
      // lets `prefers-color-scheme` win, and it is the state the inline script in
      // index.html leaves behind for a viewer who has never chosen.
      if (preference.value === "system") delete root.dataset.theme;
      else root.dataset.theme = preference.value;
    });
  });
};

export const useTheme = () => {
  start();

  const setPreference = (next: ThemePreference): void => {
    preference.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable; the in-memory preference still applies for this tab.
    }
  };

  /*
   * No `cycleTheme`. It existed for the header's one-tap toggle, which 11C replaced with
   * three explicit options in the session menu — a better control, because a cycling
   * button cannot say what the next tap will select. The function outlived the button and
   * sat here with no caller for the whole of Phase 13.
   */
  return {
    preference: readonly(preference),
    resolved: readonly(resolved),
    setPreference,
  };
};

/** Test-only reset for the module singleton, including the stamped attribute. */
export const __resetTheme = (): void => {
  preference.value = "system";
  systemPrefersDark.value = false;
  if (typeof document !== "undefined")
    delete document.documentElement.dataset.theme;
};

export const THEME_STORAGE_KEY = STORAGE_KEY;
