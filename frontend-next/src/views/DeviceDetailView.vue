<script setup lang="ts">
/**
 * 设备详情 — a route, not a nav section.
 *
 * Reached from the list, the map or an alert. It is where the 11B audit found the
 * worst task flow in v1.0.0: diagnosing one vehicle took six steps and still did not
 * answer the question, because live telemetry and history lived on different pages and
 * each made you pick the device again. Here they are one page over an already-chosen
 * device.
 *
 * The headline section is **报码解读**, and it is the first thing on this page for a
 * reason: v1.0.0 printed `5102` and whatever string the firmware attached, so the
 * number meant nothing until someone who knew the vehicle explained it. The dictionary
 * in `@navfleet/fleet-core` turns it into 含义 + 成因 + 处理建议 + **车辆还能做什么** —
 * that last one is VDA 5050's model, and it is the part a dispatcher can act on.
 *
 * Every panel is always rendered, and a field the vehicle has no value for reads 缺失
 * rather than the panel disappearing. This reverses the earlier "drop an all-`--` panel"
 * rule by request: across several devices a card that vanishes reads as "this one is
 * different", so a fixed set of placeholder-filled cards is easier to scan than a set
 * whose shape changes per vehicle.
 *
 * ## Why tabs, and why the tab is in the URL
 *
 * `docs/frontend-ia.md` puts 历史回放 here rather than in the nav, because a separate
 * page made you choose the same vehicle twice. But the three views are answers to
 * different questions asked at different times — right now / lately / that afternoon —
 * so stacking them into one scroll would bury the first one under the other two.
 *
 * The active tab lives in `?tab=`, which makes it linkable: "look at c12's playback"
 * is a URL rather than a sentence with a step in it. `replace` rather than `push`, so
 * the back button leaves the device instead of walking back through tabs.
 */
import { computed, defineAsyncComponent, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import PageHeader from "@/components/PageHeader.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  CODE_IMPACTS,
  controlModeMap,
  describeEnum,
  deviceToneLabels,
  formatEnum,
  formatNumber,
  formatStamp,
  gearMap,
  getDeviceTone,
  hasGps,
  hasPose,
  taskStatusMap,
} from "@navfleet/fleet-core";
import { useCodebook } from "@/composables/useCodebook";

const route = useRoute();
const router = useRouter();
const fleet = useFleetStore();

/**
 * The four L3 views `docs/frontend-ia.md` asks for, in the order the questions get
 * asked: right now / lately / that afternoon / has this happened before.
 */
const TABS = [
  { value: "live", label: "实时" },
  { value: "charts", label: "曲线" },
  { value: "playback", label: "历史回放" },
  { value: "alerts", label: "告警史" },
] as const;

/**
 * The three non-default panels are async, and the tab boundary is why that is exactly
 * right rather than merely possible: Reka does not mount an inactive panel, so the
 * split point and the "do we need this yet" point are the same line.
 *
 * The measured reason: ECharts and the map engine were static imports of this view, so
 * opening a device on 实时 downloaded **564 kB** to render six panels of text. Deferring
 * them leaves the live tab with what it actually uses. Each panel already renders its
 * own loading state after mount, so the brief blank while the chunk arrives is the
 * state that tab shows anyway.
 */
const DeviceChartsTab = defineAsyncComponent(
  () => import("@/components/device/DeviceChartsTab.vue"),
);
const DevicePlaybackTab = defineAsyncComponent(
  () => import("@/components/device/DevicePlaybackTab.vue"),
);
const DeviceAlertsTab = defineAsyncComponent(
  () => import("@/components/device/DeviceAlertsTab.vue"),
);

const activeTab = computed({
  get: () => {
    const requested = String(route.query.tab ?? "");
    return TABS.some((tab) => tab.value === requested) ? requested : "live";
  },
  set: (next: string) => {
    void router.replace({
      query: { ...route.query, tab: next === "live" ? undefined : next },
    });
  },
});

const deviceId = computed(() => String(route.params.deviceId ?? ""));
const device = computed(() => fleet.state.devicesById[deviceId.value] ?? null);

