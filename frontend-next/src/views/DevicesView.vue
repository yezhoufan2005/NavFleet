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
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import UiSkeleton from "@/components/ui/UiSkeleton.vue";
import GpsMap from "@/components/map/GpsMap.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import DeviceRowCard from "@/components/device/DeviceRowCard.vue";
import { useFleetStore } from "@/stores/fleet";
import { useDeviceView } from "@/composables/useDeviceView";
import { useDeviceSort } from "@/composables/useDeviceSort";
import type { DeviceSortKey } from "@/composables/useDeviceSort";
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

const { sortKey, sortDirection, toggleSort, ariaSortFor, sortRows } =
  useDeviceSort();

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

/**
 * `ROS` rather than 场景 for the second surface. Both maps show a scene; what tells them
 * apart is the frame the positions are in — GPS is lat/lng, the other is the vehicle's
 * own ROS map frame, which is also the word the vehicles and their operators already use.
 */
const SURFACE_OPTIONS: { value: MapSurface; label: string }[] = [
  { value: "gps", label: "GPS" },
  { value: "scene", label: "ROS" },
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

/**
 * One row per device, in the order the column headers say — 编号 ascending until someone
 * clicks a header. See `useDeviceSort` for why the register keeps a stable order and
 * 总览 is the page that sorts by trouble.
 */
const rows = computed(() =>
  sortRows(
    devices.value.map((device) => ({
      device,
      tone: getDeviceTone(device),
      label: deviceToneLabels[getDeviceTone(device)],
      sceneLabel: sceneLabelOf(device.sceneId),
      // Two columns v1.0.0 had and the port dropped. Without them "谁快没电了、谁的数据
      // 停了" needs one detail page per vehicle instead of one glance at the list.
      stamp: formatStamp(device.stamp),
      soc: formatNumber(device.vehicleInfo?.soc, 0, "%"),
      formationNames: (device.formationIds ?? []).map(
        (formationId) =>
          state.value.formationsById[formationId]?.formationName || formationId,
      ),
    })),
  ),
);

/**
 * Which rows are expanded. A Set rather than a single id, because comparing two
 * vehicles side by side is a real thing to want and closing one to open another would
 * make it impossible.
 *
 * Not in the URL, unlike the sort: an expanded row is a glance, not a view worth
 * sending to someone. Ids that leave the fleet are dropped so the set cannot grow for
 * the lifetime of the tab — the same pruning-on-clear rule the trail map follows.
 */
const expandedIds = ref(new Set<string>());

const toggleExpanded = (deviceId: string): void => {
  const next = new Set(expandedIds.value);
  if (!next.delete(deviceId)) next.add(deviceId);
  expandedIds.value = next;
};

watch(
  () => rows.value.map((row) => row.device.deviceId).join(","),
  () => {
    if (!expandedIds.value.size) return;
    const present = new Set(rows.value.map((row) => row.device.deviceId));
    const kept = [...expandedIds.value].filter((id) => present.has(id));
    if (kept.length !== expandedIds.value.size) {
      expandedIds.value = new Set(kept);
    }
  },
);

/** Header cells, in render order. Every one of them sorts — see `useDeviceSort`. */
const COLUMNS: { key: DeviceSortKey; label: string; numeric?: boolean }[] = [
  { key: "tone", label: "状态" },
  { key: "name", label: "设备" },
  { key: "id", label: "编号" },
  { key: "scene", label: "场景" },
  { key: "stamp", label: "最近上报" },
  { key: "soc", label: "电量", numeric: true },
];

const TONE_DOT: Record<string, string> = {
  normal: "bg-brand",
  notice: "bg-notice",
  warning: "bg-warning",
  critical: "bg-critical",
  offline: "bg-offline",
};

/**
 * How many points the selected vehicle's trail is carrying, once it is long enough to
 * draw.
 *
 * A single point is not a trail — `buildWorldPath` turns it into a bare `M x y`, which
 * renders nothing — and one arrives with the very first telemetry message. Reporting it
 * would put a 清除轨迹 button on screen permanently, offering to clear something the
 * operator cannot see.
 */
const selectedTrailLength = computed(() => {
  const deviceId = fleet.selectedDevice?.deviceId;
  const length = deviceId ? (fleet.trailsByDeviceId[deviceId]?.length ?? 0) : 0;
  return length > 1 ? length : 0;
});

const clearSelectedTrail = (): void => {
  const deviceId = fleet.selectedDevice?.deviceId;
  if (deviceId) fleet.clearTrail(deviceId);
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
  <PageHeader title="设备" fill-height>
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
      自动按车队规模选择视图（{{ fleet.sortedDevices.length }}
      台），选择「列表」或「地图」后将沿用您的选择。
    </p>

    <!--
      A cold load gets rows, not a centred message. Which one you see is the difference
      between "the fleet is empty" and "we have not been told yet", and the empty-state
      card was answering both — the `bootstrapPending` copy told you a request was in
      flight while its own layout said "there is nothing here".

      `aria-busy` on the region, because `UiSkeleton` is `aria-hidden` and this is the
      only thing that carries the state to a screen reader.
    -->
    <div
      v-if="fleet.bootstrapPending && !devices.length"
      class="rounded-md border border-border bg-surface-raised p-4"
      aria-busy="true"
    >
      <p class="mt-0 mb-3 text-sm text-ink-muted">正在获取车队快照…</p>
      <UiSkeleton :rows="5" variant="card" />
    </div>

    <div
      v-else-if="!devices.length"
      class="grid place-content-center gap-2 rounded-md border border-border bg-surface-raised p-10 text-center"
    >
      <strong class="text-md text-ink">{{
        state.selectedFormationId ? "该编队下没有设备" : "暂无设备"
      }}</strong>
      <span class="text-sm text-ink-muted">{{
        state.selectedFormationId
          ? "这个编队目前没有匹配的设备；选择「全部编队」可以看到完整车队。"
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

        <!--
          The control for `clearTrail`, which the store has exported since 12B with no
          caller. A trail accumulates for as long as a vehicle is watched, so after a
          shift the selected vehicle's path is a scribble over the whole site and there
          was no way to start it again short of a reload.

          Only shown when there is something to clear — a permanently disabled button
          teaches people to stop reading the toolbar.
        -->
        <button
          v-if="selectedTrailLength"
          type="button"
          class="mt-1 shrink-0 rounded-sm border border-border-strong px-2 py-2 text-center text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
          @click="clearSelectedTrail"
        >
          清除轨迹（{{ selectedTrailLength }} 点）
        </button>
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
            <!--
              The expand column has no label, and `sr-only` text rather than an empty
              `th`: a blank header cell is announced as nothing at all, so the column's
              buttons arrive with no context.
            -->
            <th class="w-8 px-1 py-2">
              <span class="sr-only">展开</span>
            </th>
            <!--
              Every header is a button inside a `th` carrying `aria-sort`. That pairing is
              the pattern rather than a clickable `th`, because a `th` is not focusable
              and a sort that only a mouse can reach is not a sort everyone has.
            -->
            <th
              v-for="column in COLUMNS"
              :key="column.key"
              class="px-3 py-2 font-mono text-2xs font-normal text-ink-subtle"
              :class="column.numeric ? 'text-right' : 'text-left'"
              :aria-sort="ariaSortFor(column.key)"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1 font-mono text-2xs text-ink-subtle transition-colors duration-150 ease-standard hover:text-ink"
                :class="[
                  column.numeric ? 'flex-row-reverse' : '',
                  sortKey === column.key ? 'text-ink' : '',
                ]"
                @click="toggleSort(column.key)"
              >
                {{ column.label }}
                <!--
                  The arrow is only on the active column. A permanent up/down glyph on
                  all six says "sortable" and then says nothing about which one is in
                  effect, which is the half that matters once you have clicked one.
                -->
                <span v-if="sortKey === column.key" aria-hidden="true">
                  {{ sortDirection === "asc" ? "↑" : "↓" }}
                </span>
              </button>
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
          <template v-for="row in rows" :key="row.device.deviceId">
            <!--
              Clicking anywhere on the row toggles its card. The chevron is the real
              control — a `<tr>` handler is mouse-only — and the device link stops
              propagation, because a click target inside a click target is how you get
              "I clicked the row and it navigated instead".
            -->
            <tr
              class="device-row border-b border-border last:border-0"
              :data-tone="row.tone"
              :data-expanded="expandedIds.has(row.device.deviceId) || undefined"
              @click="toggleExpanded(row.device.deviceId)"
            >
              <td class="px-1 py-2">
                <button
                  type="button"
                  class="grid size-6 place-content-center rounded-sm text-ink-subtle transition-colors duration-150 ease-standard hover:text-ink"
                  :aria-expanded="expandedIds.has(row.device.deviceId)"
                  :aria-controls="`device-card-${row.device.deviceId}`"
                  :aria-label="`${row.device.deviceName || row.device.deviceId} 详情`"
                  @click.stop="toggleExpanded(row.device.deviceId)"
                >
                  <span aria-hidden="true" class="text-2xs">
                    {{ expandedIds.has(row.device.deviceId) ? "▾" : "▸" }}
                  </span>
                </button>
              </td>
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
                  @click.stop="fleet.selectDevice(row.device.deviceId)"
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
            <tr
              v-if="expandedIds.has(row.device.deviceId)"
              :id="`device-card-${row.device.deviceId}`"
              class="border-b border-border last:border-0"
            >
              <td :colspan="COLUMNS.length + 1" class="p-0">
                <DeviceRowCard
                  :device="row.device"
                  :scene-label="row.sceneLabel"
                  :formation-names="row.formationNames"
                  @focus-on-map="fleet.selectDevice"
                />
              </td>
            </tr>
          </template>
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
  cursor: pointer;
}

.device-row:hover {
  background: var(--color-surface-sunken);
}

/* The open row and its card read as one block. Without this the card looks like a
   separate panel that happens to be underneath, rather than this row's own detail. */
.device-row[data-expanded] {
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
