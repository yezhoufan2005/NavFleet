import { reactive, readonly } from "vue";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "navfleet:theme";

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const media = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

const readStoredPreference = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (private mode) — fall back to system.
  }
  return "system";
};

const resolve = (preference: ThemePreference): ResolvedTheme => {
  if (preference === "system") {
    return media()?.matches ? "dark" : "light";
  }
  return preference;
};

const state = reactive<ThemeState>({
  preference: "system",
  resolved: "dark",
});

let initialized = false;

const apply = () => {
  state.resolved = resolve(state.preference);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = state.resolved;
    document.documentElement.style.colorScheme = state.resolved;
  }
};

const setPreference = (preference: ThemePreference) => {
  state.preference = preference;
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Ignore persistence failures.
  }
  apply();
};

/** Cycle dark -> light -> system -> dark for a single toggle control. */
const cycleTheme = () => {
  const order: ThemePreference[] = ["dark", "light", "system"];
  const next = order[(order.indexOf(state.preference) + 1) % order.length];
  setPreference(next);
};

export function useTheme() {
  if (!initialized) {
    initialized = true;
    state.preference = readStoredPreference();
    apply();
    const mq = media();
    // Track system changes only while in "system" mode.
    mq?.addEventListener?.("change", () => {
      if (state.preference === "system") {
        apply();
      }
    });
  }
  return { state: readonly(state), setPreference, cycleTheme };
}
