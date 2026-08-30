<script setup lang="ts">
/**
 * 总览 — the default landing page, and the biggest single bet in the new IA.
 *
 * v1.0.0 landed on a full-width map. The research says that is the wrong first
 * screen: supervisors running forty or more units stop looking at live positions
 * within the first week, because "where is everyone" is not the question a shift
 * starts with. **"Which few need me right now" is.** So the page is built around one
 * ordered list — `devicesByAttention` — with the counts above it as context, not as
 * the point.
 *
 * The tiles are stat tiles rather than charts on purpose: four single numbers have no
 * shape to show, and a donut of "6 online / 1 offline" is a worse way to read "6 / 7".
 * Each carries a word as well as a colour, because a coloured number alone says
 * nothing to a colourblind operator and nothing at all to a screen reader.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  deviceToneLabels,
  formatDateTime,
  getDeviceTone,
} from "@navfleet/fleet-core";
import type { DeviceSnapshot } from "@navfleet/shared";

/** How often the "x ago" line re-renders. Coarse on purpose: it is not a stopwatch. */
const AGE_TICK_MS = 10_000;
/** Rows in the attention list before it defers to 设备. */
const ATTENTION_LIMIT = 6;

const fleet = useFleetStore();

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now();
  }, AGE_TICK_MS);
});

onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker);
});

/**
 * How long ago this browser last ingested anything, measured on the browser's own
 * clock.
 *
 * Deliberately not derived from the server's timestamp: the two clocks can be skewed,
 * and subtracting one from the other is how a freshness line ends up reading
 * "更新于 -8 秒前". The server's value is shown as an absolute time beside this, which
 * is the thing it can answer honestly.
 */
const ageLabel = computed(() => {
  const ingested = fleet.state.lastUpdateAt;
  if (!ingested) return "尚无数据";

  const seconds = Math.max(
    0,
    Math.round((now.value - new Date(ingested).getTime()) / 1000),
  );
  if (seconds < 15) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
});

const serverTimeLabel = computed(() =>
  fleet.state.serverUpdatedAt
    ? formatDateTime(fleet.state.serverUpdatedAt)
    : "--",
);

type Tone = "ok" | "warning" | "critical" | "muted";

interface Tile {
  key: string;
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

/**
 * The four numbers a shift opens with. `tone` is only ever "not normal" when the
 * number itself says so — a permanently amber tile teaches people to ignore amber.
 */
const tiles = computed<Tile[]>(() => {
  const { totalCount, onlineCount, alertTotal, gpsCount } = fleet.summary;
  const offline = totalCount - onlineCount;
  const critical = fleet.groupedAlerts.critical.length;

  return [
    {
      key: "online",
      label: "在线设备",
      value: `${onlineCount} / ${totalCount}`,
      note: offline > 0 ? `${offline} 台离线` : "全部在线",
      tone: offline > 0 ? "warning" : "ok",
    },
    {
      key: "alerts",
      label: "活跃告警",
      value: String(alertTotal),
      note: critical > 0 ? `其中 ${critical} 条告警级` : "无告警级",
      tone: critical > 0 ? "critical" : alertTotal > 0 ? "warning" : "ok",
    },
    {
      key: "gps",
      label: "GPS 覆盖",
      // The backend has always sent this count and no frontend ever read it.
      value: `${gpsCount} / ${totalCount}`,
      note:
        gpsCount < totalCount
          ? `${totalCount - gpsCount} 台无定位`
          : "全部已定位",
      tone: "muted",
    },
    {
      key: "formations",
      label: "编队",
      value: String(fleet.formations.length),
      note: fleet.formations.length ? "点击查看成员" : "未配置编队",
      tone: "muted",
    },
  ];
});

const TILE_VALUE_CLASS: Record<Tone, string> = {
  ok: "text-ink",
  warning: "text-warning-ink",
  critical: "text-critical-ink",
  muted: "text-ink",
};

interface AttentionRow {
  device: DeviceSnapshot;
  tone: string;
  label: string;
  detail: string;
}

/**
 * The vehicles worth walking over to, worst first.
 *
 * Healthy vehicles are excluded rather than ranked last: a list that always has the
 * same forty rows is a list nobody reads. When everything is fine the page says so in
 * one line, which is the useful answer.
 */
const attention = computed<AttentionRow[]>(() =>
  fleet.devicesByAttention
    .filter((device) => getDeviceTone(device) !== "normal")
    .slice(0, ATTENTION_LIMIT)
    .map((device) => {
      const tone = getDeviceTone(device);
      const code =
        device.errorCode?.info ||
        device.warningCode?.info ||
        device.infoCode?.info;
      return {
        device,
        tone,
        label: deviceToneLabels[tone],
        detail:
          tone === "offline"
            ? "已失联，最后状态可能已过期"
            : code || "无详细信息",
      };
    }),
);

const TONE_DOT: Record<string, string> = {
  normal: "bg-brand",
  notice: "bg-notice",
  warning: "bg-warning",
  critical: "bg-critical",
  offline: "bg-offline",
};

/** Severity rows for the alert summary, in the order they should be acted on. */
const alertRows = computed(() =>
  (
    [
      { severity: "critical", label: "告警" },
      { severity: "warning", label: "预警" },
      { severity: "notice", label: "提示" },
    ] as const
  ).map((row) => ({
    ...row,
    count: fleet.groupedAlerts[row.severity].length,
  })),
);
</script>

<template>
  <PageHeader
    title="总览"
    lede="值班第一眼要看的四五个信号，加上此刻需要处理的车辆。"
  >
    <template #actions>
      <!-- Freshness belongs beside the numbers it qualifies. The relative age is on
           the browser's clock; the absolute time is the server's own. -->
      <p class="text-right text-2xs text-ink-muted" role="status">
        <span class="block">数据 {{ ageLabel }}</span>
        <span class="block font-mono">服务端 {{ serverTimeLabel }}</span>
      </p>
    </template>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <article
        v-for="tile in tiles"
        :key="tile.key"
        class="flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-4"
      >
        <span
          class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
          >{{ tile.label }}</span
        >
        <strong
          class="text-3xl font-semibold tabular-nums"
          :class="TILE_VALUE_CLASS[tile.tone]"
          >{{ tile.value }}</strong
        >
        <span class="text-xs text-ink-muted">{{ tile.note }}</span>
      </article>
    </div>