const tone = computed(() =>
  device.value ? getDeviceTone(device.value) : "offline",
);
const toneLabel = computed(() => deviceToneLabels[tone.value]);

const TONE_BADGE: Record<string, string> = {
  normal: "bg-brand-wash text-brand-ink",
  notice: "bg-notice-wash text-notice-ink",
  warning: "bg-warning-wash text-warning-ink",
  critical: "bg-critical-wash text-critical-ink",
  offline: "bg-offline-wash text-offline-ink",
};

/** The active report codes, decoded against the deployment codebook. Empty for a healthy vehicle. */
const codebook = useCodebook();
onMounted(() => {
  // Fetch the table in effect (built-in ⊕ deployment codebook); until it lands, the shared
  // built-in table backs `describeDevice`, so the card renders rather than flashing empty.
  void codebook.load();
});
const codes = computed(() =>
  device.value ? codebook.describeDevice(device.value) : [],
);

const CHANNEL_LABELS: Record<string, string> = {
  error: "告警",
  warning: "预警",
  info: "提示",
};

interface Row {
  label: string;
  value: string;
  /**
   * Hover/AT description for an enum code — `describeEnum`'s output.
   *
   * The three enum maps have carried a `description` beside every `label` since 12A and
   * had tests, and the port read only the labels: `formatEnum` came over, `describeEnum`
   * did not, so "自动驾驶" lost the sentence explaining what the mode actually does.
   * Optional because most rows are numbers, which explain themselves.
   */
  title?: string;
}

/**
 * Missing readings are shown as this word, and every panel is always rendered — the
 * earlier rule (drop a panel with no data, because a panel of `--` reads as lost data)
 * was reversed by request: a card that silently disappears reads as "this vehicle is
 * different" while scanning several devices, so an absent card now stays put and says
 * 缺失. `formatEnum`/`formatNumber` return "--" for absent data; normalise that here.
 */
const MISSING = "缺失";
const orMissing = (value: string): string =>
  value === "--" || value === "" ? MISSING : value;

/** Pose, both fixes — the gap between them is the information; absent fixes read 缺失. */
const poseRows = computed<Row[]>(() => {
  const fusion = device.value?.fusionLoc;
  const lidar = device.value?.lidarLoc;
  return [
    {
      label: "融合定位",
      value: hasPose(fusion)
        ? `x ${formatNumber(fusion?.x, 2)} · y ${formatNumber(fusion?.y, 2)} · yaw ${formatNumber(fusion?.yaw, 3)}`
        : MISSING,
    },
    {
      label: "激光定位",
      value: hasPose(lidar)
        ? `x ${formatNumber(lidar?.x, 2)} · y ${formatNumber(lidar?.y, 2)} · yaw ${formatNumber(lidar?.yaw, 3)}`
        : MISSING,
    },
  ];
});

const vehicleRows = computed<Row[]>(() => {
  const info = device.value?.vehicleInfo;
  return [
    // The enum maps are the ones v1.0.0 lost in its own Vue migration: before Phase 1
    // these three rendered as bare numbers.
    {
      label: "控制模式",
      value: orMissing(formatEnum(info?.controlMode, controlModeMap)),
      title: describeEnum(info?.controlMode, controlModeMap),
    },
    {
      label: "挡位",
      value: orMissing(formatEnum(info?.gear, gearMap)),
      title: describeEnum(info?.gear, gearMap),
    },
    { label: "速度", value: orMissing(formatNumber(info?.speed, 2, " m/s")) },
    {
      label: "角速度",
      value: orMissing(formatNumber(info?.omega, 3, " rad/s")),
    },
    // `"%"` without the leading space its neighbours have: a percent sign is not a unit
    // symbol. 0 digits because SOC telemetry to 0.1% is false precision.
    { label: "电量", value: orMissing(formatNumber(info?.soc, 0, "%")) },
  ];
});

const taskRows = computed<Row[]>(() => [
  {
    label: "车端任务",
    value: orMissing(formatEnum(device.value?.taskStatus, taskStatusMap)),
    title: describeEnum(device.value?.taskStatus, taskStatusMap),
  },
  {
    label: "平台任务",
    value: orMissing(
      formatEnum(device.value?.platformTaskStatus, taskStatusMap),
    ),
    title: describeEnum(device.value?.platformTaskStatus, taskStatusMap),
  },
]);

