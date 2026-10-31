<script setup lang="ts">
/**
 * 曲线 — the last few hundred samples, with no window to choose.
 *
 * Distinct from the 回放 tab on purpose. This one answers "how has it been behaving"
 * for the cost of opening a tab; playback answers "what happened between 14:00 and
 * 15:00", which needs a window and a playhead. Collapsing them would make the cheap
 * question expensive.
 *
 * ## Two charts, not one with two y-axes
 *
 * Speed is m/s and charge is %, and putting them on one pair of axes would let the
 * crossing point be chosen by whoever picked the scales — the single most common way a
 * chart misleads. `TimeSeriesChart` takes one `unit` per chart precisely so a dual axis
 * is inexpressible.
 *
 * Fetching happens on mount, which is when this tab's route is entered rather than when
 * the device page is: it is a lazy child route, so arriving at 实时 mounts neither this
 * component nor its history request.
 */
import { computed, ref, watch } from "vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { fleetApi } from "@navfleet/fleet-core";
import { toNumeric } from "@navfleet/shared";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";
import { useLatestRequest } from "@/composables/useLatestRequest";

const { deviceId } = defineProps<{ deviceId: string }>();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const speedSeries = ref<TimeSeries[]>([]);
const socSeries = ref<TimeSeries[]>([]);

const latestRequest = useLatestRequest();

const load = async (id: string): Promise<void> => {
  if (!id) return;
  const isCurrent = latestRequest.begin();

  status.value = "loading";
  errorMessage.value = "";
  try {
    // No `limit`: the backend returns its own cap (`MAX_HISTORY_POINTS`). A fixed 240 was a 400
    // on every device for a deployment that set the cap below it.
    const payload = await fleetApi.getHistory(id);
    // A slow response for a device you have navigated away from must not land.
    if (!isCurrent()) return;

    const samples = [...(payload.items ?? [])].sort(
      (left, right) =>
        new Date(left.ts).getTime() - new Date(right.ts).getTime(),
    );
    // `[epoch ms, value]` pairs, oldest first — the shape the chart takes. A missing reading is
    // stored as null, and `Number(null)` is 0: a vehicle that reports no soc drew a flat line at
    // 0 %. `toNumeric` leaves it out instead.
    const pointsOf = (
      pick: (item: (typeof samples)[number]) => unknown,
    ): [number, number][] =>
      samples
        .map(
          (item) =>
            [new Date(item.ts).getTime(), toNumeric(pick(item))] as const,
        )
        .filter(
          (point): point is readonly [number, number] =>
            Number.isFinite(point[0]) && point[1] !== null,
        )
        .map(([ts, value]) => [ts, value]);

    speedSeries.value = [
      {
        name: "速度",
        points: pointsOf(
          (item) =>
            (item.measurements?.vehicleInfo as { speed?: unknown } | undefined)
              ?.speed,
        ),
      },
    ];
    socSeries.value = [
      {
        name: "电量",
        points: pointsOf(
          (item) =>
            (item.measurements?.vehicleInfo as { soc?: unknown } | undefined)
              ?.soc,
        ),
      },
    ];
    status.value = "ready";
  } catch (error) {
    if (!isCurrent()) return;
    status.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "历史数据加载失败";
  }
};

watch(
  () => deviceId,
  (id) => void load(id),
  { immediate: true },
);

const hasHistory = computed(
  () =>
    status.value === "ready" &&
    (speedSeries.value[0]?.points.length || socSeries.value[0]?.points.length),
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    aria-labelledby="history-heading"
  >
    <h3 id="history-heading" class="text-md font-semibold text-ink">
      历史曲线
    </h3>

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">
      正在加载历史数据…
    </p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      {{ errorMessage }}
    </p>
    <p v-else-if="!hasHistory" class="text-sm text-ink-muted">
      这台设备还没有落库的历史遥测；持续运行后此处会出现速度与电量曲线
    </p>

    <template v-else>
      <TimeSeriesChart
        :series="speedSeries"
        unit="m/s"
        label="速度历史"
        :height="200"
        table-match-height
      />
      <TimeSeriesChart
        :series="socSeries"
        unit="%"
        label="电量历史"
        :height="200"
        table-match-height
      />
    </template>
  </section>
</template>
