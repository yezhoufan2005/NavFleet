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
import { formatSoc } from "@navfleet/shared";
import {
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
import DeviceCodesCard from "@/components/device/DeviceCodesCard.vue";
import { textClasses } from "@/lib/uiClasses";
import { vOverflowTitle } from "@/directives/overflowTitle";
import DeviceTaskCard from "@/components/device/DeviceTaskCard.vue";
import { FIELD_HELP } from "@/lib/fieldHelp";
import UiHelpTip from "@/components/ui/UiHelpTip.vue";

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

/**
 * The top row's shape. Both cards with content: half each. One with content: it takes the row and
 * the other folds to a narrow strip (title set vertically) that widens again when content arrives.
 * Neither: two short title-only placeholders, half each. Column widths and card heights are
 * animated (see the scoped styles), so a code appearing slides its card open.
 */
const hasCodes = computed(() => codes.value.length > 0);
const hasTask = computed(() => Boolean(device.value?.task));
const topColumns = computed(() =>
  hasCodes.value === hasTask.value
    ? "1fr 1fr"
    : hasCodes.value
      ? "1fr 3.25rem"
      : "3.25rem 1fr",
);
/** A placeholder beside an open card is a vertical strip; with both empty, both lie flat. */
const foldVertical = computed(() => hasCodes.value !== hasTask.value);

interface Row {
  label: string;
  value: string;
  /** Hover/AT description for an enum code — `describeEnum`'s output. */
  title?: string;
  /** What the field means (units, convention) — shown behind a "?" beside the label. */
  help?: string;
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
      help: FIELD_HELP.device.fusionLoc,
      value: hasPose(fusion)
        ? `x ${formatNumber(fusion?.x, 2)} · y ${formatNumber(fusion?.y, 2)} · yaw ${formatNumber(fusion?.yaw, 3)}`
        : MISSING,
    },
    {
      label: "激光定位",
      help: FIELD_HELP.device.lidarLoc,
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
      help: FIELD_HELP.device.omega,
      value: orMissing(formatNumber(info?.omega, 2, " rad/s")),
    },
    // `formatSoc` — one decimal, trailing zero dropped — is the one spelling of soc across every
    // surface and the low-battery message, so a reading never shows as two numbers.
    {
      label: "电量",
      value: orMissing(formatSoc(info?.soc)),
      help: FIELD_HELP.device.soc,
    },
  ];
});

/** The two task status enums; what the task *is* lives in the 当前任务 card at the top. */
const taskRows = computed<Row[]>(() => [
  {
    label: "车端任务",
    value: orMissing(formatEnum(device.value?.taskStatus, taskStatusMap)),
    title: describeEnum(device.value?.taskStatus, taskStatusMap),
  },
  {
    label: "平台任务",
    help: FIELD_HELP.device.platformTask,
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
      help: FIELD_HELP.device.speedLimit,
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
      help: FIELD_HELP.device.heading,
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
  { key: "task", title: "任务状态", rows: taskRows.value },
  { key: "gps", title: "GPS", rows: gpsRows.value },
]);
</script>

<template>
  <div class="flex flex-col">
    <!-- The top row answers "what is wrong, and what is it doing": 报码解读 beside 当前任务. See
         `topColumns` for how it folds; under md the two stack. -->
    <div
      class="top-cards mb-4 grid grid-cols-1 gap-4 md:[grid-template-columns:var(--top-columns)]"
      :style="{ '--top-columns': topColumns }"
      data-testid="live-top-row"
    >
      <div class="min-w-0" :data-state="hasCodes ? 'open' : 'folded'">
        <DeviceCodesCard
          :codes="codes"
          :stamp="device?.stamp ?? ''"
          :collapsed="!hasCodes"
          :vertical="foldVertical"
        />
      </div>
      <div class="min-w-0" :data-state="hasTask ? 'open' : 'folded'">
        <DeviceTaskCard
          :task="device?.task"
          :stamp="device?.stamp ?? ''"
          :collapsed="!hasTask"
          :vertical="foldVertical"
        />
      </div>
    </div>

    <!-- The six panels in a fixed 3-column grid: 状态 / 位姿 / 限速, then 场景 / 任务 / GPS. -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
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
            <dt class="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
              {{ row.label }}
              <UiHelpTip v-if="row.help" :text="row.help" />
            </dt>
            <!--
              An enum value carries its sentence on hover (`title`, and `aria-description` for AT,
              since `title` on a non-interactive element is not reliably announced). Any other value
              is a one-line field: `min-w-0` so it can shrink beside its label, … when cut, and the
              full value on hover only while it is cut.
            -->
            <dd
              v-if="row.title"
              class="m-0 text-right text-sm text-ink tabular-nums"
              :class="textClasses.field"
              :title="row.title"
              :aria-description="row.title"
            >
              {{ row.value }}
            </dd>
            <dd
              v-else
              v-overflow-title
              class="m-0 text-right text-sm text-ink tabular-nums"
              :class="textClasses.field"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
/*
 * Column widths interpolate, so a card widens open instead of popping. Plain block layout (no
 * <table>), so each frame reflows two cards — the reason the device list fell back to a fade does
 * not apply. The global prefers-reduced-motion rule in base.css zeroes the duration.
 */
.top-cards {
  transition: grid-template-columns 240ms var(--ease-standard);
}

/*
 * One floor for both cards with content, so the row does not jump between a one-line code and a
 * four-field task: 15rem is the task card's full height (title, id, progress, two field rows).
 * A placeholder has none — beside an open card it stretches to that card's height; with both
 * empty the pair stays a short title row. The floor animates so a card grows open smoothly.
 */
.top-cards :deep(.device-top-card) {
  min-height: 15rem;
  transition: min-height 240ms var(--ease-standard);
}
.top-cards :deep(.device-top-card.is-collapsed) {
  min-height: 0;
}
</style>
