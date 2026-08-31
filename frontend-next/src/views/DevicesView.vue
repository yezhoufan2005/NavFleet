<script setup lang="ts">
/**
 * 设备 — one collection with two projections: a list and a map.
 *
 * Both show the same set. Which one opens first is decided by fleet size with a
 * 40-unit threshold (`docs/frontend-ia.md` §5.1), and the threshold only decides the
 * *first* visit: switching views is remembered and wins over the automatic guess, so
 * getting the threshold wrong costs one click rather than a permanently awkward
 * default. See `useDeviceView` for why that needs three stored states and not a
 * boolean.
 *
 * The map is the page body rather than a panel in a grid — that is the substantive
 * IA change here. In v1.0.0 the map was one cell of a crowded dashboard, roughly
 * 40% of the viewport; a site map that small is a picture of a map rather than a
 * usable one.
 */
import { computed, watch } from "vue";
import { storeToRefs } from "pinia";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import GpsMap from "@/components/map/GpsMap.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import { useFleetStore } from "@/stores/fleet";
import { useDeviceView } from "@/composables/useDeviceView";
import type {
  DeviceLayoutPreference,
  MapSurface,
} from "@/composables/useDeviceView";
import {
  deviceToneLabels,
  formatNumber,
  formatStamp,
  getDeviceTone,
} from "@navfleet/fleet-core";

const fleet = useFleetStore();
const { state } = storeToRefs(fleet);
const route = useRoute();
const router = useRouter();

const devices = computed(() => fleet.filteredDevices);
const {
  layout,
  layoutIsAutomatic,
  layoutPreference,
  setLayout,
  surface,
  setSurface,
} = useDeviceView(() => fleet.sortedDevices.length);

const sceneDefinition = computed(() =>
  fleet.formationSceneId
    ? fleet.getSceneDefinition(fleet.formationSceneId)
    : null,
);

const LAYOUT_OPTIONS: { value: DeviceLayoutPreference; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "list", label: "列表" },
  { value: "map", label: "地图" },
];

const SURFACE_OPTIONS: { value: MapSurface; label: string }[] = [
  { value: "gps", label: "GPS" },
  { value: "scene", label: "场景" },
];

/**
 * Scene identity, three ways — because `--` conflated two different facts.
 *
 * A device with no `sceneId` is **not configured**; one whose id we hold but whose
 * definition has not arrived yet is configured and merely unnamed. The old front end
 * said 未配置场景 for the first case (`DashboardView.vue:87`) and that distinction was
 * lost in the port. The raw id is kept as the middle rung rather than hidden: it is
 * still the answer to "which scene", just not a human-readable one.
 */
const sceneLabelOf = (sceneId: string | null | undefined): string => {
  if (!sceneId) return "未配置场景";
  // `SceneDefinitionRecord` is a union with the loose merged shape, so `sceneName` is
  // `unknown` on that arm — the same cast `DevicePlaybackTab.vue:306` makes.
  return (fleet.getSceneDefinition(sceneId)?.sceneName as string) || sceneId;
};

/** Sorted worst-first, so the row that needs attention is the one you land on. */
const rows = computed(() =>
  devices.value.map((device) => ({
    device,
    tone: getDeviceTone(device),
    label: deviceToneLabels[getDeviceTone(device)],
    sceneLabel: sceneLabelOf(device.sceneId),
    // Two columns v1.0.0 had and the port dropped. Without them "谁快没电了、谁的数据
    // 停了" needs one detail page per vehicle instead of one glance at the list.
    stamp: formatStamp(device.stamp),
    soc: formatNumber(device.vehicleInfo?.soc, 0, "%"),
  })),
);

const TONE_DOT: Record<string, string> = {
  normal: "bg-brand",
  notice: "bg-notice",
  warning: "bg-warning",
  critical: "bg-critical",
  offline: "bg-offline",
};

/**
 * Empty value clears rather than selects, so 全部编队 is a real option instead of a
 * sentinel formation id.
 *
 * **The URL writes, the watcher reads, and nothing does both.** 告警 already treats the
 * query string as the source of truth for its filters (`AlertsView.vue:67-72`) so that a
 * pasted link reproduces the view; the same has to hold here, but the *state* cannot
 * live in the URL — `filteredDevices` and `sceneDevices` derive from
 * `state.selectedFormationId`, so the store has to hold it. Splitting the directions is
 * what keeps that from becoming a two-way sync: this handler only navigates, and the
 * watcher below is the only thing that touches the store.
 */
