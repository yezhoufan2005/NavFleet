import { computed, onBeforeUnmount, readonly, ref, watch } from "vue";
import type { Ref } from "vue";

/**
 * Timeline playback for the history tab: the sample cursor, play/pause, the speed
 * multiplier, and the trail that grows behind the cursor.
 *
 * Ported from v1.0.0's `useHistoryPlayback`, with the trail moved *in* — because the
 * trail is where the one confirmed frontend performance defect was.
 *
 * ## The O(N²) it replaces
 *
 * v1.0.0 computed the trail in the view as "every pose from index 0 up to the
 * cursor", recomputed from scratch on every tick:
 *
 * ```js
 * for (let index = 0; index <= cursor.value; index += 1) {
 *   const pose = pickTrailPose({ …measurementsOf(samples.value[index]) });
 *   if (pose) points.push({ x: round(pose.x, 3), y: round(pose.y, 3) });
 * }
 * return { [deviceId.value]: points };   // a fresh object literal, every tick
 * ```
 *
 * With the endpoint's 5000-sample ceiling and 4x playback (150 ms a frame) that is
 * ~12.5 million pose extractions over one playthrough, each allocating a point object,
 * plus a new outer object every frame.
 *
 * Two changes fix it, and neither is a micro-optimisation:
 *
 * 1. **Poses are extracted once per track**, when the samples are set — not once per
 *    tick per sample. That alone turns 12.5M extractions into 5000.
 * 2. **The trail is maintained incrementally.** Playback advances the cursor by one,
 *    so the trail gains one point; there is nothing to recompute. Only a scrub (any
 *    jump that is not +1) rebuilds, and rebuilding then is O(n) of array copying
 *    rather than of parsing.
 *
 * ## What is *not* fixed, and why that is the right call
 *
 * The map still serialises the whole trail to an SVG `d` string once a frame, so that
 * part stays O(n) per tick. It is inherent to redrawing a growing polyline through a
 * `path` element, and at the few hundred points the history endpoint actually returns
 * it is string building, not parsing — the cost v1.0.0 paid was in the pose extraction
 * and the per-point allocation, and those are what moved.
 *
 * The tests assert the *algorithmic* property — how many times `poseOf` is called —
 * rather than a wall-clock number, because a duration assertion on a shared CI runner
 * measures the runner.
 */

/** One history sample. The caller knows the payload shape; this module does not. */
export type HistorySample = Record<string, unknown>;

export interface TrailPoint {
  x: number;
  y: number;
}

export interface UseHistoryPlaybackOptions {
  /**
   * Extracts the drawable pose from one sample, or `null` when it has none.
   *
   * Injected rather than hardcoded: the pose can come from the fusion or the lidar
   * fix, and which to prefer is a fleet decision (`pickTrailPose`), not a playback one.
   */
  poseOf: (sample: HistorySample) => TrailPoint | null;
}

/** Interval between cursor steps: 600ms at 1x, never faster than 80ms. */
export const delayFor = (speed: number): number => Math.max(80, 600 / speed);

export const PLAYBACK_SPEEDS: readonly number[] = [0.5, 1, 2, 4];

export const useHistoryPlayback = (options: UseHistoryPlaybackOptions) => {
  const samples = ref<HistorySample[]>([]);
  const cursor = ref(0);
  const playing = ref(false);
  const speed = ref(1);
  const trail = ref<TrailPoint[]>([]);

  /**
   * Poses, index-aligned with `samples`, computed once per track. Deliberately a
   * plain array rather than a ref: nothing reads it directly, and making 5000 entries
   * reactive would be work for no reader.
   */
  let poses: (TrailPoint | null)[] = [];
  let lastCursor = -1;
  let playTimer: ReturnType<typeof setInterval> | null = null;

  const currentSample = computed<HistorySample | null>(
    () => samples.value[cursor.value] ?? null,
  );

  const progressLabel = computed(() =>
    samples.value.length
      ? `${cursor.value + 1} / ${samples.value.length}`
      : "0 / 0",
  );

  const stopPlayback = (): void => {
    playing.value = false;
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
    }
  };

  const rebuildTrail = (upTo: number): void => {
    const next: TrailPoint[] = [];
    for (let index = 0; index <= upTo && index < poses.length; index += 1) {
      const pose = poses[index];
      if (pose) next.push(pose);
    }
    trail.value = next;
  };

  // The only place the trail changes. Playback is the +1 case, which is why it costs
  // nothing; everything else is a scrub and rebuilds.
  watch(cursor, (next) => {
    if (next === lastCursor + 1) {
      const pose = poses[next];
      if (pose) trail.value.push(pose);
    } else {
      rebuildTrail(next);
    }
    lastCursor = next;
  });

  const tick = (): void => {
    if (cursor.value >= samples.value.length - 1) {
      stopPlayback();
      return;
    }
    cursor.value += 1;
    // Stop on arrival rather than on the following tick. v1.0.0 waited for the next
    // one, so the button stayed on "pause" for up to 600ms after the track had ended.
    if (cursor.value >= samples.value.length - 1) stopPlayback();
  };

  const togglePlay = (): void => {
    if (!samples.value.length) return;
    if (playing.value) {
      stopPlayback();
      return;
    }
    // Parked on the last sample: play means replay, not "do nothing".
    if (cursor.value >= samples.value.length - 1) cursor.value = 0;
    playing.value = true;
    playTimer = setInterval(tick, delayFor(speed.value));
  };

  const restart = (): void => {
    stopPlayback();
    cursor.value = 0;
  };

  /** Replaces the track and rewinds. Extracting the poses happens here, once. */
  const setSamples = (items: HistorySample[]): void => {
    stopPlayback();
    samples.value = items;
    poses = items.map((sample) => options.poseOf(sample));
    lastCursor = -1;
    cursor.value = 0;
    rebuildTrail(0);
    lastCursor = 0;
  };

  const seek = (index: number): void => {
    if (!samples.value.length) return;
    cursor.value = Math.min(
      Math.max(0, Math.floor(index)),
      samples.value.length - 1,
    );
  };

  watch(speed, () => {
    // Re-time a running interval rather than waiting for the next tick at the old rate.
    if (!playing.value) return;
    stopPlayback();
    togglePlay();
  });

  onBeforeUnmount(stopPlayback);

  return {
    samples: computed(() => samples.value),
    cursor: cursor as Ref<number>,
    playing: computed(() => playing.value),
    speed,
    currentSample,
    progressLabel,
    trail: readonly(trail),
    setSamples,
    seek,
    stopPlayback,
    togglePlay,
    restart,
  };
};
