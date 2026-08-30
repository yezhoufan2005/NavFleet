import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import {
  PLAYBACK_SPEEDS,
  delayFor,
  useHistoryPlayback,
} from "@/composables/useHistoryPlayback";
import type {
  HistorySample,
  TrailPoint,
} from "@/composables/useHistoryPlayback";

/**
 * Playback, and mostly the trail — because the trail is where v1.0.0's one confirmed
 * frontend performance defect was: the whole prefix re-extracted on every tick, with a
 * fresh object literal each time, against a 5000-sample ceiling.
 *
 * The performance tests count **how many times `poseOf` is called** rather than timing
 * anything. A duration assertion on a shared CI runner measures the runner; a call
 * count measures the algorithm, which is what actually changed.
 */
enableAutoUnmount(afterEach);

const sample = (index: number): HistorySample => ({
  ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  x: index,
});

const track = (length: number): HistorySample[] =>
  Array.from({ length }, (_unused, index) => sample(index));

let poseCalls = 0;

/** Every third sample has no pose, so the "skipped" path is exercised throughout. */
const poseOf = (item: HistorySample): TrailPoint | null => {
  poseCalls += 1;
  const index = Number(item.x);
  return index % 3 === 2 ? null : { x: index, y: index * 2 };
};

const mountPlayback = () => {
  let api: ReturnType<typeof useHistoryPlayback> | null = null;
  const Harness = defineComponent({
    setup() {
      api = useHistoryPlayback({ poseOf });
      return () => h("i");
    },
  });
  const wrapper = mount(Harness);
  return { wrapper, api: api! };
};

beforeEach(() => {
  poseCalls = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the cursor", () => {
  it("starts at the first sample and reports progress from one", () => {
    const { api } = mountPlayback();
    api.setSamples(track(5));

    expect(api.cursor.value).toBe(0);
    expect(api.progressLabel.value).toBe("1 / 5");
    expect(api.currentSample.value).toMatchObject({ x: 0 });
  });

  it("says 0 / 0 with nothing loaded rather than 1 / 0", () => {
    expect(mountPlayback().api.progressLabel.value).toBe("0 / 0");
  });

  it("advances on the interval and stops at the end", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(3));
    api.togglePlay();

    vi.advanceTimersByTime(delayFor(1) * 2);
    await nextTick();
    expect(api.cursor.value).toBe(2);
    expect(api.playing.value).toBe(false);
  });

  it("replays from the start when play is pressed at the end", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(3));
    api.seek(2);
    await nextTick();

    api.togglePlay();
    expect(api.cursor.value).toBe(0);
    expect(api.playing.value).toBe(true);
  });

  it("does nothing with no samples, rather than starting a timer", () => {
    const { api } = mountPlayback();
    api.togglePlay();
    expect(api.playing.value).toBe(false);
  });

  it("clamps a seek to the track", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(4));

    api.seek(99);
    await nextTick();
    expect(api.cursor.value).toBe(3);

    api.seek(-5);
    await nextTick();
    expect(api.cursor.value).toBe(0);
  });

  it("re-times a running interval when the speed changes", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(10));
    api.togglePlay();

    api.speed.value = 4;
    await nextTick();

    // One 4x step is not enough time for a 1x step, so this only advances if the
    // interval was actually re-armed.
    vi.advanceTimersByTime(delayFor(4));
    await nextTick();
    expect(api.cursor.value).toBe(1);
  });

  it("never runs faster than the floor, however high the speed", () => {
    expect(delayFor(1)).toBe(600);
    expect(delayFor(4)).toBe(150);
    expect(delayFor(1000)).toBe(80);
    expect(PLAYBACK_SPEEDS).toContain(4);
  });

  it("stops the timer when the component goes away", async () => {
    const { api, wrapper } = mountPlayback();
    api.setSamples(track(50));
    api.togglePlay();
    wrapper.unmount();

    const parked = api.cursor.value;
    vi.advanceTimersByTime(delayFor(1) * 5);
    await nextTick();
    expect(api.cursor.value).toBe(parked);
  });
});

describe("the trail", () => {
  it("holds every pose up to the cursor, skipping samples without one", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(6));
    api.seek(4);
    await nextTick();

    // Indices 2 and 5 have no pose; 5 is past the cursor anyway.
    expect(api.trail.value.map((point) => point.x)).toEqual([0, 1, 3, 4]);
  });

  it("rewinds with the cursor", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(6));
    api.seek(5);
    await nextTick();
    api.seek(1);
    await nextTick();

    expect(api.trail.value.map((point) => point.x)).toEqual([0, 1]);
  });

  it("is emptied and rebuilt when a new track is loaded", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(6));
    api.seek(5);
    await nextTick();

    api.setSamples(track(2));
    await nextTick();
    expect(api.cursor.value).toBe(0);
    expect(api.trail.value.map((point) => point.x)).toEqual([0]);
  });
});

describe("the work it does", () => {
  it("extracts each sample's pose once per track, not once per tick", async () => {
    // FIXED: v1.0.0 re-extracted the whole prefix every tick. Playing 200 samples
    // meant ~20,000 extractions; against the endpoint's 5000 ceiling, ~12.5 million.
    const { api } = mountPlayback();
    const length = 200;
    api.setSamples(track(length));
    expect(poseCalls).toBe(length);

    api.togglePlay();
    vi.advanceTimersByTime(delayFor(1) * length);
    await nextTick();

    expect(api.cursor.value).toBe(length - 1);
    // Not one extraction more: playback reads the precomputed array.
    expect(poseCalls).toBe(length);
  });

  it("grows the trail by one point per tick instead of rebuilding it", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(9));
    const first = api.trail.value;

    api.togglePlay();
    vi.advanceTimersByTime(delayFor(1));
    await nextTick();

    // Same array, one longer — a rebuild would have replaced it.
    expect(api.trail.value).toBe(first);
    expect(api.trail.value).toHaveLength(2);
  });

  it("still rebuilds on a scrub, because a jump is not an append", async () => {
    const { api } = mountPlayback();
    api.setSamples(track(9));
    const first = api.trail.value;

    api.seek(6);
    await nextTick();

    expect(api.trail.value).not.toBe(first);
    expect(api.trail.value.map((point) => point.x)).toEqual([0, 1, 3, 4, 6]);
  });
});