const onFormationChange = (event: Event): void => {
  const value = (event.target as HTMLSelectElement).value;
  void router.replace({
    query: { ...route.query, formation: value || undefined },
  });
};

/**
 * Also keyed on the formation count, not just the query: formations arrive with the
 * first snapshot, and `selectFormation` silently ignores an id it does not know yet.
 * Without that dependency a deep link that lands before the socket connects would be
 * dropped on the floor — which is precisely the case a deep link exists for.
 */
watch(
  [() => route.query.formation, () => fleet.sortedFormations.length],
  ([raw]) => {
    const wanted = typeof raw === "string" ? raw : "";
    if (wanted === state.value.selectedFormationId) return;
    if (wanted) fleet.selectFormation(wanted);
    else fleet.clearFormationSelection();
  },
  { immediate: true },
);
</script>

<template>
  <PageHeader
    title="设备"
    lede="列表与地图是同一批设备的两种投影，可随时切换。"
  >
    <template #actions>
      <!--
        The formation filter, which the port declared and never built: the store has
        exported `sortedFormations` / `selectFormation` / `clearFormationSelection`
        since 12B with **zero** callers, so `selectedFormationId` was permanently `""`
        and `filteredDevices` was always the whole fleet. That is the clearest instance
        of the pattern the parity pass turned up — the logic layer came over whole and
        the control that drives it did not.

        A `<select>` rather than the old chip strip: chips were sized for a dashboard
        panel, and this header already carries two button groups. It matches the filter
        controls on 告警 (`AlertsView.vue:244-264`), so the two pages filter the same way.

        Hidden when there are no formations — an empty filter is worse than no filter,
        and the 总览 card already says 未配置编队.
      -->
      <label
        v-if="fleet.sortedFormations.length"
        class="flex items-center gap-2"
      >
        <span class="font-mono text-2xs text-ink-subtle">编队</span>
        <select
          class="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink"
          :value="state.selectedFormationId"
          @change="onFormationChange"
        >
          <option value="">全部编队</option>
          <option
            v-for="formation in fleet.sortedFormations"
            :key="formation.formationId"
            :value="formation.formationId"
          >
            {{ formation.formationName || formation.formationId }}（{{
              formation.deviceCount
            }}）
          </option>
        </select>
      </label>

      <!--
        The conditional group comes first, so it grows leftward into empty space.
        `PageHeader` right-anchors the actions block, so a group that appears and
        disappears on the *right* shoves the permanent one sideways every time you
        switch to the map — the buttons move out from under the pointer.
      -->
      <div
        v-if="layout === 'map'"
        class="flex overflow-hidden rounded-sm border border-border-strong"
        role="group"
        aria-label="底图"
      >
        <button
          v-for="option in SURFACE_OPTIONS"
          :key="option.value"
          type="button"
          class="px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            surface === option.value
              ? 'bg-brand text-brand-contrast'
              : 'bg-surface-raised text-ink-muted hover:text-ink'
          "
          :aria-pressed="surface === option.value"
          @click="setSurface(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <!-- Buttons with `aria-pressed` rather than a select: three options that are
           all worth showing, and the current one has to be visible at a glance. -->
      <div
        class="flex overflow-hidden rounded-sm border border-border-strong"
        role="group"
        aria-label="视图"
      >
        <button
          v-for="option in LAYOUT_OPTIONS"
          :key="option.value"
          type="button"
          class="px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            layoutPreference === option.value
              ? 'bg-brand text-brand-contrast'
              : 'bg-surface-raised text-ink-muted hover:text-ink'
          "
          :aria-pressed="layoutPreference === option.value"
          @click="setLayout(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </template>

    <p v-if="layoutIsAutomatic" class="text-xs text-ink-muted">
      当前视图按车队规模自动选择（{{ fleet.sortedDevices.length }}
      台）。选择「列表」或「地图」后将一直沿用你的选择。
    </p>

    <div
      v-if="!devices.length"
      class="grid place-content-center gap-2 rounded-md border border-border bg-surface-raised p-10 text-center"
    >
      <strong class="text-md text-ink">{{
        fleet.bootstrapPending ? "正在加载车队…" : "暂无设备"
      }}</strong>
      <span class="text-sm text-ink-muted">{{
        fleet.bootstrapPending
          ? "正在获取车队快照。"
          : "后端还没有上报任何设备；确认 MQTT 接入后此处会自动出现。"
      }}</span>
    </div>

    <!-- The map is the body, with the list beside it as a `complementary` panel —
         which is what that role is for, unlike the navigation rail. -->
    <div v-else-if="layout === 'map'" class="flex min-h-0 flex-1 gap-4">
      <div
        class="map-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface-raised"
      >
        <!--
          `sortedDevices`, not `devices` — the two maps take deliberately different
          sets, and the port had flattened that.

          The GPS map answers "where is the fleet", so a formation filter must not make
          vehicles vanish from it: geography is context, and a half-empty site map reads
          as "those vehicles are gone" rather than "those vehicles are filtered out".
          The scene map answers "what are *these* vehicles doing in this scene", so it
          takes the narrowed set (`sceneDevices` also requires the device to be in the
          formation's scene and to have the ROS map enabled).

          v1.0.0 drew the same line — `DashboardView.vue:303` passed `sortedDevices`
          here. It is currently invisible either way because no formation can be
          selected yet, which is exactly why this belongs in the same change as the
          formation control below rather than in a commit of its own.
        -->
        <GpsMap
          v-if="surface === 'gps'"
          :devices="fleet.sortedDevices"
          :selected-device-id="state.selectedDeviceId"
          @select="fleet.selectDevice"
        />
        <SceneMap
          v-else
          :selected-device="fleet.selectedDevice"
          :scene-definition="sceneDefinition"
          :scene-devices="fleet.sceneDevices"
          :trails="fleet.trailsByDeviceId"
        />
      </div>

      <aside
        class="hidden w-64 shrink-0 flex-col overflow-y-auto rounded-md border border-border bg-surface-raised p-2 xl:flex"
        aria-label="设备列表"
      >
        <button
          v-for="row in rows"
          :key="row.device.deviceId"
          type="button"
          class="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors duration-150 ease-standard"
          :class="
            row.device.deviceId === state.selectedDeviceId
              ? 'bg-brand-wash text-brand-ink'
              : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
          "
          @click="fleet.selectDevice(row.device.deviceId)"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="TONE_DOT[row.tone]"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate">{{
            row.device.deviceName || row.device.deviceId
          }}</span>
          <span class="shrink-0 font-mono text-2xs">{{ row.label }}</span>
        </button>

        <!--
          Clicking a row here *selects* — that is this panel's job, because the map has
          to be told which vehicle to centre on. But the detail page has to be reachable
          from the map too (`frontend-ia.md`: from the list, the map or an alert), so the
          selected vehicle gets one link rather than every row getting a second control.
        -->
        <RouterLink
          v-if="fleet.selectedDevice"
          :to="`/devices/${fleet.selectedDevice.deviceId}`"
          class="mt-2 shrink-0 rounded-sm border border-border-strong px-2 py-2 text-center text-xs text-brand-ink transition-colors duration-150 ease-standard hover:bg-surface-sunken"
        >
          打开详情 →
        </RouterLink>
      </aside>
    </div>

    <div
      v-else
      class="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-surface-raised"
    >
      <table class="w-full border-collapse text-sm">
        <caption class="sr-only">
          设备列表，共
          {{
            rows.length
          }}
          台
        </caption>
        <thead>
          <tr class="border-b border-border text-left">
            <th
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
            >
              状态
            </th>
            <th
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
            >
              设备
            </th>
            <th
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
            >
              编号
            </th>
            <th
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
            >
              场景
            </th>
            <th
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
            >
              最近上报
            </th>
            <th
              class="px-3 py-2 text-right font-mono text-2xs font-normal text-ink-subtle"
            >
              电量
            </th>
          </tr>
        </thead>
        <tbody>
          <!--
            No selected-row highlight here, and that is the fix for a real bug rather
            than a styling preference.

            `ensureSelectedDevice` picks the first vehicle on every ingest when nothing
            valid is selected, because the **map** needs a subject — `SceneMap` centres
            on `selectedDevice` and would otherwise show nothing. That is right for the
            map and wrong to render in the list: the first row came up highlighted
            without anyone clicking it, so the highlight carried no intent and read as
            "this row is special" when it is only "this is row one".

            The map's own side panel keeps its highlight, where it does mean something:
            the vehicle the map is currently showing, and it moves when you click.
          -->
          <tr
            v-for="row in rows"
            :key="row.device.deviceId"
            class="device-row border-b border-border last:border-0"
            :data-tone="row.tone"
          >
            <td class="px-3 py-2">
              <span class="flex items-center gap-2 text-ink-muted">
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="TONE_DOT[row.tone]"
                  aria-hidden="true"
                />
                {{ row.label }}
              </span>
            </td>
            <td class="px-3 py-2">
              <!--
                A link to the device, not a button that only moves the map's selection.
                Until this changed, a healthy vehicle's detail page — and therefore the
                four tabs on it — could not be reached by clicking anything: this cell
                only called `selectDevice`, and 总览's list links but shows at most six
                vehicles and only abnormal ones.

                It still sets the selection on the way out, so coming back to the map
                lands on the vehicle you just looked at.
              -->
              <RouterLink
                :to="`/devices/${row.device.deviceId}`"
                class="text-ink underline-offset-2 hover:text-brand-ink hover:underline"
                @click="fleet.selectDevice(row.device.deviceId)"
              >
                {{ row.device.deviceName || row.device.deviceId }}
              </RouterLink>
            </td>
            <td class="px-3 py-2 font-mono text-xs text-ink-muted">
              {{ row.device.deviceId }}
            </td>
            <td class="px-3 py-2 text-ink-muted">
              {{ row.sceneLabel }}
            </td>
            <td class="px-3 py-2 text-ink-muted">
              {{ row.stamp }}
            </td>
            <td class="px-3 py-2 text-right font-mono text-xs text-ink">
              {{ row.soc }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </PageHeader>
</template>

<style scoped>
/*
 * Scoped CSS rather than utilities, for the same reason `SceneMap.vue` uses it: the
 * variants are keyed on a *runtime* tone, and Tailwind only sees literal strings, so
 * five tones would mean five literal class names in the template. Every value is a
 * token, so this follows the theme — no `dark:` here and there should not be.
 *
 * Hover lives here too. It used to be a `hover:bg-surface-sunken` utility, but a tone
 * tint and a hover tint are the same property: leaving them in two systems makes which
 * one wins depend on stylesheet order, which is not something a template should be
 * betting on.
 *
 * **What these three rules restore.** v1.0.0 tinted the whole row for critical and
 * warning (`device-list.css:35-41`, a drop shadow on a card) and faded offline ones to
 * `.74` (`:43-45`); the port kept only the status dot. A dot answers "what is this
 * row's state" once you are already reading the row — the row treatment is what makes
 * the answer arrive before you read anything, which is the whole point of a list you
 * scan. Translated to a table the shadow becomes an inset left edge: a 44px drop
 * shadow is card furniture and would just blur into the neighbouring rows.
 *
 * `notice` deliberately gets nothing, matching v1.0.0 — if every non-normal state is
 * highlighted, none of them is.
 */
.device-row {
  transition: background-color 150ms var(--ease-standard);
}

.device-row:hover {
  background: var(--color-surface-sunken);
}

.device-row[data-tone="critical"] {
  background: color-mix(in oklab, var(--color-critical-wash) 60%, transparent);
  box-shadow: inset 3px 0 0 var(--color-critical);
}

.device-row[data-tone="warning"] {
  background: color-mix(in oklab, var(--color-warning-wash) 60%, transparent);
  box-shadow: inset 3px 0 0 var(--color-warning);
}

.device-row[data-tone="critical"]:hover,
.device-row[data-tone="warning"]:hover {
  background: color-mix(in oklab, var(--color-surface-sunken) 70%, transparent);
}

/* Not `display: none` territory — an offline vehicle is still one you may need to
   open. It recedes so the live ones read first. */
.device-row[data-tone="offline"] {
  opacity: 0.74;
}
</style>
