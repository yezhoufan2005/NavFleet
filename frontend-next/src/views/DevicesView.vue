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
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { RouterLink } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import GpsMap from "@/components/map/GpsMap.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import { useFleetStore } from "@/stores/fleet";
import { useDeviceView } from "@/composables/useDeviceView";
import type {
  DeviceLayoutPreference,
  MapSurface,
} from "@/composables/useDeviceView";
import { deviceToneLabels, getDeviceTone } from "@navfleet/fleet-core";

const fleet = useFleetStore();
const { state } = storeToRefs(fleet);

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

/** Sorted worst-first, so the row that needs attention is the one you land on. */
const rows = computed(() =>
  devices.value.map((device) => ({
    device,
    tone: getDeviceTone(device),
    label: deviceToneLabels[getDeviceTone(device)],
  })),
);

const TONE_DOT: Record<string, string> = {
  normal: "bg-brand",
  notice: "bg-notice",
  warning: "bg-warning",
  critical: "bg-critical",
  offline: "bg-offline",
};
</script>

<template>
  <PageHeader
    title="设备"
    lede="列表与地图是同一批设备的两种投影，可随时切换。"
  >
    <template #actions>
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
        <GpsMap
          v-if="surface === 'gps'"
          :devices="devices"
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
            class="border-b border-border last:border-0 hover:bg-surface-sunken"
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
              {{ row.device.sceneId || "--" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </PageHeader>
</template>
