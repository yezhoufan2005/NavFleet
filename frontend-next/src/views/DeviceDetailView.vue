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
 * Panels render only when the vehicle actually has that data. Not a capability system
 * — that is P1-b and deliberately not built here — just the ordinary rule that a
 * panel of `--` is worse than no panel, because it reads as lost data.
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
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import PageHeader from "@/components/PageHeader.vue";
import DeviceChartsTab from "@/components/device/DeviceChartsTab.vue";
import DevicePlaybackTab from "@/components/device/DevicePlaybackTab.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  CODE_IMPACTS,
  controlModeMap,
  describeDeviceCodes,
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

const route = useRoute();
const router = useRouter();
const fleet = useFleetStore();

const TABS = [
  { value: "live", label: "实时" },
  { value: "charts", label: "曲线" },
  { value: "playback", label: "历史回放" },
] as const;

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

/** The active report codes, decoded. Empty for a healthy vehicle. */
const codes = computed(() =>
  device.value ? describeDeviceCodes(device.value) : [],
);

const CHANNEL_LABELS: Record<string, string> = {
  error: "告警",
  warning: "预警",
  info: "提示",
};

interface Row {
  label: string;
  value: string;
}

/** Pose, both fixes — the gap between them is the information. */
const poseRows = computed<Row[]>(() => {
  const rows: Row[] = [];
  const fusion = device.value?.fusionLoc;
  const lidar = device.value?.lidarLoc;
  if (hasPose(fusion)) {
    rows.push({
      label: "融合定位",
      value: `x ${formatNumber(fusion?.x, 2)} · y ${formatNumber(fusion?.y, 2)} · yaw ${formatNumber(fusion?.yaw, 3)}`,
    });
  }
  if (hasPose(lidar)) {
    rows.push({
      label: "激光定位",
      value: `x ${formatNumber(lidar?.x, 2)} · y ${formatNumber(lidar?.y, 2)} · yaw ${formatNumber(lidar?.yaw, 3)}`,
    });
  }
  return rows;
});

const vehicleRows = computed<Row[]>(() => {
  const info = device.value?.vehicleInfo;
  if (!info) return [];
  return [
    // The enum maps are the ones v1.0.0 lost in its own Vue migration: before Phase 1
    // these three rendered as bare numbers.
    { label: "控制模式", value: formatEnum(info.controlMode, controlModeMap) },
    { label: "挡位", value: formatEnum(info.gear, gearMap) },
    { label: "速度", value: formatNumber(info.speed, 2, " m/s") },
    { label: "角速度", value: formatNumber(info.omega, 3, " rad/s") },
    { label: "电量", value: formatNumber(info.soc, 0, " %") },
  ];
});

const taskRows = computed<Row[]>(() => {
  if (!device.value) return [];
  return [
    {
      label: "车端任务",
      value: formatEnum(device.value.taskStatus, taskStatusMap),
    },
    {
      label: "平台任务",
      value: formatEnum(device.value.platformTaskStatus, taskStatusMap),
    },
  ];
});

const speedLimitRows = computed<Row[]>(() => {
  const limit = device.value?.speedLimit;
  if (!limit) return [];
  return [
    { label: "限速值", value: formatNumber(limit.limit, 2, " m/s") },
    { label: "减速时间", value: formatNumber(limit.slowdownTime, 2, " s") },
    { label: "限速来源", value: limit.moduleName || "--" },
  ];
});

const gpsRows = computed<Row[]>(() => {
  const gps = device.value?.gps;
  // The panel is absent rather than empty when the vehicle has no GPS at all —
  // `gpsEnabled` is configured per device, so "no fix" and "no receiver" differ.
  if (device.value?.gpsEnabled === false || !hasGps(gps)) return [];
  return [
    {
      label: "经纬度",
      value: `${formatNumber(gps?.lng, 6)}, ${formatNumber(gps?.lat, 6)}`,
    },
    { label: "航向", value: formatNumber(gps?.heading, 1, "°") },
  ];
});

const sceneRows = computed<Row[]>(() => {
  if (!device.value) return [];
  return [
    { label: "当前场景", value: device.value.sceneId || "--" },
    { label: "最后上报", value: formatStamp(device.value.stamp) },
  ];
});

const panels = computed(() =>
  [
    { key: "codes", title: "位姿", rows: poseRows.value },
    { key: "vehicle", title: "车辆状态", rows: vehicleRows.value },
    { key: "task", title: "任务", rows: taskRows.value },
    { key: "limit", title: "限速", rows: speedLimitRows.value },
    { key: "gps", title: "GPS", rows: gpsRows.value },
    { key: "scene", title: "场景", rows: sceneRows.value },
  ].filter((panel) => panel.rows.length),
);
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
          ? "正在获取车队快照。"
          : `车队快照里没有编号为 ${deviceId} 的设备，它可能已被移除或从未上报。`
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
            <h3 id="codes-heading" class="text-lg font-semibold text-ink">
              报码解读
            </h3>

            <p v-if="!codes.length" class="text-sm text-ink-muted">
              当前没有活跃报码。
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
                该报码不在当前字典中 —— 显示的是车端原文，含义未经解释。
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
                  <dd class="m-0 truncate text-right text-sm text-ink">
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
      </TabsRoot>
    </template>
  </PageHeader>
</template>