    <div class="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section
        class="flex min-h-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
        aria-labelledby="attention-heading"
      >
        <div class="flex items-baseline justify-between gap-3">
          <h3 id="attention-heading" class="text-lg font-semibold text-ink">
            需要处理
          </h3>
          <RouterLink
            to="/devices"
            class="text-xs text-brand-ink underline-offset-2 hover:underline"
            >查看全部设备</RouterLink
          >
        </div>

        <p v-if="fleet.bootstrapPending" class="text-sm text-ink-muted">
          正在获取车队快照…
        </p>
        <p v-else-if="!fleet.summary.totalCount" class="text-sm text-ink-muted">
          后端还没有上报任何设备。
        </p>
        <p v-else-if="!attention.length" class="text-sm text-ink-muted">
          全部
          {{ fleet.summary.totalCount }} 台设备状态正常，没有需要处理的车辆。
        </p>

        <ul v-else class="m-0 flex list-none flex-col gap-1 p-0">
          <li v-for="row in attention" :key="row.device.deviceId">
            <RouterLink
              :to="`/devices/${row.device.deviceId}`"
              class="flex items-center gap-3 rounded-sm px-2 py-2 transition-colors duration-150 ease-standard hover:bg-surface-sunken"
            >
              <span
                class="size-2.5 shrink-0 rounded-full"
                :class="TONE_DOT[row.tone]"
                aria-hidden="true"
              />
              <span class="w-10 shrink-0 font-mono text-2xs text-ink-muted">{{
                row.label
              }}</span>
              <span class="min-w-0 flex-1">
                <strong class="block truncate text-sm text-ink">{{
                  row.device.deviceName || row.device.deviceId
                }}</strong>
                <span class="block truncate text-xs text-ink-muted">{{
                  row.detail
                }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <div class="flex min-h-0 flex-col gap-4">
        <section
          class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
          aria-labelledby="alerts-heading"
        >
          <div class="flex items-baseline justify-between gap-3">
            <h3 id="alerts-heading" class="text-lg font-semibold text-ink">
              告警摘要
            </h3>
            <RouterLink
              to="/alerts"
              class="text-xs text-brand-ink underline-offset-2 hover:underline"
              >告警中心</RouterLink
            >
          </div>
          <dl class="m-0 grid grid-cols-3 gap-2">
            <div
              v-for="row in alertRows"
              :key="row.severity"
              class="flex flex-col"
            >
              <dt class="font-mono text-2xs text-ink-subtle">
                {{ row.label }}
              </dt>
              <dd class="m-0 text-xl font-semibold tabular-nums text-ink">
                {{ row.count }}
              </dd>
            </div>
          </dl>
        </section>

        <section
          v-if="fleet.formations.length"
          class="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-surface-raised p-4"
          aria-labelledby="formations-heading"
        >
          <h3 id="formations-heading" class="text-lg font-semibold text-ink">
            编队
          </h3>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <li
              v-for="formation in fleet.formations"
              :key="formation.formationId"
              class="flex flex-col gap-0.5"
            >
              <span class="flex items-baseline justify-between gap-2">
                <strong class="truncate text-sm text-ink">{{
                  formation.formationName || formation.formationId
                }}</strong>
                <span class="shrink-0 font-mono text-2xs text-ink-muted"
                  >{{ formation.onlineCount }} /
                  {{ formation.deviceCount }}</span
                >
              </span>
              <!-- Configured per formation and shown nowhere in v1.0.0. -->
              <span
                v-if="formation.description"
                class="text-xs text-ink-muted"
                >{{ formation.description }}</span
              >
            </li>
          </ul>
        </section>
      </div>
    </div>
  </PageHeader>
</template>
