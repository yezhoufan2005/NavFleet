import { beforeEach, vi } from "vitest";

/**
 * jsdom gaps that every suite needs closed the same way.
 *
 * `matchMedia` exists in jsdom but always reports `matches: false` and has no way
 * to change its answer. Two things in the shell read it — the theme's
 * `prefers-color-scheme` and the sidebar's `lg` breakpoint — and both would
 * otherwise silently take the wrong branch: a default `false` for `min-width:
 * 1024px` means every component test would render the tablet drawer instead of the
 * rail, so `nav` would not be in the document and the failures would point
 * anywhere but here.
 *
 * The stub answers from a settable viewport width instead, which lets a test say
 * "now we are on a tablet" and get the behaviour that follows from it.
 */
const MIN_WIDTH = /\(min-width:\s*(\d+)px\)/;

let viewportWidth = 1440;
let prefersDark = false;

type Listener = (event: MediaQueryListEvent) => void;
const listeners = new Set<{ query: string; listener: Listener }>();

const evaluate = (query: string): boolean => {
  const minWidth = MIN_WIDTH.exec(query);
  if (minWidth?.[1]) return viewportWidth >= Number(minWidth[1]);
  if (query.includes("prefers-color-scheme: dark")) return prefersDark;
  return false;
};

const install = (): void => {
  // jsdom has no layout, so `scrollTo` throws "Not implemented" and the router's
  // scroll restoration prints a stack on every navigation. Stubbing it keeps the
  // output readable — a real failure should be the only noise in a test run.
  vi.stubGlobal("scrollTo", vi.fn());
  // Reka UI's floating layers (the session menu, the drawer) observe their
  // trigger's box. jsdom ships neither observer, and without them mounting the
  // shell throws rather than failing an assertion.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = (): void => undefined;
      unobserve = (): void => undefined;
      disconnect = (): void => undefined;
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = (): void => undefined;
      unobserve = (): void => undefined;
      disconnect = (): void => undefined;
      takeRecords = (): [] => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    },
  );
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        media: query,
        get matches() {
          return evaluate(query);
        },
        onchange: null,
        addEventListener: (_type: string, listener: Listener) => {
          listeners.add({ query, listener });
        },
        removeEventListener: (_type: string, listener: Listener) => {
          for (const entry of listeners) {
            if (entry.listener === listener) listeners.delete(entry);
          }
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
};

/** Move the viewport and notify whoever is listening, as a real browser would. */
export const setViewportWidth = (width: number): void => {
  viewportWidth = width;
  for (const { query, listener } of listeners) {
    listener({ matches: evaluate(query), media: query } as MediaQueryListEvent);
  }
};

export const setPrefersDark = (value: boolean): void => {
  prefersDark = value;
  for (const { query, listener } of listeners) {
    listener({ matches: evaluate(query), media: query } as MediaQueryListEvent);
  }
};

beforeEach(() => {
  viewportWidth = 1440;
  prefersDark = false;
  listeners.clear();
  // `tokens.test.ts` runs in the node environment on purpose — it reads CSS off
  // disk and never touches a document — so none of the browser globals exist
  // there. The stubs are for the jsdom files only.
  if (typeof window === "undefined") return;
  localStorage.clear();
  install();
});

if (typeof window !== "undefined") install();
