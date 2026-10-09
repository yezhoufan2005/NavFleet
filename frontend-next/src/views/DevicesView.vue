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
import UiButton from "@/components/ui/UiButton.vue";
import UiSkeleton from "@/components/ui/UiSkeleton.vue";
import GpsMap from "@/components/map/GpsMap.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import DeviceRowCard from "@/components/device/DeviceRowCard.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiSegmented from "@/components/ui/UiSegmented.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import { tableClasses } from "@/lib/uiClasses";
import { useFleetStore } from "@/stores/fleet";
import { useListPagination } from "@/composables/useListPagination";
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

/**
 * The device ids 适应车队 frames on the GPS map. The GPS surface keeps showing the whole
 * fleet (a filter must not make a vehicle vanish from geography), but when a formation is
 * selected the fit should frame *that* formation rather than the whole fleet — so this is
 * the narrowed set when a formation is active, and empty (= frame everything) otherwise.
 */
const gpsFitDeviceIds = computed(() =>
  state.value.selectedFormationId
    ? fleet.filteredDevices.map((device) => device.deviceId)
    : [],
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
 * List filters (list view only): a free-text search over name/id, plus status and scene
 * drop-downs. Local refs rather than the URL — the formation filter and sort are the
 * shareable view; these are a quick narrowing while scanning, not part of the link. They
 * apply on top of the formation filter (which already narrowed `devices`).
 */
const deviceSearch = ref("");
const statusFilter = ref<string[]>([]);
const sceneFilter = ref<string[]>([]);

const TONE_ORDER = [
  "normal",
  "notice",
  "warning",
  "critical",
  "offline",
] as const;

type DeviceRow = (typeof rows)["value"][number];

const matchSearch = (row: DeviceRow): boolean => {
  const query = deviceSearch.value.trim().toLowerCase();
  if (!query) return true;
  return (
    (row.device.deviceName || "").toLowerCase().includes(query) ||
    row.device.deviceId.toLowerCase().includes(query)
  );
};
// Multi-select: an empty set means "all"; otherwise the value must be in the set.
const matchStatus = (row: DeviceRow): boolean =>
  statusFilter.value.length === 0 || statusFilter.value.includes(row.tone);
const matchScene = (row: DeviceRow): boolean =>
  sceneFilter.value.length === 0 ||
  sceneFilter.value.includes(row.device.sceneId);

/**
 * Faceted options: each dropdown offers only the values that still have matching rows
 * under the *other* active filters — so filtering 状态=预警 (or searching agv-a03) narrows
 * 场景 to just the scenes that have such a vehicle. An already-selected value is kept in
 * the list regardless, so it can always be unticked. 状态 keeps its fixed severity order.
 */
const STATUS_OPTIONS = computed(() => {
  const present = new Set(
    rows.value
      .filter((row) => matchSearch(row) && matchScene(row))
      .map((row) => row.tone),
  );
  return TONE_ORDER.filter(
    (tone) => present.has(tone) || statusFilter.value.includes(tone),
  ).map((tone) => ({ value: tone, label: deviceToneLabels[tone] }));
});
const sceneOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const row of rows.value.filter(
    (row) => matchSearch(row) && matchStatus(row),
  )) {
    const id = row.device.sceneId;
    if (id && !seen.has(id)) seen.set(id, row.sceneLabel);
  }
  // Keep a selected scene listed even if the other filters currently hide its rows.
  for (const id of sceneFilter.value) {
    if (!seen.has(id)) {
      const row = rows.value.find(
        (candidate) => candidate.device.sceneId === id,
      );
      if (row) seen.set(id, row.sceneLabel);
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
});

const filteredRows = computed(() =>
  rows.value.filter(
    (row) => matchSearch(row) && matchStatus(row) && matchScene(row),
  ),
);

/**
 * Pagination, same shape as 告警's: page size and page both in the URL, and a clamp.
 *
 * The list did not have it, and «scroll a 200-row table» is not the same capability —
 * pagination is what makes "the vehicle I want is on page 3" a thing you can say to a
 * colleague, because the page number travels in the link like the sort does. The state
 * and controls are the shared `useListPagination` + `UiListPagination` (default 10/页,
 * sizes 10/20/50 in the URL), the same as 消息 / 审计 / 外发.
 */
const { page, pageSize, pageCount, pageItems, setPage, setPageSize } =
  useListPagination(filteredRows);
const pageRows = pageItems;

