/**
 * History playback composable: cursor stepping, play/pause, speed re-timing and
 * timer cleanup.
 *
 * `useHistoryPlayback` registers `onBeforeUnmount`, so every case runs it inside
 * a throwaway component (`mountPlayback`) — that is also what makes the
 * "no timer survives unmount" assertion meaningful. Timers are faked so an
 * interval step is `advanceTimersByTime`, not a real 600ms wait.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useHistoryPlayback } from "../../src/composables/useHistoryPlayback";
import type {
  HistorySample,
  UseHistoryPlaybackResult,
} from "../../src/composables/useHistoryPlayback";

/** Interval at 1x; 2x halves it, and the floor is 80ms. */
const STEP_MS = 600;

const makeSamples = (count: number): HistorySample[] =>
  Array.from({ length: count }, (_, index) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    measurements: { fusionLoc: { x: index, y: index, yaw: 0 } },
  }));

/**
 * Mounts the composable in a render-nothing component and optionally loads a
 * track, so cases start from "samples ready, cursor at 0".
 */
const mountPlayback = (
  sampleCount = 0,
): { playback: UseHistoryPlaybackResult; unmount: () => void } => {
  let captured: UseHistoryPlaybackResult | null = null;
  const wrapper = mount(
    defineComponent({
      name: "PlaybackHost",
      setup() {
        captured = useHistoryPlayback();
        return () => h("div");
      },
    }),
  );
  const playback = captured as UseHistoryPlaybackResult | null;
  if (!playback) {
    throw new Error("useHistoryPlayback did not run in setup");
  }
  if (sampleCount) {
    playback.setSamples(makeSamples(sampleCount));
  }
  return { playback, unmount: () => wrapper.unmount() };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useHistoryPlayback loading samples", () => {
  it("starts empty with no progress and no current sample", () => {
    const { playback } = mountPlayback();

    expect(playback.samples.value).toEqual([]);
    expect(playback.cursor.value).toBe(0);
    expect(playback.playing.value).toBe(false);
    expect(playback.currentSample.value).toBeNull();
    expect(playback.progressLabel.value).toBe("0 / 0");
  });

  it("exposes the loaded track and rewinds the cursor", () => {
    const { playback } = mountPlayback(3);
    playback.cursor.value = 2;

    playback.setSamples(makeSamples(5));

    expect(playback.samples.value).toHaveLength(5);
    expect(playback.cursor.value).toBe(0);
    expect(playback.currentSample.value).toEqual(playback.samples.value[0]);
    expect(playback.progressLabel.value).toBe("1 / 5");
  });
});

describe("useHistoryPlayback play and pause", () => {
  it("advances the cursor once per interval while playing", () => {
    const { playback } = mountPlayback(4);

    playback.togglePlay();
    expect(playback.playing.value).toBe(true);
    expect(playback.cursor.value).toBe(0);

    vi.advanceTimersByTime(STEP_MS - 1);
    expect(playback.cursor.value).toBe(0);

    vi.advanceTimersByTime(1);
    expect(playback.cursor.value).toBe(1);
    expect(playback.progressLabel.value).toBe("2 / 4");

    vi.advanceTimersByTime(STEP_MS);
    expect(playback.cursor.value).toBe(2);
    expect(playback.currentSample.value).toEqual(playback.samples.value[2]);
  });

  it("does nothing when there are no samples", () => {
    const { playback } = mountPlayback();

    playback.togglePlay();

    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STEP_MS * 5);
    expect(playback.cursor.value).toBe(0);
  });

  it("pauses on the current sample and drops the timer", () => {
    const { playback } = mountPlayback(4);
    playback.togglePlay();
    vi.advanceTimersByTime(STEP_MS);

    playback.togglePlay();

    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STEP_MS * 3);
    expect(playback.cursor.value).toBe(1);
  });

  it("stops playing when it reaches the last sample", () => {
    const { playback } = mountPlayback(3);

    playback.togglePlay();
    vi.advanceTimersByTime(STEP_MS * 2);

    expect(playback.cursor.value).toBe(2);
    expect(playback.playing.value).toBe(true);

    // The step that finds the cursor already parked on the last sample stops it.
    vi.advanceTimersByTime(STEP_MS);
    expect(playback.cursor.value).toBe(2);
    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays from the start when the cursor is parked on the last sample", () => {
    const { playback } = mountPlayback(3);
    playback.cursor.value = 2;

    playback.togglePlay();

    expect(playback.cursor.value).toBe(0);
    expect(playback.playing.value).toBe(true);

    vi.advanceTimersByTime(STEP_MS);
    expect(playback.cursor.value).toBe(1);
  });
});

describe("useHistoryPlayback restart", () => {
  it("stops playback and rewinds to the first sample", () => {
    const { playback } = mountPlayback(4);
    playback.togglePlay();
    vi.advanceTimersByTime(STEP_MS * 2);
    expect(playback.cursor.value).toBe(2);

    playback.restart();

    expect(playback.cursor.value).toBe(0);
    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STEP_MS * 3);
    expect(playback.cursor.value).toBe(0);
  });
});

describe("useHistoryPlayback speed", () => {
  it("re-times a running interval at the new rate", async () => {
    const { playback } = mountPlayback(10);
    playback.togglePlay();
    vi.advanceTimersByTime(STEP_MS);
    expect(playback.cursor.value).toBe(1);

    playback.speed.value = 2;
    await nextTick();

    expect(playback.playing.value).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(STEP_MS / 2 - 1);
    expect(playback.cursor.value).toBe(1);

    vi.advanceTimersByTime(1);
    expect(playback.cursor.value).toBe(2);

    vi.advanceTimersByTime(STEP_MS / 2);
    expect(playback.cursor.value).toBe(3);
  });

  it("never steps faster than the 80ms floor", async () => {
    const { playback } = mountPlayback(10);
    playback.speed.value = 40; // 600 / 40 = 15ms, clamped to 80ms
    await nextTick();
    playback.togglePlay();

    vi.advanceTimersByTime(79);
    expect(playback.cursor.value).toBe(0);

    vi.advanceTimersByTime(1);
    expect(playback.cursor.value).toBe(1);
  });

  it("leaves a paused timeline paused", async () => {
    const { playback } = mountPlayback(10);

    playback.speed.value = 4;
    await nextTick();

    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STEP_MS * 5);
    expect(playback.cursor.value).toBe(0);
  });
});

describe("useHistoryPlayback cleanup", () => {
  it("clears the interval on unmount", () => {
    const { playback, unmount } = mountPlayback(10);
    playback.togglePlay();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(playback.playing.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const parked = playback.cursor.value;
    vi.advanceTimersByTime(STEP_MS * 5);
    expect(playback.cursor.value).toBe(parked);
  });
});
