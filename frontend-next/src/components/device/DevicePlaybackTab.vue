<script setup lang="ts">
/**
 * 历史回放 — a tab on the device, not a page of its own.
 *
 * That is the whole point of moving it. v1.0.0 had `/history` with its own device
 * picker, so an engineer who had just looked at a vehicle's live state had to choose
 * that same vehicle a second time to see where it had been; the 11B audit counted that
 * as half of the six-step flow that never answered the question. Here the device is
 * already decided by the route, and the window is the only thing left to choose.
 *
 * ## What changed against v1.0.0, and why
 *
 * - **There is no 最大点数 input.** Its `min`/`max` never constrained anything (no
 *   `<form>`), and the server clamps to its own `MAX_HISTORY_POINTS` regardless — so
 *   the control let you type 5000 and quietly gave you 500. This sends no `limit` at
 *   all, which lets the deployment's cap govern, and then **states the span actually
 *   covered** next to the span requested. An operator can see the window was cut
 *   without being told a diagnosis the frontend cannot make: "fewer samples than the
 *   window" and "the vehicle was parked with no telemetry" look identical from here.
 * - **It is a `<form>`, it loads on arrival, and the presets query immediately.**
 *   Three separate v1.0.0 dead ends: Enter did nothing, the page opened empty, and a
 *   preset filled the inputs but left you to press the button.
 * - **from > to is rejected before the request**, rather than surfacing as a 400 that
 *   reads "加载失败".
 * - **Changing device resets playback.** v1.0.0 had no `watch` on its picker, so the
 *   previous vehicle's samples kept playing under the new vehicle's name and scene.
 * - **Dragging the slider pauses.** Scrubbing while the timer keeps firing means the
 *   playhead fights the pointer.
 *
 * The trail and the cursor come from `useHistoryPlayback`, which is where the O(N²)
 * described in its own header used to live.
 */
import { computed, ref, watch } from "vue";
import SceneMap from "@/components/map/SceneMap.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import UiButton from "@/components/ui/UiButton.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  PLAYBACK_SPEEDS,
  useHistoryPlayback,
} from "@/composables/useHistoryPlayback";
import type { TrailPoint } from "@/composables/useHistoryPlayback";
import {
  fleetApi,
  formatDateTime,
  formatEnum,
  formatNumber,
  normalizeDevice,
  pickTrailPose,
  taskStatusMap,
} from "@navfleet/fleet-core";
import type { DeviceSnapshot } from "@navfleet/shared";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";

const { deviceId } = defineProps<{ deviceId: string }>();

const fleet = useFleetStore();
const liveDevice = computed<DeviceSnapshot | null>(
  () => fleet.state.devicesById[deviceId] ?? null,
);

const PRESET_HOURS = [1, 6, 24] as const;

const measurementsOf = (
  sample: Record<string, unknown> | null,
): Record<string, unknown> =>
  (sample?.measurements as Record<string, unknown> | undefined) ?? {};

/**
 * The pose the trail follows: the fusion fix, falling back to the lidar one. Which to
 * prefer is a fleet decision, which is why `useHistoryPlayback` takes it as an
 * argument instead of knowing about either.
 */
const poseOf = (sample: Record<string, unknown>): TrailPoint | null => {
  const measurements = measurementsOf(sample);
  const pose = pickTrailPose({
    fusionLoc: measurements.fusionLoc as never,
    lidarLoc: measurements.lidarLoc as never,
  });
  return pose ? { x: pose.x as number, y: pose.y as number } : null;
};

const {
  samples,
  cursor,
  playing,
  speed,
  currentSample,
  progressLabel,
  trail,
  setSamples,
  seek,
  stopPlayback,
  togglePlay,
  restart,
} = useHistoryPlayback({ poseOf });

// ── the window ─────────────────────────────────────────────────────────────────
const fromInput = ref("");
const toInput = ref("");
const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");

/** `datetime-local` wants local wall-clock, and `toISOString` is UTC. */
const toLocalInput = (at: Date): string =>
  new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

/**
 * A `datetime-local` value is a *minute*, not an instant, and the end of the window is
 * the end of that minute.
 *
 * Found by the browser suite, and it is a real defect rather than a test artefact:
 * `slice(0, 16)` floors the value, so 「最近 1 小时」 issued at 23:14:37 asked for a
 * window ending 23:14:00 and silently dropped the last 37 seconds. On a live monitoring
 * console that is precisely the wrong end to truncate — the newest samples are the ones
 * someone opened the tab for. v1.0.0 had the same flooring and hid it behind a button
 * you pressed later.
 */
