<script setup lang="ts">
/**
 * One metric (speed or charge) of one vehicle, with a 实时 / 历史 toggle.
 *
 * 实时: a 15-minute sliding window fed from the live store at 1 Hz off the shared clock the
 * freshness labels already use (useNowTicker), never a timer of its own. Each tick appends the
 * current reading and drops anything past the trailing edge of the window; a missing reading is a
 * gap, not a zero (Number(null) is 0, which would draw a flat line at 0). The window is seeded on
 * mount from the last 15 minutes of history so the line is not empty for the first quarter hour.
 * There is no data table here — a flowing live window is not a thing to read row by row.
 *
 * 历史: the last three calendar days, each day its own line overlaid on one 00:00–24:00 axis
 * (buildMetricHistory), with a per-day table (one column per day) as the data-table alternative.
 * Fetched lazily — a device opened on 实时 costs no history request until 历史 is first selected.
 *
 * Both modes scale the value axis to the data (yScale): speed and charge each sit in a narrow
 * band, and a 0-anchored axis would flatten the variation that is the whole point of the curve.
 */
import { computed, onMounted, ref, watch } from "vue";
import { fleetApi } from "@navfleet/fleet-core";
import type { HistorySample } from "@navfleet/fleet-core";
import { toNumeric } from "@navfleet/shared";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiSegmented from "@/components/ui/UiSegmented.vue";
import UiScrollTable from "@/components/ui/UiScrollTable.vue";
import { useFleetStore } from "@/stores/fleet";
import { useNowTicker } from "@/composables/useNowTicker";
import { useLatestRequest } from "@/composables/useLatestRequest";
import { loadErrorMessage } from "@/lib/errorMessages";
import { buildMetricHistory } from "@/lib/metricHistory";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";

const { deviceId, metric, unit, realtimeLabel, historyLabel } = defineProps<{
  deviceId: string;
  metric: "speed" | "soc";
  unit: string;
  /** Button label and accessible name for the live view (e.g. 实时速度). */
  realtimeLabel: string;
  /** Button label and accessible name for the history view (e.g. 历史速度). */
  historyLabel: string;
}>();

type Mode = "realtime" | "history";

/** 15-minute live window; three calendar days of history in 10-minute buckets. */
const REALTIME_WINDOW_MS = 15 * 60_000;
const HISTORY_DAYS = 3;
const HISTORY_BUCKET_MINUTES = 10;

const mode = ref<Mode>("realtime");
const modeOptions = computed(() => [
  { value: "realtime", label: realtimeLabel },
  { value: "history", label: historyLabel },
]);

const fleet = useFleetStore();
const now = useNowTicker();

/** Reads this metric off a persisted sample; shape-tolerant, value coerced by the caller. */
const pickSample = (sample: HistorySample): unknown =>
  (sample.measurements?.vehicleInfo as Record<string, unknown> | undefined)?.[
    metric
  ];

/** `[epoch ms, value]` pairs from samples, nulls and non-finite stamps dropped, oldest first. */
const toBufferPoints = (
  samples: readonly HistorySample[],
): [number, number][] => {
  const points: [number, number][] = [];
  for (const sample of samples) {
    const ts = new Date(sample.ts).getTime();
    const value = toNumeric(pickSample(sample));
    if (Number.isFinite(ts) && value !== null) points.push([ts, value]);
  }
  return points.sort((left, right) => left[0] - right[0]);
};

// ── 实时 ──────────────────────────────────────────────────────────
const liveBuffer = ref<[number, number][]>([]);
const seedRequest = useLatestRequest();

/** The current live reading from the store, or null when absent / non-numeric (a gap). */
const readLive = (): number | null => {
  const vehicleInfo = fleet.state.devicesById[deviceId]?.vehicleInfo as
    Record<string, unknown> | undefined;
  return toNumeric(vehicleInfo?.[metric]);
};

/** Seed the window from the last 15 minutes of history so it is not empty on arrival. */
const seedRealtime = async (id: string): Promise<void> => {
  if (!id) return;
  const isCurrent = seedRequest.begin();
  const from = new Date(now.value - REALTIME_WINDOW_MS).toISOString();
  const to = new Date(now.value).toISOString();
  try {
    const payload = await fleetApi.getHistory(id, { from, to });
    if (!isCurrent()) return;
    liveBuffer.value = toBufferPoints(payload.items ?? []);
  } catch {
    // A failed seed is not worth an error state — the live feed refills the window within the
    // minute regardless. Start empty rather than block the live view behind a retry.
    if (!isCurrent()) return;
    liveBuffer.value = [];
  }
};

// One tick: drop points off the trailing edge of the window, append the current reading.
watch(now, (t) => {
  const floor = t - REALTIME_WINDOW_MS;
  const next = liveBuffer.value.filter((point) => point[0] >= floor);
  const value = readLive();
  if (value !== null) next.push([t, value]);
  liveBuffer.value = next;
});

const realtimeSeries = computed<TimeSeries[]>(() => [
  { name: realtimeLabel, points: liveBuffer.value },
]);
const realtimeXMin = computed(() => now.value - REALTIME_WINDOW_MS);
const realtimeXMax = computed(() => now.value);