const speedLimitRows = computed<Row[]>(() => {
  const limit = device.value?.speedLimit;
  return [
    {
      label: "限速值",
      value: orMissing(formatNumber(limit?.limit, 2, " m/s")),
    },
    {
      label: "减速时间",
      value: orMissing(formatNumber(limit?.slowdownTime, 2, " s")),
    },
    { label: "限速来源", value: limit?.moduleName || MISSING },
    {
      label: "更新时间",
      value: limit?.stamp ? formatStamp(limit.stamp) : MISSING,
    },
  ];
});

const gpsRows = computed<Row[]>(() => {
  const gps = device.value?.gps;
  // `gpsEnabled` is configured per device, so "no fix" and "no receiver" both read 缺失
  // here; the panel stays rather than vanishing.
  const present = device.value?.gpsEnabled !== false && hasGps(gps);
  return [
    {
      label: "经纬度",
      value: present
        ? `${formatNumber(gps?.lng, 6)}, ${formatNumber(gps?.lat, 6)}`
        : MISSING,
    },
    {
      label: "航向",
      value: present ? formatNumber(gps?.heading, 1, "°") : MISSING,
    },
  ];
});

const sceneRows = computed<Row[]>(() => {
  const sceneId = device.value?.sceneId;
  const definition = sceneId ? fleet.getSceneDefinition(sceneId) : null;
  return [
    {
      label: "当前场景",
      // Three-way, matching the devices list: no id at all is 未配置场景 (v1.0.0's
      // wording, lost in the port), an id without a definition falls back to the id
      // itself, and `--` no longer stands in for both.
      value: sceneId
        ? (definition?.sceneName as string) || sceneId
        : "未配置场景",
    },
    {
      label: "最后上报",
      value: device.value?.stamp ? formatStamp(device.value.stamp) : MISSING,
    },
  ];
});

// Every panel, always — an absent one is placeholder, not dropped (see MISSING above).
const panels = computed(() => [
  // `key: "pose"` — it read `"codes"` until now, a copy-paste artefact that `:key`
  // actually consumes, so the pose panel was keyed as if it were the code panel.
  { key: "pose", title: "位姿", rows: poseRows.value },
  { key: "vehicle", title: "车辆状态", rows: vehicleRows.value },
  { key: "task", title: "任务", rows: taskRows.value },
  { key: "limit", title: "限速", rows: speedLimitRows.value },
  { key: "gps", title: "GPS", rows: gpsRows.value },
  { key: "scene", title: "场景", rows: sceneRows.value },
]);
</script>