/**
 * The one expanded row, or null. An accordion: opening a row closes the previous one, so
 * at most one card is open at a time (a per-row request — a stack of open cards turns the
 * scannable list into a wall). The expand/collapse is animated as a slide, see the
 * `dev-expand` transition in the scoped styles.
 *
 * Not in the URL, unlike the sort: an expanded row is a glance, not a view worth sending
 * to someone. An id that leaves the fleet is dropped, so a stale id cannot keep a ghost
 * row open — the same pruning-on-clear rule the trail map follows.
 */
const expandedId = ref<string | null>(null);

const toggleExpanded = (deviceId: string): void => {
  expandedId.value = expandedId.value === deviceId ? null : deviceId;
};

watch(
  () => rows.value.map((row) => row.device.deviceId).join(","),
  () => {
    if (expandedId.value === null) return;
    const present = rows.value.some(
      (row) => row.device.deviceId === expandedId.value,
    );
    if (!present) expandedId.value = null;
  },
);

/**
 * A right-aligned **value** cell reserves the header's arrow slot, so that 电量's label and
 * its numbers stay flush with each other.
 *
 * The arrow is always on the label's right (14G), and on the one right-aligned column that
 * put it between the label and the cell edge: selecting 电量 pushed its own label 14px to
 * the left, which is the shift acceptance reported. So the slot is now reserved on every
 * header whether or not the arrow is showing — and the reserve has to be **mirrored onto
 * the values**, because the slot sits inside the header's own box and would otherwise leave
 * the label 14px left of the column it heads. That was the 14I report: the label moved and
 * the numbers did not.
 *
 * Only the `td` carries it. Putting it on the `th` as well (the first attempt) reserved the
 * space *twice* there — `pr` plus the slot inside the button — which is the same defect one
 * step further out.
 *
 * `px-3` (0.75rem) + the slot (`gap-1` 0.25rem + `w-2.5` 0.625rem) = 1.625rem.
 */
const NUMERIC_VALUE_CLASS = "pl-3 pr-[1.625rem] py-2 text-right";
/** The header keeps the plain padding: its reserve is the slot inside the button. */
const NUMERIC_HEAD_CLASS = "px-3 py-2 text-right";

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
 * 地图选中 — select the vehicle *and* switch to the ROS scene map focused on it, so the
 * button lands you looking at that vehicle in its scene rather than just marking it in a
 * list you are still reading. The layout preference is remembered, which is fine: the
 * operator asked to see this on the map.
 */
