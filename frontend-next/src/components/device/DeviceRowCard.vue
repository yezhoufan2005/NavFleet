<script setup lang="ts">
/**
 * The card a device row expands into: what the vehicle is doing right now.
 *
 * Deliberately **not** a copy of 设备详情. The detail page answers "tell me everything
 * about this vehicle" across six panels and four tabs; this answers the much smaller
 * question an operator has while scanning a list — «row three is amber, what is wrong
 * with it» — without making them leave the list, lose their sort, and come back. So the
 * fields here are exactly the ones that turn a status dot into a sentence: what mode it
 * is in, whether it is moving, where it is, and what is actually firing.
 *
 * Everything else stays one click away, and the card says so with a link rather than by
 * growing.
 *
 * The enum fields go through `formatEnum` + `describeEnum` for the reason
 * `DeviceDetailView` documents: the maps have carried a `description` beside every
 * `label` since 12A, and reading only the labels is how «自动驾驶» loses the sentence
 * explaining what that mode does.
 */
import { computed } from "vue";
import { RouterLink } from "vue-router";
import {
  controlModeMap,
  describeEnum,
  formatEnum,
  formatNumber,
  gearMap,
  hasGps,
  hasPose,
  taskStatusMap,
} from "@navfleet/fleet-core";
import type { DeviceSnapshot } from "@navfleet/shared";

const props = defineProps<{
  device: DeviceSnapshot;
  sceneLabel: string;
  /** Formation display names, resolved by the caller (the store holds them). */
  formationNames: string[];
}>();

defineEmits<{ (event: "focus-on-map", deviceId: string): void }>();

interface Field {
  label: string;
  value: string;
  /** Hover/AT description for an enum code. */
  title?: string;
}

const fields = computed<Field[]>(() => {
  const device = props.device;
  const info = device.vehicleInfo;
  const rows: Field[] = [
    {
      label: "控制模式",
      value: formatEnum(info?.controlMode, controlModeMap),
      title: describeEnum(info?.controlMode, controlModeMap),
    },
    {
      label: "挡位",
      value: formatEnum(info?.gear, gearMap),
      title: describeEnum(info?.gear, gearMap),
    },
    { label: "速度", value: formatNumber(info?.speed, 2, " m/s") },
    { label: "角速度", value: formatNumber(info?.omega, 3, " rad/s") },
    {
      label: "车端任务",
      value: formatEnum(device.taskStatus, taskStatusMap),
      title: describeEnum(device.taskStatus, taskStatusMap),
    },
    { label: "场景", value: props.sceneLabel },
  ];

  // Position: whichever fix the vehicle actually has, and nothing at all when it has
  // neither. A `--` here would read as "at the origin" on a site map.
  if (hasPose(device.fusionLoc)) {
    rows.push({
      label: "融合定位",
      value: `x ${formatNumber(device.fusionLoc?.x, 2)} · y ${formatNumber(device.fusionLoc?.y, 2)}`,
    });
  }
  if (device.gpsEnabled !== false && hasGps(device.gps)) {
    rows.push({
      label: "经纬度",
      value: `${formatNumber(device.gps?.lng, 6)}, ${formatNumber(device.gps?.lat, 6)}`,
    });
  }

  rows.push({
    label: "编队",
    value: props.formationNames.length
      ? props.formationNames.join("、")
      : "未编入编队",
  });

  return rows;
});

/**
 * The alerts, worst first and capped.
 *
 * Capped because a vehicle re-sends its active codes every cycle and a bad one can
 * carry a dozen: a row that expands into a wall of alerts stops being a glance. The
 * count says how many were left out, and the link goes where all of them are.
 */
const ALERT_PREVIEW_LIMIT = 3;

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-critical bg-critical-wash text-critical-ink",
  warning: "border-warning bg-warning-wash text-warning-ink",
  notice: "border-notice bg-notice-wash text-notice-ink",
};

const sortedAlerts = computed(() =>
  [...(props.device.alerts ?? [])].sort(
    (left, right) =>
      (SEVERITY_RANK[left.severity] ?? 9) -
      (SEVERITY_RANK[right.severity] ?? 9),
  ),
);

const previewAlerts = computed(() =>
  sortedAlerts.value.slice(0, ALERT_PREVIEW_LIMIT),
);
const hiddenAlertCount = computed(() =>
  Math.max(sortedAlerts.value.length - ALERT_PREVIEW_LIMIT, 0),
);
</script>

<template>
  <div class="flex flex-col gap-3 bg-surface-sunken px-3 py-3">
    <dl class="m-0 grid gap-x-4 gap-y-2 sm:grid-cols-3 xl:grid-cols-4">
      <div
        v-for="field in fields"
        :key="field.label"
        class="flex flex-col gap-0.5"
      >
        <dt class="text-2xs text-ink-muted">{{ field.label }}</dt>
        <dd class="m-0 font-mono text-xs text-ink" :title="field.title">
          {{ field.value }}
        </dd>
      </div>
    </dl>

    <div v-if="previewAlerts.length" class="flex flex-wrap items-center gap-2">
      <span
        v-for="alert in previewAlerts"
        :key="alert.id"
        class="rounded-sm border px-2 py-1 text-2xs"
        :class="SEVERITY_CLASS[alert.severity] ?? SEVERITY_CLASS.notice"
      >
        {{ alert.title }}
      </span>
      <span v-if="hiddenAlertCount" class="text-2xs text-ink-muted">
        另有 {{ hiddenAlertCount }} 条
      </span>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <RouterLink
        :to="`/devices/${device.deviceId}`"
        class="rounded-sm border border-border-strong px-2.5 py-1 text-xs text-brand-ink transition-colors duration-150 ease-standard hover:bg-surface-raised"
      >
        打开详情 →
      </RouterLink>
      <!--
        Selecting is a separate act from opening: the map centres on
        `selectedDeviceId`, so this is how someone lines up a vehicle in the list and
        then switches to the map to watch it move.
      -->
      <button
        type="button"
        class="rounded-sm border border-border-strong px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
        @click="$emit('focus-on-map', device.deviceId)"
      >
        在地图上选中
      </button>
    </div>
  </div>
</template>
