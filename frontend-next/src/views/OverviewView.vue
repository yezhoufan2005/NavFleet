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
import UiSkeleton from "@/components/ui/UiSkeleton.vue";
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
const ATTENTION_LIMIT = 5;

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
      // Not 点击查看成员: this tile is an `<article>`, and it stayed one. The click is
      // on the formation rows below, so the note names where the capability is instead
      // of describing one this element does not have.
      note: fleet.formations.length ? "可在设备页按编队筛选" : "未配置编队",
      tone: "muted",
    },
  ];
});

/**
 * Deliberately **not** a per-tone text colour on the number — that was the defect.
 *
 * Manual review reported «浅色模式数字颜色不清晰», and measuring it said the opposite of
 * what it sounded like: light mode had the *higher* contrast (`warning-ink` 10.59:1 and
 * `critical-ink` 11.05:1 against white, versus 7.45 / 6.63 in dark against slate-800).
 * So the problem was never contrast. `amber-800` / `rose-800` sit at **L=0.37**, and at
 * that lightness the hue is not identifiable: the number reads as "dark text", and the
 * one thing the colour was there to say — "this is a warning" — never arrives. Dark mode
 * uses L=0.88 (`amber-200` / `rose-200`), which reads as amber at a glance.
 *
 * The fix is the rule this project already follows on its charts: **text wears text
 * colours, and a saturated mark beside it carries the state.** So the number is
 * `text-ink` in both themes, and the tone goes on the card as an inset edge plus a
 * faint wash — the same treatment `DevicesView` gives a critical or warning row, which
 * makes it one visual language rather than two.
 */
const TILE_VALUE_CLASS = "text-3xl font-semibold tabular-nums text-ink";

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
  <PageHeader title="总览">
    <template #actions>
      <!-- Freshness belongs beside the numbers it qualifies. The relative age is on
           the browser's clock; the absolute time is the server's own. -->
      <p class="text-right text-2xs text-ink-muted" role="status">
        <span class="block">数据 {{ ageLabel }}</span>
        <span class="block font-mono">服务端 {{ serverTimeLabel }}</span>
      </p>
    </template>

    <!--
      `aria-busy` on the region, not on the placeholders: the shimmer says "loading"
      visually and `UiSkeleton` is `aria-hidden`, so this attribute is the *only* thing
      that carries the state to a screen reader. Losing it was the invisible half of the
      skeleton regression — before this, `src` had `aria-busy` in exactly one place
      (`LoginForm`'s submit), so no data-loading region announced itself at all.
    -->
    <div
      class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      :aria-busy="fleet.bootstrapPending"
    >
      <article
        v-for="tile in tiles"
        :key="tile.key"
        class="stat-tile flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-4"
        :data-tone="tile.tone"
      >
        <span
          class="flex items-center gap-2 font-mono text-2xs tracking-wider text-ink-subtle uppercase"
        >
          {{ tile.label }}
          <!--
            The saturated mark that carries the state, which is the half of this the
            coloured number was doing badly. Positioned at the end of the row rather than
            before the label so that a card gaining or losing a tone does not shift its
            own label sideways; `aria-hidden` because the note underneath already says
            the same thing in words ("6 台离线"), which is what a screen reader and a
            colourblind operator read.
          -->
          <span
            v-if="tile.tone === 'warning' || tile.tone === 'critical'"
            class="tile-mark ml-auto size-2.5 shrink-0 rounded-full"
            aria-hidden="true"
          />
        </span>
        <!-- The `value` variant reserves this element's own line box, so the card does
             not resize when the real number lands. -->
        <template v-if="fleet.bootstrapPending">
          <UiSkeleton variant="value" />
          <!--
            The note is a placeholder too, and that is not tidiness. Every note is
            derived from counts that are all zero before the snapshot arrives, so a
            loading 总览 was stating 全部在线 · 无告警级 · 全部已定位 — four confident
            claims about data it did not have. That is the same defect as
            `formatNumber(null)` rendering `0.00`, one layer up.
          -->
          <UiSkeleton />
        </template>
        <template v-else>
          <strong :class="TILE_VALUE_CLASS">{{ tile.value }}</strong>
          <span class="text-xs text-ink-muted">{{ tile.note }}</span>
        </template>
      </article>
    </div>

    <div class="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section
        class="flex min-h-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
        aria-labelledby="attention-heading"
      >
        <div class="flex items-baseline justify-between gap-3">
          <h3 id="attention-heading" class="text-lg font-semibold text-ink">
            待处理项
          </h3>
          <RouterLink
            to="/devices"
            class="text-xs text-brand-ink underline-offset-2 hover:underline"
            >查看全部设备</RouterLink
          >
        </div>

        <div
          v-if="fleet.bootstrapPending"
          aria-busy="true"
          class="flex flex-col gap-1"
        >
          <!-- Cards rather than lines: this list holds device rows, and a stack of thin
               lines under a 待处理项 heading looks like a short list of real vehicles. -->
          <UiSkeleton :rows="3" variant="card" />
          <p class="text-sm text-ink-muted">正在获取车队快照…</p>
        </div>
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
              消息摘要
            </h3>
            <RouterLink
              to="/alerts"
              class="text-xs text-brand-ink underline-offset-2 hover:underline"
              >查看全部消息</RouterLink
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
            编队情况
          </h3>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <li
              v-for="formation in fleet.formations"
              :key="formation.formationId"
            >
              <!--
                A link, because the tile above says 可在设备页按编队筛选 and something
                has to honour that. Before this the note read 点击查看成员 on a plain
                `<article>` with no handler and no formations route to reach — an
                affordance promised in copy and absent from the DOM.

                The formation id travels in the query string, which is what makes it a
                real link: 设备 reads it there, so this survives a paste and a reload.
              -->
              <RouterLink
                :to="{
                  path: '/devices',
                  query: { formation: formation.formationId },
                }"
                class="flex flex-col gap-0.5 rounded-sm px-2 py-1 -mx-2 no-underline transition-colors duration-150 ease-standard hover:bg-surface-sunken"
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
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </PageHeader>
</template>

