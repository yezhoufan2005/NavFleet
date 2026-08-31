import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { useDebouncedText } from "@/composables/useDebouncedText";

/**
 * The debounce behind 告警's search box.
 *
 * The interesting cases are not "does it wait" — they are the two directions crossing:
 * the URL is the source of truth *and* the thing being written, so a naive debounce
 * either freezes the caret or clobbers a half-typed word with its own echo.
 */
enableAutoUnmount(afterEach);

/** Mounted, because the composable registers `onBeforeUnmount`. */
const harness = (initial = "", delayMs = 250) => {
  const source = ref(initial);
  const commit = vi.fn((value: string) => {
    source.value = value;
  });
  let api: ReturnType<typeof useDebouncedText> | null = null;

  const wrapper = mount(
    defineComponent({
      setup() {
        api = useDebouncedText(() => source.value, commit, delayMs);
        return () => h("div");
      },
    }),
  );

  return { wrapper, api: api!, source, commit };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("committing", () => {
  it("waits for the typing to stop rather than firing per keystroke", () => {
    // Eight characters used to mean eight `router.replace` calls, each re-running every
    // filter computed and rewriting the URL.
    const { api, commit } = harness();

    for (const char of "agv-01") {
      api.onInput(char);
      vi.advanceTimersByTime(50);
    }
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("1");
  });

  it("shows every keystroke immediately, because the draft is local", () => {
    // If the box read straight from the committed value, the caret would sit in a field
    // that does not change as you type.
    const { api } = harness();

    api.onInput("ag");
    expect(api.draft.value).toBe("ag");
    api.onInput("agv");
    expect(api.draft.value).toBe("agv");
  });

  it("commits on demand, for Enter", () => {
    const { api, commit } = harness();
    api.onInput("agv");

    api.flush();

    expect(commit).toHaveBeenCalledWith("agv");
    // And the pending timer is gone, so it does not fire a second time.
    vi.advanceTimersByTime(500);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does not commit a value that is already committed", () => {
    const { api, commit } = harness("agv");
    api.onInput("agv");
    vi.advanceTimersByTime(250);

    expect(commit).not.toHaveBeenCalled();
  });
});

describe("the two directions crossing", () => {
  it("ignores its own echo, so a commit cannot clobber the next keystroke", () => {
    // `commit` writes to `source`, which the watcher sees. Without the `lastCommitted`
    // check that write reads as an external change and resets the draft — mid-word.
    const { api, source } = harness();

    api.onInput("agv");
    vi.advanceTimersByTime(250);
    expect(source.value).toBe("agv");

    api.onInput("agv-0");
    expect(api.draft.value).toBe("agv-0");
  });

  it("lets an outside change win, because that is the back button", async () => {
    // A reset, another control clearing filters, or history navigation. The draft is
    // stale by definition in that case.
    const { api, source } = harness("agv");

    api.onInput("agv-9");
    source.value = "";
    // `watch` is a microtask, which in the real thing runs long before the 250ms timer.
    // The fake clock does not advance microtasks, so the test has to say so explicitly —
    // asserting synchronously here would be asserting an ordering the app never sees.
    await nextTick();

    expect(api.draft.value).toBe("");
  });

  it("drops a pending keystroke when an outside change lands", async () => {
    // Otherwise the timer fires after the reset and puts the abandoned word back.
    const { api, source, commit } = harness("agv");

    api.onInput("agv-9");
    source.value = "";
    await nextTick();
    vi.advanceTimersByTime(500);

    expect(commit).not.toHaveBeenCalled();
    expect(api.draft.value).toBe("");
  });
});

describe("teardown", () => {
  it("does not navigate after the component is gone", () => {
    // Committing navigates, so a late timer would move the URL of whatever page replaced
    // this one — which looks like the app spontaneously filtering something else.
    const { wrapper, api, commit } = harness();
    api.onInput("agv");

    wrapper.unmount();
    vi.advanceTimersByTime(500);

    expect(commit).not.toHaveBeenCalled();
  });
});
