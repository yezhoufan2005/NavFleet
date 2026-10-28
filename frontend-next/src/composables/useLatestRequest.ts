import { getCurrentInstance, onBeforeUnmount } from "vue";

/**
 * Only the newest load may land.
 *
 * A view that re-queries as its filters or route change can have two requests in flight, and the
 * older one may answer last: a slow response for the device you navigated away from, or for the
 * filter you already replaced, would overwrite what is on screen. Each load calls `begin()` and
 * checks the returned `isCurrent()` after every `await`; starting a newer load makes every earlier
 * one stale. Called inside a component, unmounting makes them all stale, so nothing lands on a view
 * that is gone.
 *
 * Seven views kept this as a hand-rolled `let requestId = 0` counter, each with its own unmount
 * bump; the pattern is the same everywhere, so it lives here.
 */
export const useLatestRequest = (): { begin: () => () => boolean } => {
  let latest = 0;
  const begin = (): (() => boolean) => {
    const id = (latest += 1);
    return () => id === latest;
  };
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      latest += 1;
    });
  }
  return { begin };
};
