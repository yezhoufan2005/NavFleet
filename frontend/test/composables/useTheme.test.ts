/**
 * Theme composable: preference cycle, the `data-theme` attribute written to the
 * document root, and localStorage persistence (including unavailable storage).
 *
 * The composable keeps module-level state and initializes itself on first use, so
 * every case re-imports it after `vi.resetModules()`. jsdom has no `matchMedia`,
 * so the OS preference is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type ThemeModule = typeof import("../../src/composables/useTheme");

const STORAGE_KEY = "navfleet:theme";

type MediaChangeListener = () => void;

let systemPrefersDark = false;
let mediaChangeListeners: MediaChangeListener[] = [];

const stubMatchMedia = (): void => {
  mediaChangeListeners = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return systemPrefersDark;
      },
      addEventListener: (_type: string, handler: MediaChangeListener) => {
        mediaChangeListeners.push(handler);
      },
      removeEventListener: () => {},
    })),
  );
};

const loadTheme = async (): Promise<ThemeModule> => {
  vi.resetModules();
  return import("../../src/composables/useTheme");
};

const documentTheme = (): string | undefined => document.documentElement.dataset.theme;

beforeEach(() => {
  systemPrefersDark = false;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  stubMatchMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTheme initialization", () => {
  it("defaults to the system preference and writes the resolved theme to the document", async () => {
    const { useTheme } = await loadTheme();

    const theme = useTheme();

    expect(theme.state.preference).toBe("system");
    expect(theme.state.resolved).toBe("light");
    expect(documentTheme()).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("resolves the system preference to dark when the OS asks for dark", async () => {
    systemPrefersDark = true;
    const { useTheme } = await loadTheme();

    const theme = useTheme();

    expect(theme.state.resolved).toBe("dark");
    expect(documentTheme()).toBe("dark");
  });

  it("restores an explicit stored preference over the OS setting", async () => {
    systemPrefersDark = true;
    localStorage.setItem(STORAGE_KEY, "light");
    const { useTheme } = await loadTheme();

    const theme = useTheme();

    expect(theme.state.preference).toBe("light");
    expect(theme.state.resolved).toBe("light");
    expect(documentTheme()).toBe("light");
  });

  it("ignores an unrecognised stored value", async () => {
    localStorage.setItem(STORAGE_KEY, "neon");
    const { useTheme } = await loadTheme();

    expect(useTheme().state.preference).toBe("system");
  });

  it("falls back to the system preference when storage reads throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const { useTheme } = await loadTheme();

    const theme = useTheme();

    expect(theme.state.preference).toBe("system");
    expect(documentTheme()).toBe("light");
  });
});

describe("useTheme preference changes", () => {
  it("persists an explicit preference and applies it to the document", async () => {
    const { useTheme } = await loadTheme();
    const theme = useTheme();

    theme.setPreference("dark");

    expect(theme.state.preference).toBe("dark");
    expect(theme.state.resolved).toBe("dark");
    expect(documentTheme()).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("cycles dark -> light -> system", async () => {
    const { useTheme } = await loadTheme();
    const theme = useTheme();
    expect(theme.state.preference).toBe("system");

    theme.cycleTheme();
    expect(theme.state.preference).toBe("dark");
    expect(documentTheme()).toBe("dark");

    theme.cycleTheme();
    expect(theme.state.preference).toBe("light");
    expect(documentTheme()).toBe("light");

    theme.cycleTheme();
    expect(theme.state.preference).toBe("system");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  });

  it("still applies the theme when storage writes throw", async () => {
    const { useTheme } = await loadTheme();
    const theme = useTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => theme.setPreference("dark")).not.toThrow();

    expect(theme.state.preference).toBe("dark");
    expect(documentTheme()).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("follows OS changes only while the preference is system", async () => {
    const { useTheme } = await loadTheme();
    const theme = useTheme();
    expect(mediaChangeListeners).toHaveLength(1);

    systemPrefersDark = true;
    mediaChangeListeners.forEach((listener) => listener());
    expect(theme.state.resolved).toBe("dark");
    expect(documentTheme()).toBe("dark");

    theme.setPreference("light");
    systemPrefersDark = false;
    mediaChangeListeners.forEach((listener) => listener());
    expect(theme.state.resolved).toBe("light");

    systemPrefersDark = true;
    mediaChangeListeners.forEach((listener) => listener());
    expect(theme.state.resolved).toBe("light");
    expect(documentTheme()).toBe("light");
  });
});
