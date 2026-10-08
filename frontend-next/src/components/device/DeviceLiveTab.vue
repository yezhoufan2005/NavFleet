<script setup lang="ts">
/**
 * 实时 — the live state of one vehicle, and the reason the detail page exists.
 *
 * Extracted from `DeviceDetailView` when the four tabs became real child routes
 * (设备 › <id> › 实时): the view is now a shell that owns the device header and the
 * tab strip, and this is the content of its default tab. It renders into the shell's
 * `<RouterView>` and takes the device id as a route prop (`props: true`).
 *
 * The headline section is **报码解读**, and it is the first thing here for a reason:
 * v1.0.0 printed `5102` and whatever string the firmware attached, so the number
 * meant nothing until someone who knew the vehicle explained it. The dictionary in
 * `@navfleet/fleet-core` turns it into 含义 + 处理建议 + **车辆还能做什么** — that last
 * one is VDA 5050's model, and it is the part a dispatcher can act on.
 *
 * Every panel is always rendered, and a field the vehicle has no value for reads 缺失
 * rather than the panel disappearing. Across several devices a card that vanishes reads
 * as "this one is different", so a fixed set of placeholder-filled cards is easier to
 * scan than a set whose shape changes per vehicle.
 */
import { computed, onMounted } from "vue";
import { useFleetStore } from "@/stores/fleet";
import {
  CODE_IMPACTS,
  controlModeMap,
  describeEnum,
  formatEnum,
  formatNumber,
  formatStamp,
  gearMap,
  hasGps,
  hasPose,
  taskStatusMap,
} from "@navfleet/fleet-core";
import { useCodebook } from "@/composables/useCodebook";

const { deviceId } = defineProps<{ deviceId: string }>();

const fleet = useFleetStore();
const device = computed(() => fleet.state.devicesById[deviceId] ?? null);

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
  /** Hover/AT description for an enum code — `describeEnum`'s output. */
  title?: string;
}

/**
 * Missing readings are shown as this word, and every panel is always rendered.
 * `formatEnum`/`formatNumber` return "--" for absent data; normalise that here.
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
  // `gpsEnabled` is configured per device, so "no fix" and "no receiver" both read 缺失.
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

/**
 * Every panel, always — an absent one is placeholder, not dropped. Ordered for the
 * 3-column grid the request asks for: 状态 / 位姿 / 限速 on the first row, 场景 / 任务 /
 * GPS on the second.
 */
const panels = computed(() => [
  { key: "vehicle", title: "状态", rows: vehicleRows.value },
  { key: "pose", title: "位姿", rows: poseRows.value },
  { key: "limit", title: "限速", rows: speedLimitRows.value },
  { key: "scene", title: "场景", rows: sceneRows.value },
  { key: "task", title: "任务", rows: taskRows.value },
  { key: "gps", title: "GPS", rows: gpsRows.value },
]);
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 报码解读 first: it is the reason this page exists. -->
    <section
      class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="codes-heading"
    >
      <h3 id="codes-heading" class="text-md font-semibold text-ink">
        报码解读
      </h3>

      <p v-if="!codes.length" class="text-sm text-ink-muted">
        当前没有活跃报码
      </p>

      <!--
        One compact card per active code. The top row carries identity — 档位 / 代码 /
        名称 on the left, the capability impact on the right — then a de-emphasised line
        (when it fired + what it means), the explanation as the one primary sentence, and
        the advice / 车端上报 faded below. Tightened from the earlier roomy card so several
        codes stack legibly rather than each filling a screen.
      -->
      <article
        v-for="row in codes"
        :key="row.channel"
        class="flex flex-col gap-1 rounded-sm border border-border bg-surface p-2.5"
      >
        <header class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="font-mono text-2xs text-ink-subtle">{{
            CHANNEL_LABELS[row.channel]
          }}</span>
          <span class="font-mono text-sm tabular-nums text-ink">{{
            row.described.code
          }}</span>
          <strong class="text-sm font-semibold text-ink">{{
            row.described.label
          }}</strong>
          <span class="ml-auto font-mono text-2xs text-ink-muted">{{
            CODE_IMPACTS[row.described.impact].label
          }}</span>
        </header>

        <!-- When it fired and what the impact means — the secondary line, de-emphasised. -->
        <p
          class="m-0 flex flex-wrap items-baseline gap-x-2 text-2xs text-ink-subtle"
        >
          <span v-if="row.described.stamp" class="font-mono">{{
            formatStamp(row.described.stamp)
          }}</span>
          <span>{{ CODE_IMPACTS[row.described.impact].meaning }}</span>
        </p>

        <!-- The one primary sentence: what the code means. -->
        <p class="m-0 text-sm text-ink">{{ row.described.description }}</p>

        <p class="m-0 text-xs text-ink-muted">
          <span class="font-mono text-2xs text-ink-subtle">处理建议 </span
          >{{ row.described.hint }}
        </p>
        <p
          v-if="row.described.reported && !row.described.unknown"
          class="m-0 text-2xs text-ink-subtle"
        >
          <span class="font-mono">车端上报 </span>{{ row.described.reported }}
        </p>
        <p
          v-if="row.described.unknown"
          class="m-0 rounded-xs bg-warning-wash px-2 py-1 text-xs text-warning-ink"
        >
          该报码不在当前字典中 —— 显示的是车端原文，含义未经解释
        </p>
      </article>
    </section>

    <!-- The six panels in a fixed 3-column grid: 状态 / 位姿 / 限速, then 场景 / 任务 / GPS. -->
    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <section
        v-for="panel in panels"
        :key="panel.key"
        class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
      >
        <h3 class="font-mono text-2xs tracking-wider text-ink-subtle uppercase">
          {{ panel.title }}
        </h3>
        <dl class="m-0 flex flex-col gap-1">
          <div
            v-for="row in panel.rows"
            :key="row.label"
            class="flex items-baseline justify-between gap-3"
          >
            <dt class="shrink-0 text-xs text-ink-muted">{{ row.label }}</dt>
            <!--
              `title` only where a row has one, marked with a dotted underline so the
              tooltip is discoverable. `aria-description` carries the same text to AT,
              because `title` on a non-interactive element is not reliably announced.
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
  </div>
</template>
