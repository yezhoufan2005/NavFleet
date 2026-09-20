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
import UiButton from "@/components/ui/UiButton.vue";
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

/** A missing reading is shown as this, never dropped — the card always has all nine rows. */
const MISSING = "缺失";
/** `formatEnum`/`formatNumber` return "--" for absent data; show the explicit word instead. */
const orMissing = (value: string): string =>
  value === "--" || value === "" ? MISSING : value;

/**
 * All nine fields, always, in a fixed order. Earlier the two position rows were pushed
 * only when the vehicle had that fix, so a card could come up with six rows or eight and
 * the grid reflowed per device — «为什么这台没有经纬度» reads as a bug, not as "no fix yet".
 * Now every row is present and an absent value says 缺失. (场景/编队 keep their own
 * always-present wording — 未配置场景 / 未编入编队 — which says more than 缺失 would.)
 */
const fields = computed<Field[]>(() => {
  const device = props.device;
  const info = device.vehicleInfo;
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
    {
      label: "车端任务",
      value: orMissing(formatEnum(device.taskStatus, taskStatusMap)),
      title: describeEnum(device.taskStatus, taskStatusMap),
    },
    { label: "场景", value: props.sceneLabel },
    {
      label: "融合定位",
      value: hasPose(device.fusionLoc)
        ? `x ${formatNumber(device.fusionLoc?.x, 2)} · y ${formatNumber(device.fusionLoc?.y, 2)}`
        : MISSING,
    },
    {
      label: "经纬度",
      value:
        device.gpsEnabled !== false && hasGps(device.gps)
          ? `${formatNumber(device.gps?.lng, 6)}, ${formatNumber(device.gps?.lat, 6)}`
          : MISSING,
    },
    {
      label: "编队",
      value: props.formationNames.length
        ? props.formationNames.join("、")
        : "未编入编队",
    },
  ];
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

    <!--
      One row: the active codes on the left, the two actions anchored right (`ml-auto`).
      Everything here is one button height (`h-8`) so the codes and the actions read as a
      single toolbar rather than three unrelated sizes. The codes are non-interactive
      status pills, only sized to match; the actions are real `UiButton`s.
    -->
    <div class="flex flex-wrap items-center gap-2">
      <span
        v-for="alert in previewAlerts"
        :key="alert.id"
        class="inline-flex h-8 items-center rounded-sm border px-3 text-sm"
        :class="SEVERITY_CLASS[alert.severity] ?? SEVERITY_CLASS.notice"
      >
        {{ alert.title }}
      </span>
      <span v-if="hiddenAlertCount" class="text-xs text-ink-muted">
        另有 {{ hiddenAlertCount }} 条
      </span>

      <div class="ml-auto flex items-center gap-2">
        <UiButton
          :as="RouterLink"
          :to="`/devices/${device.deviceId}`"
          variant="secondary"
          size="sm"
        >
          打开详情 →
        </UiButton>
        <!--
          Selecting is a separate act from opening: the map centres on
          `selectedDeviceId`, so this is how someone lines up a vehicle in the list and
          then switches to the map to watch it move.
        -->
        <UiButton
          variant="secondary"
          size="sm"
          @click="$emit('focus-on-map', device.deviceId)"
        >
          在地图上选中
        </UiButton>
      </div>
    </div>
  </div>
</template>