<style scoped>
/*
 * The tone treatment for a stat tile, keyed on a runtime value — so scoped CSS rather
 * than utilities, for the same reason `DevicesView` gives: Tailwind only sees literal
 * class names, and four tones would mean four literals in the template.
 *
 * This is where the state lives now that the number is `text-ink` in both themes. See
 * `TILE_VALUE_CLASS` for the measurement that moved it here. `ok` and `muted` get
 * nothing on purpose: a card that is always tinted teaches people to stop reading the
 * tint, which is the same argument `notice` loses its row treatment on the device list.
 *
 * `--tile-wash` is deliberately low. The first attempt reused the device row's 60% mix,
 * and on a card that covers twenty times the area it stops being a tint: in dark mode
 * `warning-wash` is `amber-900` (L≈0.28), and 60% of it over `surface-raised` came out a
 * muddy brown — the *same* failure this change exists to fix, "the hue does not read",
 * reintroduced in the other theme. The saturated edge and dot are at full strength
 * instead, which is what 13R-B asked for: a small block with enough saturation, not a
 * wash over everything.
 */
.stat-tile {
  --tile-wash: 22%;
}

/*
 * Dark drops the wash entirely, and the asymmetry is the honest answer rather than a
 * missing abstraction: the two themes' wash tokens sit at opposite ends of the lightness
 * scale (`amber-50` at L≈0.97 in light, `amber-900` at L≈0.28 in dark), so one mix
 * percentage cannot serve both. Blending a near-white tint into a white card is gentle;
 * blending a dark saturated one into a dark card is how the amber card came out olive.
 * The edge and the dot are at full saturation in both themes, and in dark that is enough
 * on its own — measured by looking at it, which is the only instrument that answers
 * "does this read as amber".
 */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .stat-tile {
    --tile-wash: 0%;
  }
}

:root[data-theme="dark"] .stat-tile {
  --tile-wash: 0%;
}

.stat-tile[data-tone="warning"] {
  background: color-mix(
    in oklab,
    var(--color-warning-wash) var(--tile-wash),
    var(--color-surface-raised)
  );
  box-shadow: inset 4px 0 0 var(--color-warning);
}

.stat-tile[data-tone="warning"] .tile-mark {
  background: var(--color-warning);
}

.stat-tile[data-tone="critical"] {
  background: color-mix(
    in oklab,
    var(--color-critical-wash) var(--tile-wash),
    var(--color-surface-raised)
  );
  box-shadow: inset 4px 0 0 var(--color-critical);
}

.stat-tile[data-tone="critical"] .tile-mark {
  background: var(--color-critical);
}
</style>