const END_OF_MINUTE_MS = 60_000 - 1;

const rangeError = computed(() => {
  if (!fromInput.value || !toInput.value) return "";
  return new Date(fromInput.value) > new Date(toInput.value)
    ? "起始时间晚于结束时间，请调整后重新加载。"
    : "";
});

let requestId = 0;

const load = async (): Promise<void> => {
  if (!deviceId || rangeError.value) return;
  const id = (requestId += 1);
  status.value = "loading";
  errorMessage.value = "";

  try {
    // No `limit`: see the header. The server applies its own cap and we report the
    // span we actually got rather than a number we cannot honour.
    const params: { from?: string; to?: string } = {};
    if (fromInput.value) params.from = new Date(fromInput.value).toISOString();
    if (toInput.value) {
      params.to = new Date(
        new Date(toInput.value).getTime() + END_OF_MINUTE_MS,
      ).toISOString();
    }

    const payload = await fleetApi.getHistory(deviceId, params);
    // A slow response for a device you have navigated away from must not land.
    if (id !== requestId) return;

    // Sorted rather than reversed: the endpoint answers newest-first from Mongo, but
    // the in-memory fallback is its own path, and playback needs oldest-first either
    // way. Sorting is the assertion; reversing is a bet on the backend.
    const ordered = [...(payload.items ?? [])].sort(
      (left, right) =>
        new Date(left.ts).getTime() - new Date(right.ts).getTime(),
    );
    setSamples(ordered as Record<string, unknown>[]);
    status.value = "ready";
  } catch (error) {
    if (id !== requestId) return;
    setSamples([]);
    status.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "加载历史数据失败，请稍后重试。";
  }
};

const applyPreset = (hours: number): void => {
  const now = new Date();
  toInput.value = toLocalInput(now);
  fromInput.value = toLocalInput(new Date(now.getTime() - hours * 3_600_000));
  void load();
};

/**
 * Follow the route's device. Clearing first rather than waiting for the response is
 * what stops the previous vehicle's trail being drawn under this one's name.
 */
watch(
  () => deviceId,
  () => {
    setSamples([]);
    applyPreset(1);
  },
  { immediate: true },
);

