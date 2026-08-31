import { onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";

/**
 * A text input whose value the caller commits somewhere expensive.
 *
 * ## The problem this solves
 *
 * 告警's filters live in the query string on purpose — a pasted link has to reproduce
 * the view, and keeping a second copy in `ref`s is how the two drift. But the search box
 * shares that mechanism, so **every keystroke was a `router.replace`**: eight characters
 * meant eight navigations, each re-running every filter computed and rewriting the URL.
 * The old parity checklist filed this as 🟡 "add a debounce" and it was never done.
 *
 * Debouncing alone is not enough, because the URL is also the *source* of the input's
 * value. If the box reads straight from the query string, a debounced write means the
 * caret sits in a field that does not update as you type. So the draft has to be local
 * while an edit is in flight, and the committed value has to win at every other moment.
 *
 * ## How the two directions are kept apart
 *
 * `lastCommitted` is the whole trick. When `source` changes to something this composable
 * did **not** just write — the back button, a reset, another control clearing filters —
 * that is an external change and it overwrites the draft. When `source` changes *to* the
 * value we committed, it is our own echo and is ignored, so the draft is never clobbered
 * mid-word by our own navigation.
 *
 * @param source  the committed value, typically read from the route
 * @param commit  called with the draft once it settles; may navigate
 * @param delayMs how long to wait after the last keystroke
 */
export function useDebouncedText(
  source: () => string,
  commit: (value: string) => void,
  delayMs = 250,
): {
  draft: Ref<string>;
  onInput: (value: string) => void;
  /** Commit now — for Enter, or a blur that should not wait out the timer. */
  flush: () => void;
} {
  const draft = ref(source());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCommitted = source();

  const clear = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = (): void => {
    clear();
    if (draft.value === lastCommitted) return;
    lastCommitted = draft.value;
    commit(draft.value);
  };

  const onInput = (value: string): void => {
    draft.value = value;
    clear();
    timer = setTimeout(flush, delayMs);
  };

  watch(source, (next) => {
    // Our own echo — the draft is already this, or ahead of it.
    if (next === lastCommitted) return;
    lastCommitted = next;
    clear();
    draft.value = next;
  });

  // A pending keystroke must not fire into a component that has gone away; committing
  // navigates, so a late timer would move the URL of whatever page replaced this one.
  onBeforeUnmount(clear);

  return { draft, onInput, flush };
}