// ── 历史 ──────────────────────────────────────────────────────────
const historySamples = ref<readonly HistorySample[]>([]);
/** Captured once per load so the day window does not re-bucket on every 1 Hz tick. */
const historyNowMs = ref(0);
const historyStatus = ref<"idle" | "loading" | "ready" | "error">("idle");
const historyError = ref("");
const historyRequest = useLatestRequest();
/** 图表 ⇆ 数据表 within 历史 only; reset whenever 历史 is left. */
const showTable = ref(false);

const loadHistory = async (id: string): Promise<void> => {
  if (!id) return;
  const isCurrent = historyRequest.begin();
  historyStatus.value = "loading";
  historyError.value = "";
  // The three calendar days ending today, from local midnight of the oldest to now. `sampling:
  // "even"` thins the whole span server-side rather than returning only the newest page.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (HISTORY_DAYS - 1));
  const capturedNow = Date.now();
  try {
    const payload = await fleetApi.getHistory(id, {
      from: start.toISOString(),
      to: new Date(capturedNow).toISOString(),
      sampling: "even",
    });
    if (!isCurrent()) return;
    historySamples.value = payload.items ?? [];
    historyNowMs.value = capturedNow;
    historyStatus.value = "ready";
  } catch (error) {
    if (!isCurrent()) return;
    historyStatus.value = "error";
    historyError.value = loadErrorMessage(
      error,
      "历史数据加载失败，请稍后重试",
    );
  }
};

const history = computed(() =>
  buildMetricHistory({
    samples: historySamples.value,
    pick: pickSample,
    days: HISTORY_DAYS,
    bucketMinutes: HISTORY_BUCKET_MINUTES,
    nowMs: historyNowMs.value || Date.now(),
  }),
);

const historyHasData = computed(() =>
  history.value.series.some((entry) => entry.points.length > 0),
);

// Switching into 历史 for the first time loads it; 实时 costs no history request until then.
watch(mode, (next) => {
  if (next === "history" && historyStatus.value === "idle") {
    void loadHistory(deviceId);
  }
  if (next === "realtime") showTable.value = false;
});

// A new device: reseed the live window, and reset history (reload only if 历史 is open).
watch(
  () => deviceId,
  (id) => {
    liveBuffer.value = [];
    void seedRealtime(id);
    historySamples.value = [];
    historyStatus.value = "idle";
    showTable.value = false;
    if (mode.value === "history") void loadHistory(id);
  },
);

onMounted(() => {
  void seedRealtime(deviceId);
});
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
  >
    <header class="flex items-center justify-between gap-3">
      <UiSegmented
        :model-value="mode"
        :options="modeOptions"
        :aria-label="`${realtimeLabel} / ${historyLabel}`"
        @update:model-value="mode = $event as Mode"
      />
      <UiButton
        v-if="mode === 'history' && historyStatus === 'ready' && historyHasData"
        variant="ghost"
        size="sm"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? "图表" : "数据表" }}
      </UiButton>
    </header>

    <!-- 实时: the flowing 15-minute window. No data table — see the module comment. -->
    <TimeSeriesChart
      v-if="mode === 'realtime'"
      :series="realtimeSeries"
      :unit="unit"
      :label="realtimeLabel"
      :height="200"
      label-hidden
      :show-table-toggle="false"
      y-scale
      :x-min="realtimeXMin"
      :x-max="realtimeXMax"
    />

    <!-- 历史: three days overlaid, or the state that stands in for the chart. -->
    <template v-else>
      <p v-if="historyStatus === 'loading'" class="text-sm text-ink-muted">
        正在加载历史数据…
      </p>
      <p
        v-else-if="historyStatus === 'error'"
        class="text-sm text-critical-ink"
        role="alert"
      >
        {{ historyError }}
      </p>
      <p v-else-if="!historyHasData" class="text-sm text-ink-muted">
        最近三天还没有落库的历史遥测；持续运行后此处会按天叠加显示曲线
      </p>
      <template v-else>
        <TimeSeriesChart
          v-if="!showTable"
          :series="history.series"
          :unit="unit"
          :label="historyLabel"
          :height="200"
          label-hidden
          :show-table-toggle="false"
          y-scale
          :x-min="history.axisMin"
          :x-max="history.axisMax"
        />
        <!-- One column per day, rows keyed by time-of-day (HH:mm) — 三天各一列. -->
        <UiScrollTable v-else :label="historyLabel" max-height="24rem">
          <template #colgroup>
            <col class="w-[30%]" />
            <col v-for="day in history.table.dayLabels" :key="day" />
          </template>
          <template #head>
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">时间</th>
              <th
                v-for="day in history.table.dayLabels"
                :key="day"
                scope="col"
                class="px-3 py-2 font-medium"
              >
                {{ day }}<template v-if="unit"> ({{ unit }})</template>
              </th>
            </tr>
          </template>
          <tr
            v-for="row in history.table.rows"
            :key="row.time"
            class="border-b border-border last:border-b-0"
          >
            <th
              scope="row"
              class="px-3 py-1.5 font-mono text-xs font-normal whitespace-nowrap text-ink-muted"
            >
              {{ row.time }}
            </th>
            <td
              v-for="(value, index) in row.values"
              :key="index"
              class="px-3 py-1.5 font-mono text-xs text-ink"
            >
              {{ value === null ? "--" : value.toFixed(2) }}
            </td>
          </tr>
        </UiScrollTable>
      </template>
    </template>
  </section>
</template>