const stampOf = (sample: Record<string, unknown> | null): number | null => {
  const parsed = sample ? Date.parse(String(sample.ts ?? "")) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Oldest → newest of what came back, which is not always what was asked for. */
const coveredLabel = computed(() => {
  const first = stampOf(samples.value[0] ?? null);
  const last = stampOf(samples.value.at(-1) ?? null);
  if (first === null || last === null) return "";
  return `${formatDateTime(first)} – ${formatDateTime(last)}`;
});

// ── the frame under the cursor ──────────────────────────────────────────────────
const activeSceneId = computed(() => {
  const measurements = measurementsOf(currentSample.value);
  return String(
    measurements.sceneId ||
      measurements.runtimeSceneId ||
      liveDevice.value?.sceneId ||
      "",
  );
});

const sceneDefinition = computed(() =>
  fleet.getSceneDefinition(activeSceneId.value),
);

/**
 * The sample, rendered as the device shape the map and the formatters expect.
 *
 * Built from the sample alone plus identity — deliberately **not** spread over the
 * live device. A field the sample does not carry has to come out blank, because
 * filling it from the current snapshot would print this second's error code on a frame
 * from an hour ago. Identity is the exception: the name and topic are properties of
 * the vehicle, not of the moment.
 */
const playbackDevice = computed<DeviceSnapshot | null>(() => {
  const sample = currentSample.value;
  if (!sample) return null;
  return normalizeDevice(
    {
      ...measurementsOf(sample),
      deviceId,
      deviceName: liveDevice.value?.deviceName || deviceId,
      stamp: sample.ts,
    },
    liveDevice.value?.topic ?? "",
    null,
  ) as DeviceSnapshot;
});

const hasPlaybackPose = computed(() => {
  const device = playbackDevice.value;
  return !!(
    device &&
    (Number.isFinite(device.fusionLoc?.x) ||
      Number.isFinite(device.lidarLoc?.x))
  );
});

/** One entry, because a playback window is one vehicle by construction. */
const trailsForMap = computed(() => ({ [deviceId]: trail.value }));

const cursorAt = computed(() => stampOf(currentSample.value));

/**
 * The window's speed curve, with the playhead on it. This is the linkage the standalone
 * history page could not have: the trail says *where*, the curve says *how fast*, and
 * the cursor is the one instant both are showing.
 */
const windowSeries = computed<TimeSeries[]>(() => [
  {
    name: "速度",
    points: samples.value
      .map((sample) => {
        const info = measurementsOf(sample).vehicleInfo as
          { speed?: unknown } | undefined;
        return [stampOf(sample), Number(info?.speed)] as [
          number | null,
          number,
        ];
      })
      .filter(
        (point): point is [number, number] =>
          point[0] !== null && Number.isFinite(point[1]),
      ),
  },
]);

interface Row {
  label: string;
  value: string;
}

const sampleRows = computed<Row[]>(() => {
  const device = playbackDevice.value;
  if (!device) return [];
  const at = cursorAt.value;
  return [
    // `--` rather than `formatDateTime(undefined)`: that helper falls back to
    // `Date.now()`, so a sample with no timestamp would claim to be from this second.
    { label: "采样时间", value: at === null ? "--" : formatDateTime(at) },
    {
      label: "速度",
      value: formatNumber(device.vehicleInfo?.speed, 2, " m/s"),
    },
    { label: "电量", value: formatNumber(device.vehicleInfo?.soc, 1, "%") },
    { label: "任务状态", value: formatEnum(device.taskStatus, taskStatusMap) },
    { label: "融合 X", value: formatNumber(device.fusionLoc?.x, 2) },
    { label: "融合 Y", value: formatNumber(device.fusionLoc?.y, 2) },
    { label: "航向 yaw", value: formatNumber(device.fusionLoc?.yaw, 3) },
    {
      label: "场景",
      value:
        (sceneDefinition.value?.sceneName as string) ||
        activeSceneId.value ||
        "--",
    },
  ];
});

/** Scrubbing pauses: a timer that keeps firing fights the pointer. */
const onScrub = (event: Event): void => {
  stopPlayback();
  seek(Number((event.target as HTMLInputElement).value));
};
</script>

<template>
  <div class="flex flex-col gap-2">
    <form
      class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
      @submit.prevent="load"
    >
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-muted">起始时间</span>
          <input
            v-model="fromInput"
            type="datetime-local"
            class="h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-ink-muted">结束时间</span>
          <input
            v-model="toInput"
            type="datetime-local"
            class="h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink"
          />
        </label>
        <UiButton
          type="submit"
          size="sm"
          :disabled="status === 'loading' || !!rangeError"
        >
          {{ status === "loading" ? "加载中…" : "加载轨迹" }}
        </UiButton>

        <span class="ml-auto flex flex-wrap items-center gap-1.5">
          <span class="font-mono text-2xs text-ink-subtle">快捷范围</span>
          <UiButton
            v-for="hours in PRESET_HOURS"
            :key="hours"
            variant="ghost"
            size="sm"
            @click="applyPreset(hours)"
          >
            最近 {{ hours }} 小时
          </UiButton>
        </span>
      </div>

      <p v-if="rangeError" class="m-0 text-xs text-critical-ink" role="status">
        {{ rangeError }}
      </p>
      <!-- The covered span beside the requested one, because they differ whenever the
           server's cap cut the window — and the frontend cannot tell that apart from a
           vehicle that simply was not reporting. -->
      <p
        v-else-if="status === 'ready' && samples.length"
        class="m-0 text-xs text-ink-muted"
      >
        已载入 {{ samples.length }} 条采样，覆盖 {{ coveredLabel }}。
      </p>
    </form>

    <!--
      No visible heading. It said 轨迹回放 directly under a tab labelled 历史回放 —
      the same thing twice — and it cost 25px plus a gap out of a budget that was
      already over. The section keeps its accessible name through `aria-label`, so the
      landmark is still announced; only the duplicate ink is gone.
    -->
    <section
      class="flex min-h-0 flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
      aria-label="轨迹回放"
    >
      <!--
        The map takes the space that is actually left, rather than growing past the fold
        or taking a fixed fraction of it.

        Two measurements shaped this. Before any change, on a 641px window the map
        reported **697px** (`min-h-80` is only a floor, and `SceneMap` fills a flex
        column that had no height constraint), so its bottom edge sat 421px below the
        fold and the playback controls 441px below it — you had to scroll to reach 播放.
        The first fix used `42vh`, which fit at 641px and then **wasted 146px at 900px**,
        because the content above the map is a constant 308px whatever the window height
        is (measured at both sizes).

        So the height is `100vh` minus that constant plus the control row — the map grows
        1:1 with the window instead of by 42% of it. Clamped at both ends: a floor for
        very short windows, and a ceiling so a 4K display does not hand over a map taller
        than anyone scans.
      -->
      <div
        class="map-surface relative flex h-[clamp(16rem,calc(100vh-23.5rem),44rem)] flex-col overflow-hidden rounded-sm border border-border bg-surface"
      >
        <SceneMap
          v-if="
            status === 'ready' &&
            playbackDevice &&
            sceneDefinition &&
            hasPlaybackPose
          "
          :selected-device="playbackDevice"
          :scene-definition="sceneDefinition"
          :scene-devices="[]"
          :trails="trailsForMap"
        />

        <div
          v-else-if="status === 'loading'"
          class="grid flex-1 place-content-center text-center"
        >
          <strong class="text-md text-ink">正在加载历史轨迹…</strong>
        </div>

        <div
          v-else-if="status === 'error'"
          class="grid flex-1 place-content-center gap-1 px-6 text-center"
          role="status"
        >
          <strong class="text-md text-critical-ink">历史数据加载失败</strong>
          <span class="text-sm text-ink-muted">{{ errorMessage }}</span>
        </div>

        <div
          v-else-if="!samples.length"
          class="grid flex-1 place-content-center gap-1 px-6 text-center"
        >
          <strong class="text-md text-ink">没有历史轨迹数据</strong>
          <span class="max-w-prose text-sm text-ink-muted">
            历史回放依赖 MongoDB 持久化的遥测数据。请确认后端已连接 MongoDB，
            且该设备在所选时间范围内有上报记录。
          </span>
        </div>

        <div
          v-else-if="!hasPlaybackPose"
          class="grid flex-1 place-content-center gap-1 px-6 text-center"
        >
          <strong class="text-md text-ink">该轨迹缺少 ROS 位姿</strong>
          <span class="max-w-prose text-sm text-ink-muted">
            这段历史里没有融合定位或激光定位坐标，无法在场景地图上回放。下方的采样详情与速度曲线仍然可用。
          </span>
        </div>

        <div
          v-else
          class="grid flex-1 place-content-center gap-1 px-6 text-center"
        >
          <strong class="text-md text-ink">缺少场景地图定义</strong>
          <span class="max-w-prose text-sm text-ink-muted">
            这段历史属于场景
            <code class="font-mono">{{ activeSceneId || "（未标注）" }}</code
            >，但车队配置里没有它的地图。补齐场景配置后即可回放。
          </span>
        </div>
      </div>

      <!--
        A row of media controls with no icons and no visible labels, so both accessible
        names come from `aria-label`. Removing either is the axe critical Phase 10
        found: an unnamed slider and an unnamed combobox.

        The progress readout moved here from the section header when that header went
        away. This is where it belongs anyway — it describes the playhead, and it now
        sits beside the control that moves it.
      -->
      <div class="flex flex-wrap items-center gap-2">
        <UiButton size="sm" :disabled="!samples.length" @click="togglePlay">
          {{ playing ? "暂停" : "播放" }}
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="!samples.length"
          @click="restart"
        >
          重播
        </UiButton>

        <span class="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">{{
          progressLabel
        }}</span>

        <input
          class="min-w-40 flex-1 accent-brand"
          type="range"
          aria-label="回放进度"
          min="0"
          :max="Math.max(0, samples.length - 1)"
          :value="cursor"
          :disabled="!samples.length"
          @input="onScrub"
        />

        <select
          v-model.number="speed"
          class="h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink"
          aria-label="回放速度"
          :disabled="!samples.length"
        >
          <option
            v-for="option in PLAYBACK_SPEEDS"
            :key="option"
            :value="option"
          >
            {{ option }}×
          </option>
        </select>
      </div>
    </section>

    <section
      v-if="samples.length"
      class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
      aria-labelledby="playback-sample-heading"
    >
      <h3
        id="playback-sample-heading"
        class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
      >
        采样详情
      </h3>
      <dl class="m-0 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="row in sampleRows"
          :key="row.label"
          class="flex flex-col gap-0.5"
        >
          <dt class="text-xs text-ink-muted">{{ row.label }}</dt>
          <dd class="m-0 truncate font-mono text-sm text-ink">
            {{ row.value }}
          </dd>
        </div>
      </dl>

      <!-- The cursor is the linkage: same instant as the marker on the map. -->
      <TimeSeriesChart
        :series="windowSeries"
        unit="m/s"
        label="回放窗口速度"
        :height="180"
        :cursor-at="cursorAt"
      />
    </section>
  </div>
</template>