<template>
  <PageHeader
    :title="device ? device.deviceName || deviceId : `设备 ${deviceId}`"
    :lede="device ? `编号 ${device.deviceId}` : undefined"
  >
    <template #actions>
      <span
        v-if="device"
        class="rounded-xs px-2 py-1 font-mono text-2xs"
        :class="TONE_BADGE[tone]"
        >{{ toneLabel }}</span
      >
    </template>

    <div
      v-if="!device"
      class="grid place-content-center gap-2 rounded-md border border-border bg-surface-raised p-10 text-center"
    >
      <strong class="text-md text-ink">{{
        fleet.bootstrapPending ? "正在加载车队…" : "找不到这台设备"
      }}</strong>
      <span class="text-sm text-ink-muted">{{
        fleet.bootstrapPending
          ? "正在获取车队快照"
          : `车队快照里没有编号为 ${deviceId} 的设备，它可能已被移除或从未上报`
      }}</span>
    </div>

    <template v-else>
      <TabsRoot v-model="activeTab" class="flex min-h-0 flex-col gap-3">
        <TabsList
          class="flex shrink-0 gap-1 border-b border-border"
          aria-label="设备详情视图"
        >
          <TabsTrigger
            v-for="tab in TABS"
            :key="tab.value"
            :value="tab.value"
            class="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-ink-muted transition-colors duration-150 ease-standard hover:text-ink data-[state=active]:border-brand data-[state=active]:text-ink"
          >
            {{ tab.label }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" class="flex flex-col gap-3">
          <!-- 报码解读 first: it is the reason this page exists. -->
          <section
            class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
            aria-labelledby="codes-heading"
          >
            <h3 id="codes-heading" class="text-md font-semibold text-ink">
              报码解读
            </h3>

            <p v-if="!codes.length" class="text-sm text-ink-muted">
              当前没有活跃报码
            </p>

            <article
              v-for="row in codes"
              :key="row.channel"
              class="flex flex-col gap-1 rounded-sm border border-border bg-surface p-3"
            >
              <header class="flex flex-wrap items-baseline gap-2">
                <span class="font-mono text-2xs text-ink-subtle">{{
                  CHANNEL_LABELS[row.channel]
                }}</span>
                <span class="font-mono text-sm tabular-nums text-ink">{{
                  row.described.code
                }}</span>
                <strong class="text-md text-ink">{{
                  row.described.label
                }}</strong>
                <!-- The impact is stated as a capability, which is what a dispatcher
                     can act on — "how bad is it" is not. -->
                <span class="ml-auto font-mono text-2xs text-ink-muted">{{
                  CODE_IMPACTS[row.described.impact].label
                }}</span>
              </header>

              <!-- When it happened. v1.0.0 showed this (`DashboardView.vue:391`) and the
                   port lost it at the `describeCode` boundary, so the card described a
                   code without saying whether it fired a minute or a shift ago. -->
              <p
                v-if="row.described.stamp"
                class="m-0 font-mono text-2xs text-ink-subtle"
              >
                {{ formatStamp(row.described.stamp) }}
              </p>

              <p class="text-xs text-ink-muted">
                {{ CODE_IMPACTS[row.described.impact].meaning }}
              </p>
              <p class="text-sm text-ink">{{ row.described.description }}</p>
              <p class="text-sm text-ink-muted">
                <span class="font-mono text-2xs text-ink-subtle"
                  >处理建议
                </span>
                {{ row.described.hint }}
              </p>
              <p
                v-if="row.described.reported && !row.described.unknown"
                class="text-xs text-ink-muted"
              >
                <span class="font-mono text-2xs text-ink-subtle"
                  >车端上报
                </span>
                {{ row.described.reported }}
              </p>
              <p
                v-if="row.described.unknown"
                class="rounded-xs bg-warning-wash px-2 py-1 text-xs text-warning-ink"
              >
                该报码不在当前字典中 —— 显示的是车端原文，含义未经解释
              </p>
            </article>
          </section>

          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <section
              v-for="panel in panels"
              :key="panel.key"
              class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
            >
              <h3
                class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
              >
                {{ panel.title }}
              </h3>
              <dl class="m-0 flex flex-col gap-1">
                <div
                  v-for="row in panel.rows"
                  :key="row.label"
                  class="flex items-baseline justify-between gap-3"
                >
                  <dt class="shrink-0 text-xs text-ink-muted">
                    {{ row.label }}
                  </dt>
                  <!--
                    `title` only where a row has one, and marked with a dotted underline
                    so the tooltip is discoverable rather than a hover you have to guess
                    at. `aria-description` carries the same text to AT, because `title`
                    on a non-interactive element is not reliably announced.
                  -->
                  <dd
                    class="m-0 truncate text-right text-sm text-ink tabular-nums"
                    :class="
                      row.title
                        ? 'decoration-dotted underline-offset-4 hover:underline'
                        : undefined
                    "
                    :title="row.title"
                    :aria-description="row.title"
                  >
                    {{ row.value }}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </TabsContent>

        <!-- Both of these fetch on mount, and Reka does not mount an inactive panel —
             so arriving at 实时 costs no history request. -->
        <TabsContent value="charts">
          <DeviceChartsTab :device-id="deviceId" />
        </TabsContent>

        <TabsContent value="playback">
          <DevicePlaybackTab :device-id="deviceId" />
        </TabsContent>

        <TabsContent value="alerts">
          <DeviceAlertsTab :device-id="deviceId" />
        </TabsContent>
      </TabsRoot>
    </template>
  </PageHeader>
</template>
