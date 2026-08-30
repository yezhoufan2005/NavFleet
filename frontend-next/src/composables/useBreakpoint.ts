import { onScopeDispose, readonly, ref } from "vue";

/**
 * Viewport scale, matching `docs/frontend-ia.md` §3.3 and the `--breakpoint-*`
 * tokens in `styles/ramp.css`.
 *
 * The two ends are a tablet and a wall display, not a phone: a fleet console is
 * used at a duty desk, on a tablet during a walk of the floor, and on a mounted
 * screen. Nobody triages an AGV fault on a 375px phone, so there is no `sm` entry
 * here even though Tailwind still defines one.
 *
 * Layout should be done in CSS wherever it can be. This exists for the cases where
 * a *behavioural* difference depends on width — the sidebar becoming a modal
 * drawer is the one in the shell — because a media query cannot tell a focus trap
 * to switch on.
 */
export const BREAKPOINTS = {
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
  "3xl": 1920,
  wall: 2560,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

/**
 * Reactive `min-width` test for one breakpoint. Returns a readonly ref that is
 * `true` while the viewport is at least that wide.
 *
 * The listener is torn down with the owning scope. The v1.0.0 `useTheme` registered
 * a `matchMedia` listener and never removed it, which is harmless in a singleton
 * and wrong in something a component calls.
 */
export const useMinWidth = (name: BreakpointName) => {
  const query = `(min-width: ${BREAKPOINTS[name]}px)`;
  const supported =
    typeof window !== "undefined" && typeof window.matchMedia === "function";
  const media = supported ? window.matchMedia(query) : null;
  const matches = ref(media?.matches ?? true);

  if (media) {
    const onChange = (event: MediaQueryListEvent): void => {
      matches.value = event.matches;
    };
    media.addEventListener("change", onChange);
    onScopeDispose(() => media.removeEventListener("change", onChange));
  }

  return readonly(matches);
};
