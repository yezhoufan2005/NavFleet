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

/**
 * Sockets opened during a test, newest last.
 *
 * jsdom's own `WebSocket` really tries to connect, so leaving it in place would
 * have every test that signs in reach for `ws://localhost/ws` and report the
 * failure as an unhandled error from whichever test happened to be running.
 *
 * Driveable rather than merely inert: whether the top bar says 连接中 or 实时 is
 * decided by the socket reaching OPEN, and a stub that can never open would let the
 * indicator's two most common states go untested. `realtime.test.ts` has its own
 * richer fake — that one is injected into the link directly and drives timers; this
 * one only has to stand in for the global.
 */
export interface StubSocket {
  url: string;
  closed: boolean;
  /** Fire `open`, as a server accepting the connection would. */
  accept: () => void;
  /** Fire `close`, as a server going away would. */
  drop: () => void;
  /** Push one frame, JSON-encoded like the backend's. */
  deliver: (payload: unknown) => void;
}

export const openedSockets: StubSocket[] = [];

class DriveableWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = DriveableWebSocket.CONNECTING;

  private readonly listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();

  constructor(readonly url: string) {
    openedSockets.push({
      url,
      closed: false,
      accept: () => {
        this.readyState = DriveableWebSocket.OPEN;
        this.emit("open");
      },
      drop: () => {
        this.readyState = 3;
        this.emit("close");
      },
      deliver: (payload: unknown) => {
        this.emit("message", { data: JSON.stringify(payload) });
      },
    });
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {}
  send(): void {}

  close(): void {
    this.readyState = 3;
    const record = openedSockets.find((entry) => entry.url === this.url);
    if (record) record.closed = true;
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Accept the most recently opened socket, so the link reports `open`. */
export const acceptLastSocket = (): StubSocket => {
  const socket = openedSockets.at(-1);
  if (!socket) throw new Error("no socket was opened");
  socket.accept();
  return socket;
};

beforeEach(() => {
  viewportWidth = 1440;
  prefersDark = false;
  listeners.clear();
  openedSockets.length = 0;
  // `tokens.test.ts` runs in the node environment on purpose — it reads CSS off
  // disk and never touches a document — so none of the browser globals exist
  // there. The stubs are for the jsdom files only.
  if (typeof window === "undefined") return;
  localStorage.clear();
  install();
  vi.stubGlobal("WebSocket", DriveableWebSocket);
});

if (typeof window !== "undefined") {
  install();
  vi.stubGlobal("WebSocket", DriveableWebSocket);
}
