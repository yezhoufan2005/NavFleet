/**
 * Timeline playback for the history view: the sample cursor, the play/pause
 * state, the speed multiplier and the interval that drives them.
 *
 * The composable owns its own interval and clears it on unmount, so a view that
 * navigates away mid-playback cannot leave a timer ticking against a disposed
 * component. Callers hand in a new track through `setSamples` rather than
 * mutating the sample list, which keeps "load a new window" a single step
 * (samples replaced, cursor rewound).
 *
 * Samples come straight from `/api/devices/:id/history` and are only read by the
 * view (`ts`, `measurements`, …), so they stay untyped bags here.
 */

import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

/** One history sample, as returned by the history endpoint. */
export type HistorySample = Record<string, unknown>;

export interface UseHistoryPlaybackResult {
  /** Loaded samples, ascending by time. Replace them via `setSamples`. */
  samples: ComputedRef<HistorySample[]>;
  /** Index of the sample being shown; writable so the view can scrub. */
  cursor: Ref<number>;
  playing: ComputedRef<boolean>;
  /** Playback rate multiplier; changing it re-times a running interval. */
  speed: Ref<number>;
  currentSample: ComputedRef<HistorySample | null>;
  /** `"<cursor + 1> / <total>"`, or `"0 / 0"` with nothing loaded. */
  progressLabel: ComputedRef<string>;
  /** Replaces the track and rewinds the cursor to the first sample. */
  setSamples: (items: HistorySample[]) => void;
  stopPlayback: () => void;
  /** Play, pause, or replay from the start when parked on the last sample. */
  togglePlay: () => void;
  restart: () => void;
}

/** Interval between cursor steps: 600ms at 1x, never faster than 80ms. */
function delayFor(speed: number): number {
  return Math.max(80, 600 / speed);
}

export function useHistoryPlayback(): UseHistoryPlaybackResult {
  const samples = ref<HistorySample[]>([]); // ascending by time
  const cursor = ref(0);
  const playing = ref(false);
  const speed = ref(1);
  let playTimer: number | null = null;

  const currentSample = computed<HistorySample | null>(() => samples.value[cursor.value] || null);

  const progressLabel = computed(() => {
    if (!samples.value.length) {
      return "0 / 0";
    }
    return `${cursor.value + 1} / ${samples.value.length}`;
  });

  function stopPlayback(): void {
    playing.value = false;
    if (playTimer) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
  }

  function tick(): void {
    if (cursor.value >= samples.value.length - 1) {
      stopPlayback();
      return;
    }
    cursor.value += 1;
  }

  function togglePlay(): void {
    if (!samples.value.length) {
      return;
    }
    if (playing.value) {
      stopPlayback();
      return;
    }
    if (cursor.value >= samples.value.length - 1) {
      cursor.value = 0;
    }
    playing.value = true;
    playTimer = window.setInterval(tick, delayFor(speed.value));
  }

  function restart(): void {
    stopPlayback();
    cursor.value = 0;
  }

  function setSamples(items: HistorySample[]): void {
    samples.value = items;
    cursor.value = 0;
  }

  watch(speed, () => {
    if (playing.value) {
      stopPlayback();
      togglePlay();
    }
  });

  onBeforeUnmount(stopPlayback);

  return {
    samples: computed(() => samples.value),
    cursor,
    playing: computed(() => playing.value),
    speed,
    currentSample,
    progressLabel,
    setSamples,
    stopPlayback,
    togglePlay,
    restart,
  };
}