const focusOnMap = (deviceId: string): void => {
  fleet.selectDevice(deviceId);
  setSurface("scene");
  setLayout("map");
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
const onFormationChange = (value: string): void => {
  void router.replace({
    query: { ...route.query, formation: value || undefined },
  });
};

/**
 * 全部编队 pinned first, the rest by name.
 *
 * The "all" row is the empty value — a real option rather than a sentinel id — and it is
 * pinned because it is not a peer of the others: it is the way back out of the filter, and
 * a way out that moves depending on how the list happens to collate is one people stop
 * trusting. Everything below it collates by *name*, not by `formationId`, which is what
 * the store sorts by: an id is an identifier, and ordering a menu someone reads by it
 * produces an order only the database understands.
 */
const formationOptions = computed(() => [
  { value: "", label: "全部编队" },
  ...fleet.sortedFormations
    .map((formation) => ({
      value: formation.formationId,
      name: formation.formationName || formation.formationId,
      count: formation.deviceCount,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"))
    .map((formation) => ({
      value: formation.value,
      label: `${formation.name}（${formation.count}）`,
    })),
]);

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
  <!--
    `fillHeight` only for the map. 14E turned it on for the whole page, which was right for
    the map (it had been getting 279px of an 852px `main`) and wrong for the list:
    acceptance reported the list as fixed-length, and it was — a six-row table stretched
    into a 775px panel with its own scroller and a lot of ruled emptiness under the last
    row. A list should be as tall as its rows; a map should be as tall as the page.
  -->
  <PageHeader title="设备" :fill-height="layout === 'map'">
    <template #actions>
      <!--
        The formation filter, which the port declared and never built: the store has
        exported `sortedFormations` / `selectFormation` / `clearFormationSelection`
        since 12B with **zero** callers, so `selectedFormationId` was permanently `""`
        and `filteredDevices` was always the whole fleet. That is the clearest instance
        of the pattern the parity pass turned up — the logic layer came over whole and
        the control that drives it did not.

        A select rather than the old chip strip: chips were sized for a dashboard panel,
        and this header already carries two button groups. It matches the filter controls
        on 消息, so the two pages filter the same way — and both now use `UiSelect`, whose
        list opens below the control instead of the native popup's over it.

        Hidden when there are no formations — an empty filter is worse than no filter,
        and the 总览 card already says 未配置编队.
      -->
      <label
        v-if="fleet.sortedFormations.length"
        class="flex items-center gap-2"
      >
        <span class="text-2xs text-ink-muted">编队</span>
        <UiSelect
          :model-value="state.selectedFormationId"
          :options="formationOptions"
          aria-label="编队筛选"
          @update:model-value="onFormationChange"
        />
      </label>

      <!--
        The conditional group comes first, so it grows leftward into empty space.
        `PageHeader` right-anchors the actions block, so a group that appears and
        disappears on the *right* shoves the permanent one sideways every time you
        switch to the map — the buttons move out from under the pointer.
      -->
      <UiSegmented
        v-if="layout === 'map'"
        :model-value="surface"
        :options="SURFACE_OPTIONS"
        aria-label="底图"
        @update:model-value="(value) => setSurface(value as MapSurface)"
      />

      <!-- Buttons with `aria-pressed` rather than a select: three options that are
           all worth showing, and the current one has to be visible at a glance. -->
      <UiSegmented
        :model-value="layoutPreference"
        :options="LAYOUT_OPTIONS"
        aria-label="视图"
        @update:model-value="
          (value) => setLayout(value as DeviceLayoutPreference)
        "
      />
    </template>

    <p v-if="layoutIsAutomatic" class="text-xs text-ink-muted">
      自动按车队规模选择视图（{{ fleet.sortedDevices.length }}
      台），选择「列表」或「地图」后将沿用您的选择
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
          ? "这个编队目前没有匹配的设备；选择「全部编队」可以看到完整车队"
          : "后端还没有上报任何设备；确认 MQTT 接入后此处会自动出现"
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

          `fit-device-ids` is the one place the GPS filter *does* bite: 适应车队 frames the
          selected formation (empty = the whole fleet) without hiding the other markers —
          so filtering a formation and pressing 适应车队 zooms to that formation, which is
          what an operator means by it, while the rest of the fleet stays on the map.
        -->
        <GpsMap
          v-if="surface === 'gps'"
          :devices="fleet.sortedDevices"
          :fit-device-ids="gpsFitDeviceIds"
          :selected-device-id="state.selectedDeviceId"
          @select="fleet.selectDevice"
        />
        <SceneMap
          v-else
          :selected-device="fleet.selectedDevice"
          :scene-definition="sceneDefinition"
          :scene-devices="fleet.sceneDevices"
          :trails="fleet.trailsByDeviceId"
          initial-view="fit"
        />
      </div>

      <aside
        class="hidden w-64 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-surface-raised xl:flex"
        aria-label="设备列表"
      >
        <!-- Only the roster scrolls; the actions below stay pinned to the bottom. -->
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            v-for="row in rows"
            :key="row.device.deviceId"
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors duration-150 ease-standard"
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
        </div>

        <!--
          The actions, pinned to the bottom of the panel (a fixed footer, not the tail of
          the scrolling list). Present only when there is something to act on.

          Clicking a row above *selects* — that is this panel's job, because the map has
          to be told which vehicle to centre on. But the detail page has to be reachable
          from the map too (`frontend-ia.md`: from the list, the map or an alert), so the
          selected vehicle gets one link rather than every row getting a second control.
          清除轨迹 only appears when there is a trail to clear — a permanently disabled
          button teaches people to stop reading the toolbar.
        -->
        <div
          v-if="fleet.selectedDevice || selectedTrailLength"
          class="flex shrink-0 flex-col gap-1 border-t border-border p-2"
        >
          <UiButton
            v-if="fleet.selectedDevice"
            :as="RouterLink"
            :to="`/devices/${fleet.selectedDevice.deviceId}`"
            variant="secondary"
            size="sm"
            class="w-full"
          >
            打开详情 →
          </UiButton>
          <UiButton
            v-if="selectedTrailLength"
            variant="secondary"
            size="sm"
            class="w-full"
            @click="clearSelectedTrail"
          >
            清除轨迹（{{ selectedTrailLength }} 点）
          </UiButton>
        </div>
      </aside>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
      <!--
        List filters: a search over name/id, plus 状态 and 场景 as multi-selects (empty =
        all). On top of the formation filter in the header; local (not in the URL) because
        they are a quick scan-time narrowing, not part of the shareable view. Each dropdown
        offers only values that still have rows under the other filters (faceted), and 场景
        stays visible even under a formation (编队 and 场景 cross, not nest).
      -->
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">搜索</span>
          <UiInput
            v-model="deviceSearch"
            class="w-48"
            placeholder="名称或编号"
            aria-label="搜索设备"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">状态</span>
          <UiMultiSelect
            :model-value="statusFilter"
            :options="STATUS_OPTIONS"
            placeholder="全部状态"
            aria-label="状态筛选"
            @update:model-value="(value) => (statusFilter = value)"
          />
        </label>
        <label v-if="sceneOptions.length" class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">场景</span>
          <UiMultiSelect
            :model-value="sceneFilter"
            :options="sceneOptions"
            placeholder="全部场景"
            aria-label="场景筛选"
            @update:model-value="(value) => (sceneFilter = value)"
          />
        </label>
      </div>

      <div :class="[tableClasses.wrapper, 'overflow-x-auto']">
        <!--
        `table-fixed` + `<colgroup>`: column widths are pinned by the colgroup, not by
        content, so nothing reflows when you sort. This is the fix for two reports:
        re-sorting changed which rows are on the page, which changed each column's widest
        cell and shifted every column; and 最近上报 in particular varies in length
        (`2026/9/9 8:05:03` vs `2026/12/21 20:49:50` — the date is not zero-padded), so the
        page that sorted a long stamp into view widened that column and pushed 电量 sideways.
        With fixed widths the geometry is constant. `tabular-nums` stays as well, so a value
        that ticks every second (a fresh timestamp, a changing SOC) never jitters within its
        own now-fixed cell; overflowing text in the 设备/编号/场景 columns truncates rather than
        wrapping.
      -->
        <table :class="[tableClasses.tableNumeric, 'table-fixed']">
          <caption class="sr-only">
            设备列表，共
            {{
              filteredRows.length
            }}
            台，当前第
            {{
              Math.min(page, pageCount)
            }}
            页
          </caption>
          <!--
          Widths in render order: expand · 状态 · 设备 · 编号 · 场景 · 最近上报 · 电量.
          Every column is pinned (none is left width-less): a `w-full` fixed-layout table
          distributes leftover width *proportionally* across the columns, so on a wide screen
          they grow evenly — whereas an unsized column soaks up all the slack and blew 设备 far
          from 编号. 设备/编号 stay tight to their content; 场景 (long scene names) carries the
          most base so the slack lands there; 最近上报 fits the longest localised stamp.
        -->
          <colgroup>
            <col class="w-8" />
            <col class="w-24" />
            <col class="w-36" />
            <col class="w-28" />
            <col class="w-44" />
            <col class="w-48" />
            <col class="w-20" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr class="text-left">
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
                :class="
                  column.numeric ? NUMERIC_HEAD_CLASS : 'px-3 py-2 text-left'
                "
                :aria-sort="ariaSortFor(column.key)"
              >
                <!--
                The arrow is always on the label's right, including on 电量. It used to be
                flipped there (`flex-row-reverse`) so it would sit against the numbers it
                describes — which put one of six arrows on the other side of its word and
                made the row of headers read as two different controls.
              -->
                <button
                  type="button"
                  class="inline-flex items-center gap-1 transition-colors duration-150 ease-standard hover:text-ink"
                  :class="sortKey === column.key ? 'text-ink' : ''"
                  @click="toggleSort(column.key)"
                >
                  <!-- Wrapped so the label's own edge is measurable: `console-devices.spec.ts`
                     asserts it lines up with the numbers below it, which is the thing that
                     was wrong and the thing no class assertion can see. -->
                  <span class="sort-label">{{ column.label }}</span>
                  <!--
                  The glyph is only on the active column — a permanent up/down on all six
                  says "sortable" and then says nothing about which one is in effect. The
                  *slot* is always there, which is a different thing: without it, the
                  column that gained the arrow moved its own label by the arrow's width,
                  visibly so on the right-aligned 电量. See `NUMERIC_VALUE_CLASS`.
                -->
                  <span class="w-2.5 text-center" aria-hidden="true">{{
                    sortKey === column.key
                      ? sortDirection === "asc"
                        ? "↑"
                        : "↓"
                      : ""
                  }}</span>
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
            <template v-for="row in pageRows" :key="row.device.deviceId">
              <!--
              Clicking anywhere on the row toggles its card. The chevron is the real
              control — a `<tr>` handler is mouse-only — and the device link stops
              propagation, because a click target inside a click target is how you get
              "I clicked the row and it navigated instead".
            -->
              <tr
                class="device-row border-b border-border last:border-0"
                :data-tone="row.tone"
                :data-expanded="expandedId === row.device.deviceId || undefined"
                @click="toggleExpanded(row.device.deviceId)"
              >
                <td class="px-1 py-2">
                  <button
                    type="button"
                    class="grid size-6 place-content-center rounded-sm text-ink-subtle transition-colors duration-150 ease-standard hover:text-ink"
                    :aria-expanded="expandedId === row.device.deviceId"
                    :aria-controls="`device-card-${row.device.deviceId}`"
                    :aria-label="`${row.device.deviceName || row.device.deviceId} 详情`"
                    @click.stop="toggleExpanded(row.device.deviceId)"
                  >
                    <span aria-hidden="true" class="text-2xs">
                      {{ expandedId === row.device.deviceId ? "▾" : "▸" }}
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
                <td class="truncate px-3 py-2">
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
                <td class="truncate px-3 py-2 font-mono text-xs text-ink-muted">
                  {{ row.device.deviceId }}
                </td>
                <td class="truncate px-3 py-2 text-ink-muted">
                  {{ row.sceneLabel }}
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ row.stamp }}
                </td>
                <td
                  class="font-mono text-xs text-ink"
                  :class="NUMERIC_VALUE_CLASS"
                >
                  <span class="soc-value">{{ row.soc }}</span>
                </td>
              </tr>
              <Transition name="dev-expand">
                <tr
                  v-if="expandedId === row.device.deviceId"
                  :id="`device-card-${row.device.deviceId}`"
                  class="dev-expand-row border-b border-border last:border-0"
                >
                  <td :colspan="COLUMNS.length + 1" class="p-0">
                    <div class="dev-card-clip">
                      <DeviceRowCard
                        :device="row.device"
                        :formation-names="row.formationNames"
                        @focus-on-map="focusOnMap"
                      />
                    </div>
                  </td>
                </tr>
              </Transition>
            </template>
          </tbody>
        </table>
      </div>

      <!-- The filters narrowed the list to nothing: say so, rather than leave a header
           over an empty body that reads as "no devices". -->
      <p
        v-if="!filteredRows.length"
        class="rounded-md border border-border bg-surface-raised px-4 py-6 text-center text-sm text-ink-muted"
      >
        没有匹配当前筛选的设备 —— 调整搜索 / 状态 / 场景，或清空筛选条件
      </p>
    </div>

    <!-- Shared footer: 每页条数 + pager (with jump), the same control 消息/审计/外发 use.
         Shown even on a single page so it does not come and go. -->
    <UiListPagination
      v-if="layout === 'list' && filteredRows.length"
      :page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :total="filteredRows.length"
      unit="台"
      @update:page="setPage"
      @update:page-size="setPageSize"
    />
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
  background: color-mix(in oklab, var(--color-ink) 6%, transparent);
}

/* The open row and its card read as one block, tinted with the brand wash so an opened
   row also reads as the selected one. Without this the card looks like a separate panel
   that happens to be underneath, rather than this row's own detail. */
.device-row[data-expanded] {
  background: var(--color-brand-wash);
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

/*
 * Expand/collapse as a fade, not a height slide.
 *
 * The detail row is a real `<tr v-if>`. An earlier version animated an inner grid's
 * `0fr → 1fr`, which — inside a `<table>` — re-laid-out the whole table every frame and
 * stuttered on open/close. A fade is composited (opacity only), so the row's height
 * changes exactly once (when the `<tr>` is added/removed) and nothing reflows per frame.
 * The global `prefers-reduced-motion` rule in base.css zeroes the transition.
 */
.dev-expand-enter-active,
.dev-expand-leave-active {
  transition: opacity 160ms var(--ease-standard);
}
.dev-expand-enter-from,
.dev-expand-leave-to {
  opacity: 0;
}

/* Isolate the card's own layout/paint from the table around it. */
.dev-card-clip {
  contain: content;
}
</style>
