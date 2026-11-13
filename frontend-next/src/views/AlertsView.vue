<script setup lang="ts">
/**
 * 告警 — the live message list.
 *
 * What this page owes v1.0.0: severity buckets, a device filter, a search box,
 * acknowledgement, and pagination. What it adds is mostly the v1.0.0 audit's list of
 * things that were missing rather than wrong:
 *
 * - **Filter state lives in the URL.** A supervisor who has narrowed the list to one
 *   vehicle's critical alerts can send that link to whoever is on shift. In v1.0.0
 *   the same view could only be described in words.
 * - **The acknowledge control is a toggle that says so** (`aria-pressed`), not a
 *   button whose meaning is carried by its colour.
 * - **The empty state is a live region**, so filtering down to nothing is announced
 *   rather than silently leaving a blank panel.
 * - **A row reaches the vehicle.** Diagnosing an alert used to mean reading the
 *   device id and going to find it.
 *
 * Acknowledgement is server-backed: it reaches the database, records who
 * confirmed each occurrence and when, syncs across every open console over WS, and is an
 * operator+ capability — so the confirm control is hidden from viewers. A re-fired alert
 * comes back unacknowledged, because the confirmation was of one occurrence, not the code.
 */
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSearchInput from "@/components/ui/UiSearchInput.vue";
import UiSegmented from "@/components/ui/UiSegmented.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import UiFilterBar from "@/components/ui/UiFilterBar.vue";
import UiFilterField from "@/components/ui/UiFilterField.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import { SEVERITY_BADGE, SEVERITY_LABELS } from "@/lib/severity";
import { compileSearch } from "@/lib/searchQuery";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import AlertHistoryPanel from "@/components/alerts/AlertHistoryPanel.vue";
import { useFleetStore } from "@/stores/fleet";
import { useAlertAck } from "@/composables/useAlertAck";
import { useAlertDisposition } from "@/composables/useAlertDisposition";
import { useListPagination } from "@/composables/useListPagination";
import { useAuth } from "@/composables/useAuth";
import { useDebouncedText } from "@/composables/useDebouncedText";
import { useNotifications } from "@/composables/useNotifications";
import { formatDateTime } from "@navfleet/fleet-core";
import {
  ALERT_DISPOSITION_LABELS,
  type AlertDisposition,
  type Severity,
} from "@navfleet/shared";

/**
 * The four `source` values the normalizer produces, in words.
 *
 * `source` has been computed and carried on every alert and read by nothing in
 * this front end — v1.0.0 rendered it in the row footer
 * (`frontend/src/views/AlertsView.vue:16-21,226`). It answers a question the title cannot:
 * whether a row came off a vehicle's own report code or was derived by the rule engine,
 * which decides whether the vehicle or the platform is the thing to look at.
 *
 * A snapshot-sourced alert can carry any string (`fleetNormalize.ts:500` defaults it to
 * `"snapshot"`), so unknown values fall through to the raw value rather than being hidden.
 */
// The three report-code sources read 车端报码: the title already says which channel (告警报码 / 预警报码 /
// 提示报码), so naming the channel again here printed the same word twice on every row. What this
// column adds is the other half: the vehicle reported it, or the platform's rule engine derived it.
const SOURCE_LABELS: Record<string, string> = {
  error_code: "车端报码",
  warning_code: "车端报码",
  info_code: "车端报码",
  "rule-engine": "规则引擎",
  snapshot: "快照",
};

/** Worst first — the order they should be worked, not the order they arrived. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};

const route = useRoute();
const router = useRouter();
const fleet = useFleetStore();
const ack = useAlertAck();
const disp = useAlertDisposition();
const auth = useAuth();
const { notify } = useNotifications();

/**
 * Acknowledging is the `alerts:ack` capability (1.6.1 RBAC) — held by operator/admin presets, and
 * grantable to any user through a custom role + group. Viewers without it still read the list and
 * see who confirmed what; they just cannot confirm, so every mutating control is hidden from them
 * (the backend enforces it regardless).
 */
const canAck = computed(() => auth.can("alerts:ack"));

/**
 * Filters read from the URL and written back to it.
 *
 * The query string is the single source of truth rather than a mirror of local refs:
 * a link someone pastes has to produce the same view, and keeping a second copy in
 * `ref`s is how the two drift.
 */
const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};

/** 严重度 is multi-select too: comma-joined in `severity`, empty = 全部. */
const SEVERITY_VALUES = ["critical", "warning", "notice"] as const;
const severity = computed<Severity[]>(() => {
  const raw = readParam("severity");
  return raw
    ? (raw
        .split(",")
        .filter((value): value is Severity =>
          (SEVERITY_VALUES as readonly string[]).includes(value),
        ) as Severity[])
    : [];
});
/**
 * 设备 is a **multi-select** now (消息 页 was single until the filter-polish sweep). The URL
 * keeps one `device` key, comma-joined, so a shareable link still carries the whole set:
 * `?device=agv-02,agv-07`. An empty list means 全部设备. `AlertHistoryPanel` parses the same
 * key the same way, so the history tab honours a multi-device link too.
 */
const deviceFilter = computed(() => {
  const raw = readParam("device");
  return raw ? raw.split(",").filter(Boolean) : [];
});
const search = computed(() => readParam("q"));
/**
 * Onset window for 消息史 (history tab only). Server-side (see `AlertHistoryPanel`), so it reaches
 * cleared alerts older than the endpoint's most-recent page — the live tab reads the store and has
 * no history to window, hence these inputs show only when `!isLive`. Independent bounds; native
 * min/max keeps 起 ≤ 止.
 */
const fromDate = computed(() => readParam("from"));
const toDate = computed(() => readParam("to"));

/**
 * What the 起止 inputs display on the 消息史 tab: the typed bounds, or — when a bound is left
 * empty — the default window `AlertHistoryPanel` actually queries (the last 10 days ending now),
 * so the default is visible rather than an empty box. Display only; an empty URL param still
 * means "use the default", the panel's own `HISTORY_DAYS`.
 */
const HISTORY_DEFAULT_DAYS = 10;
const asDateInput = (at: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
const effectiveDates = computed<{ from: string; to: string }>(() => ({
  from:
    fromDate.value ||
    asDateInput(new Date(Date.now() - HISTORY_DEFAULT_DAYS * 86_400_000)),
  to: toDate.value || asDateInput(new Date()),
}));
/**
 * Handling-state filter (处置态): one of the four segments 全部 / 待处理 / 处理中 / 已忽略. Empty =
 * 全部. Lives in the URL like the other filters so a pasted link reproduces the view. Replaces the
 * old 显示已确认 checkbox, which could only hide/show one state.
 */
const HANDLING_VALUES = ["unhandled", "investigating", "ignored"] as const;
const handling = computed<AlertDisposition | "">(() => {
  const raw = readParam("handling");
  return (HANDLING_VALUES as readonly string[]).includes(raw)
    ? (raw as AlertDisposition)
    : "";
});
const HANDLING_SEGMENTS: { value: AlertDisposition | ""; label: string }[] = [
  { value: "", label: "全部" },
  { value: "unhandled", label: ALERT_DISPOSITION_LABELS.unhandled },
  { value: "investigating", label: ALERT_DISPOSITION_LABELS.investigating },
  { value: "ignored", label: ALERT_DISPOSITION_LABELS.ignored },
];
/** Chip border + text colour per handling state (待处理 neutral / 处理中 brand / 已忽略 recessive). */
const DISPOSITION_CHIP: Record<AlertDisposition, string> = {
  unhandled: "border-border text-ink-muted",
  investigating: "border-brand text-brand-ink",
  ignored: "border-border text-ink-subtle",
};

/**
 * 消息 is a section with three tabs (1.6.2 IA): live alerts off the store (消息, this view at
 * `/alerts`), 消息史 — cleared alerts — (this same view at `/alerts/history`), and 消息规则 (a
 * separate view). Live and history share one filter bar; only 显示已确认 and the bulk-ack actions
 * are live-only, and the 起止时间 inputs are history-only. The tab is the route now — the former
 * `?view=history` toggle button is gone — so `/alert-history` redirects to `/alerts/history`.
 */
const view = computed<"live" | "history">(() =>
  route.path.endsWith("/history") ? "history" : "live",
);
const isLive = computed(() => view.value === "live");

/** Writes only what differs from the default, so a clean view has a clean URL. */
const setQuery = (patch: Record<string, string | null>): void => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
    if (typeof value === "string" && value !== "") next[key] = value;
  }
  void router.replace({ query: next });
};

const setFilter = (patch: Record<string, string | null>): void => {
  // Any filter change goes back to the first page: staying on page 4 of a list that
  // now has one page shows nothing and looks broken.
  // Both lists: the live tab's `page` and the history tab's `hpage`.
  setQuery({ ...patch, page: null, hpage: null });
};

/**
 * Every alert in the fleet, worst severity first and newest **onset** first within it.
 *
 * Not by `ts`. For a code alert `ts` is the last report that carried the code, and a
 * vehicle re-sends its active codes every telemetry cycle — so sorting on it made all
 * the rows in a bucket jump to "now" together once a second, and their order fell to
 * millisecond noise. Manual review saw that as flicker; it was a list sorted on a key
 * that changes every tick. `firstSeenAt` is maintained by the store and does not move
 * while an alert stays up. The `id` tiebreak makes the order fully determined.
 */
const allAlerts = computed(() =>
  (["critical", "warning", "notice"] as const)
    .flatMap((bucket) => fleet.groupedAlerts[bucket])
    .sort(
      (left, right) =>
        SEVERITY_WEIGHT[left.severity] - SEVERITY_WEIGHT[right.severity] ||
        right.firstSeenAt - left.firstSeenAt ||
        left.id.localeCompare(right.id),
    ),
);

/**
 * The filter predicates, each over one axis, so 设备 can be faceted against the *others*.
 * `matchHandling` folds the 处置态 segment in as a filter: 全部 matches everything, otherwise only
 * rows whose derived disposition equals the chosen state.
 */
const matchSeverity = (alert: { severity: Severity }): boolean =>
  severity.value.length === 0 || severity.value.includes(alert.severity);
const matchDevice = (alert: { deviceId: string }): boolean =>
  deviceFilter.value.length === 0 ||
  deviceFilter.value.includes(alert.deviceId);
const matchHandling = (alert: { deviceId: string; id: string }): boolean =>
  handling.value === "" ||
  disp.dispositionOf(alert.deviceId, alert.id) === handling.value;
/**
 * Search is a boolean query (与/或/非 + 括号, see `compileSearch`), compiled once per committed
 * keystroke and run over the row's title / detail / device / 来源 joined. Both forms of 来源 are
 * included (the operator sees 规则引擎 on the row, a deployment reading logs knows it as
 * `rule-engine`), so the placeholder's promise of 来源 is honest.
 */
const searchMatches = computed(() => compileSearch(search.value));
const matchSearch = (alert: {
  title: string;
  detail?: string;
  deviceName?: string;
  deviceId: string;
  info?: string;
  source: string;
}): boolean =>
  searchMatches.value(
    [
      alert.title,
      alert.detail,
      alert.deviceName,
      alert.deviceId,
      alert.info,
      SOURCE_LABELS[alert.source],
      alert.source,
    ]
      .filter(Boolean)
      .join(" "),
  );

/**
 * 严重度 options, faceted against the *other* filters (设备 / 搜索 / 处置) exactly as 设备 is:
 * the multi-select only offers a severity that still has a matching alert, so narrowing by device
 * or searching a code trims the severity list to what is actually present. Worst-first order is
 * kept (not by appearance), and a currently-selected severity is always listed so it can be
 * unticked even after its last matching alert clears (the filter lives in the URL).
 */
const severityOptions = computed(() => {
  const present = new Set<Severity>();
  for (const alert of allAlerts.value) {
    if (matchDevice(alert) && matchSearch(alert) && matchHandling(alert)) {
      present.add(alert.severity);
    }
  }
  for (const value of severity.value) present.add(value);
  return SEVERITY_VALUES.filter((value) => present.has(value)).map((value) => ({
    value,
    label: SEVERITY_LABELS[value],
  }));
});

/**
 * 设备 options, faceted against the *other* filters (严重度 / 搜索 / 显示已确认): the dropdown
 * only offers vehicles that still have a matching alert, so narrowing 严重度=预警 (or searching
 * a code) trims the device list to the vehicles that actually have such an alert — the same
 * cascading 设备 页 does. A currently-selected device is always kept listed so it can be
 * unticked even after its own alert clears (the filter lives in the URL and outlives the alert).
 */
const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const alert of allAlerts.value) {
    if (matchSeverity(alert) && matchSearch(alert) && matchHandling(alert)) {
      if (!seen.has(alert.deviceId)) {
        seen.set(alert.deviceId, alert.deviceName || alert.deviceId);
      }
    }
  }
  // The name is resolved from the fleet when the device is still known, so a kept option
  // reads 「B07 巡检车」 rather than `agv-b07`; one that has left the fleet falls back to its
  // id, which is still the truth about what the URL is asking for.
  for (const id of deviceFilter.value) {
    if (!seen.has(id)) {
      const known = fleet.devices.find((device) => device.deviceId === id);
      seen.set(id, known?.deviceName || id);
    }
  }
  // By name, not by first appearance — the set is built by walking the alert list, so without
  // this the menu's order is "whichever vehicle happened to fault first", an order that moves
  // under the reader and cannot be scanned for a known name.
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
});

const filtered = computed(() =>
  allAlerts.value.filter(
    (alert) =>
      matchSeverity(alert) &&
      matchDevice(alert) &&
      matchHandling(alert) &&
      matchSearch(alert),
  ),
);

// Shared pagination (default 10/页, URL-backed), the same control 设备/审计/外发 use. A
// filter change still resets the page via `setFilter({ …, page: null })` below; the
// clamp when a filter shrinks the list lives inside the composable.
const { page, pageSize, pageCount, pageItems, setPage, setPageSize } =
  useListPagination(filtered);
const pageRows = pageItems;

/**
 * Every unacknowledged id in the **whole filtered set**, not just the visible page.
 *
 * The port had narrowed this to `pageRows`, against the decision recorded for this
 * control when the console was planned: keep the capability, add feedback and undo
 * (保持能力，补反馈与撤销). The feedback and the undo did get added; the capability quietly
 * shrank, with no reason in the code or the commit. On a
 * fleet with sixty active alerts "确认本页" means four rounds of clicking through
 * pagination to do what v1.0.0 did once.
 */
const ignorableFiltered = computed(() =>
  filtered.value
    .filter(
      (alert) => disp.dispositionOf(alert.deviceId, alert.id) !== "ignored",
    )
    .map((alert) => ({ deviceId: alert.deviceId, id: alert.id })),
);

/**
 * Ignoring in bulk offers an undo, because it is the one action here that is both easy to trigger
 * by accident and tedious to reverse by hand. The button reaches past the page — the undo is what
 * makes the wider scope safe. Each call is a backend write; `acknowledgeMany` (the ignore fan-out)
 * returns only the refs that actually landed, so the undo restores exactly those.
 */
const ignoreFiltered = async (): Promise<void> => {
  const changed = await ack.acknowledgeMany(ignorableFiltered.value);
  if (!changed.length) return;
  notify(`已忽略 ${changed.length} 条消息`, {
    type: "success",
    action: {
      label: "撤销",
      handler: () => void ack.unacknowledgeMany(changed),
    },
  });
};

/**
 * Per-row selection for 确认选中: tick several rows, confirm them in one write. This is the
 * explicit counterpart to 确认当前筛选 (which acts on the whole filtered set sight-unseen) — the
 * operator picks exactly which occurrences to confirm, across pages. The map is keyed by the
 * alert's `deviceId:id` and holds the ref so a confirm needs no lookup; it is reassigned on every
 * change because a `ref<Map>` does not track in-place mutation. A watch prunes ids whose alert has
 * cleared, so the count never counts rows that are gone.
 */
const selected = ref(new Map<string, { deviceId: string; id: string }>());
const selectionKey = (alert: { deviceId: string; id: string }): string =>
  `${alert.deviceId}:${alert.id}`;
const isSelected = (alert: { deviceId: string; id: string }): boolean =>
  selected.value.has(selectionKey(alert));
const toggleSelected = (alert: { deviceId: string; id: string }): void => {
  const next = new Map(selected.value);
  const key = selectionKey(alert);
  if (next.has(key)) next.delete(key);
  else next.set(key, { deviceId: alert.deviceId, id: alert.id });
  selected.value = next;
};
const selectedCount = computed(() => selected.value.size);

watch(allAlerts, (alerts) => {
  if (!selected.value.size) return;
  const present = new Set(alerts.map(selectionKey));
  const next = new Map(selected.value);
  let dropped = false;
  for (const key of next.keys())
    if (!present.has(key)) {
      next.delete(key);
      dropped = true;
    }
  if (dropped) selected.value = next;
});

/**
 * Ignore the ticked rows (minus any already ignored), then clear the selection. Same undo-toast
 * contract as 忽略当前筛选 — `acknowledgeMany` returns only what actually landed.
 */
const ignoreSelected = async (): Promise<void> => {
  const refs = [...selected.value.values()].filter(
    (entry) => disp.dispositionOf(entry.deviceId, entry.id) !== "ignored",
  );
  selected.value = new Map();
  const changed = await ack.acknowledgeMany(refs);
  if (!changed.length) return;
  notify(`已忽略 ${changed.length} 条消息`, {
    type: "success",
    action: {
      label: "撤销",
      handler: () => void ack.unacknowledgeMany(changed),
    },
  });
};

/** Claim one message for investigation (认领 / 我来处理). */
const claimOne = (alert: { deviceId: string; id: string }): void => {
  void disp.claim(alert.deviceId, alert.id);
};
/** Release one's own claim back to unhandled. */
const releaseOne = (alert: { deviceId: string; id: string }): void => {
  void disp.release(alert.deviceId, alert.id);
};
/** Cancel an ignore back to unhandled. */
const unignoreOne = (alert: { deviceId: string; id: string }): void => {
  void disp.unignore(alert.deviceId, alert.id);
};
/**
 * Ignore one message, with the same undo-toast the bulk action gives — a single ignore is just as
 * easy to misfire. Claim / release / unignore stay quiet (the row's state chip is the feedback,
 * and a failed or conflicting write already toasts from `useAlertDisposition`).
 */
const ignoreOne = async (alert: {
  deviceId: string;
  id: string;
}): Promise<void> => {
  const ok = await disp.ignore(alert.deviceId, alert.id);
  if (!ok) return;
  notify("已忽略 1 条消息", {
    type: "success",
    action: {
      label: "撤销",
      handler: () => void disp.unignore(alert.deviceId, alert.id),
    },
  });
};

/**
 * How many of the alerts currently in the fleet are ignored.
 *
 * Deliberately **not** a stored count that would include ids for alerts that have since
 * cleared: this counts the ignored alerts currently in the fleet, so it cannot drift
 * upward past what the page can show.
 */
const ignoredPresent = computed(
  () =>
    allAlerts.value.filter(
      (alert) => disp.dispositionOf(alert.deviceId, alert.id) === "ignored",
    ).length,
);

/**
 * Cancels the ignore of every alert currently in the fleet. Symmetric with the bulk ignore: it
 * only touches alerts the page can see, so the undo can put back exactly those.
 */
const clearIgnored = async (): Promise<void> => {
  const cleared = await ack.unacknowledgeMany(
    allAlerts.value
      .filter(
        (alert) => disp.dispositionOf(alert.deviceId, alert.id) === "ignored",
      )
      .map((alert) => ({ deviceId: alert.deviceId, id: alert.id })),
  );
  if (!cleared.length) return;
  notify(`已取消忽略 ${cleared.length} 条消息`, {
    type: "info",
    action: { label: "撤销", handler: () => void ack.acknowledgeMany(cleared) },
  });
};

/**
 * The search box commits on a timer rather than on every keystroke.
 *
 * `q` lives in the URL like the other filters so a pasted link reproduces the view — but
 * that made eight characters into eight `router.replace` calls. See `useDebouncedText`
 * for why a local draft is needed as well as a delay.
 */
const {
  draft: searchDraft,
  onInput: onSearchInput,
  flush: flushSearch,
} = useDebouncedText(
  () => search.value,
  (value) => setFilter({ q: value || null }),
);

/**
 * One-time migration of this browser's old localStorage acknowledgements: once
 * the backend is reachable and the caller can actually confirm, push the still-active ones up
 * and drop the local key. Guarded to operator+ because the ack endpoint is — a viewer running
 * it would 403 every row and the key would be left for a later privileged session. The
 * composable itself only runs the body once per page load.
 */
const runLegacyMigration = (): void => {
  if (!canAck.value || !fleet.state.realtime.apiReady) return;
  void ack.migrateLegacyAcks(
    allAlerts.value.map((alert) => ({
      deviceId: alert.deviceId,
      id: alert.id,
    })),
  );
};

// Seed the acknowledgement overlay from the backend once, when the page that displays it opens
//. Any role may read it — who-confirmed-what is shown to viewers too; only the
// confirm action is operator+. Between reads the WS stream keeps it live, so this is the only
// place a read is needed. Kept out of the global bootstrap so pages that never show alerts do
// not issue the request.
onMounted(() => {
  void fleet.seedAckState();
  runLegacyMigration();
});
watch(() => canAck.value && fleet.state.realtime.apiReady, runLegacyMigration);
</script>

<template>
  <PageHeader title="消息">
    <template #actions>
      <!-- 忽略选中 — the ticked rows (see the per-row checkboxes). Explicit counterpart to
           忽略当前筛选: the operator chose exactly these, possibly across pages. -->
      <UiButton
        v-if="isLive && canAck && selectedCount"
        variant="primary"
        size="sm"
        @click="ignoreSelected"
      >
        忽略选中 {{ selectedCount }} 条
      </UiButton>

      <!-- 忽略当前筛选 acts on the whole filtered set, not just the page, with feedback and an
           undo so the wider scope is safe. -->
      <UiButton
        v-if="isLive && canAck && ignorableFiltered.length"
        variant="secondary"
        size="sm"
        @click="ignoreFiltered"
      >
        忽略当前筛选 {{ ignorableFiltered.length }} 条
      </UiButton>

      <!-- Put every ignored message back to 待处理, for when a filter was too broad. -->
      <UiButton
        v-if="isLive && canAck && ignoredPresent"
        variant="secondary"
        size="sm"
        @click="clearIgnored"
      >
        取消忽略 {{ ignoredPresent }} 条
      </UiButton>
    </template>

    <AppSectionTabs />

    <UiFilterBar>
      <UiFilterField label="严重度">
        <UiMultiSelect
          :model-value="severity"
          :options="severityOptions"
          placeholder="全部严重度"
          aria-label="严重度筛选"
          @update:model-value="
            (value) =>
              setFilter({ severity: value.length ? value.join(',') : null })
          "
        />
      </UiFilterField>

      <UiFilterField label="设备">
        <UiMultiSelect
          :model-value="deviceFilter"
          :options="deviceOptions"
          placeholder="全部设备"
          aria-label="设备筛选"
          @update:model-value="
            (value) =>
              setFilter({ device: value.length ? value.join(',') : null })
          "
        />
      </UiFilterField>

      <UiFilterField label="搜索">
        <!--
          Bound to the local draft, committed on a timer. Bound to `search` it would read
          from the URL it is about to rewrite, and every keystroke was a navigation.
          `keydown.enter` skips the wait, because pressing Enter in a search box means
          "now" — and `search` inputs get a native clear button, whose `input` event goes
          through the same debounce.
        -->
        <UiSearchInput
          placeholder="标题/详情/设备/来源"
          :model-value="searchDraft"
          @update:model-value="onSearchInput"
          @enter="flushSearch"
        />
      </UiFilterField>

      <!--
        起止时间：仅 消息史 有（实时页读 store、没有历史可窗）。服务端过滤，能取到最近一页之外的
        旧记录。起 ≤ 止 由原生 min/max 约束；两端独立可选。
      -->
      <UiFilterField v-if="!isLive" label="起始时间">
        <UiInput
          type="date"
          :model-value="effectiveDates.from"
          :max="effectiveDates.to || undefined"
          aria-label="起始日期"
          @update:model-value="(value) => setFilter({ from: value || null })"
        />
      </UiFilterField>
      <UiFilterField v-if="!isLive" label="结束时间">
        <UiInput
          type="date"
          :model-value="effectiveDates.to"
          :min="effectiveDates.from || undefined"
          aria-label="结束日期"
          @update:model-value="(value) => setFilter({ to: value || null })"
        />
      </UiFilterField>

      <!-- Handling-state segmented filter (replaces the old 显示已确认 checkbox). One segment
           active at a time, 全部 clears the URL param. Shares `UiSegmented` with 报表 的「范围」so
           the two controls line up. -->
      <UiFilterField v-if="isLive" label="处置">
        <UiSegmented
          :model-value="handling"
          :options="HANDLING_SEGMENTS"
          aria-label="处置态筛选"
          @update:model-value="
            (value) => setFilter({ handling: value || null })
          "
        />
      </UiFilterField>
    </UiFilterBar>

    <AlertHistoryPanel v-if="!isLive" />

    <template v-else>
      <!-- A live region: filtering down to nothing has to be announced, not leave a
           blank panel behind. -->
      <UiEmptyState v-if="!pageRows.length">
        {{
          allAlerts.length
            ? "没有符合当前筛选条件的消息"
            : "当前车队没有活跃消息"
        }}
      </UiEmptyState>

      <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
        <!--
        Two visual encodings the port dropped, both restored on this element rather than
        on the badge:

        - **Severity on the whole row** (`alert-drawer.css:126-136` tinted its border).
          A badge answers "how bad is this" once you are reading the row; the row
          treatment is what tells you before you read anything.
        - **Acknowledged rows fade** (`.acknowledged { opacity: .55 }`,
          `alert-center.css:65-67`). Without it, ticking 显示已确认 produced two kinds of
          row that differ only in one button's colour — so after a bulk confirm you could
          not see which ones you had just done.

        A third one — `.alert-item.focused` (`:138-141`), a brand ring on the rows of the
        selected vehicle — was restored by the parity pass and **removed again after
        acceptance testing**. It reported a fact this page cannot explain. In v1.0.0 that
        rule lived in an alert drawer *beside the map*, where the selection was visible and
        the operator had just made it. Here the page is reached from the sidebar and offers
        no selection control at all, so the ring marked whichever vehicle
        `ensureSelectedDevice()` had picked — the alphabetically first one on a cold load,
        or whatever was last clicked on 设备, possibly minutes ago on another page. Manual
        review read it as rows lighting up at random, which is the correct reading: nothing
        on screen accounted for it. A cue whose cause is off-screen is noise, however
        faithful it is to the original.
      -->
        <li
          v-for="alert in pageRows"
          :key="alert.id"
          class="alert-row flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3 sm:flex-row sm:items-start"
          :data-severity="alert.severity"
          :data-disposition="disp.dispositionOf(alert.deviceId, alert.id)"
        >
          <!-- Select to ignore in bulk: ticking rows feeds 忽略选中 above. Operator+ only;
               viewers never see it. -->
          <input
            v-if="canAck"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0"
            :checked="isSelected(alert)"
            :aria-label="`选择消息：${alert.title}`"
            @change="toggleSelected(alert)"
          />

          <span
            class="shrink-0 rounded-xs px-2 py-0.5 font-mono text-2xs"
            :class="SEVERITY_BADGE[alert.severity]"
            >{{ SEVERITY_LABELS[alert.severity] }}</span
          >

          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong class="text-sm text-ink">{{ alert.title }}</strong>
            <span v-if="alert.detail" class="text-xs text-ink-muted">{{
              alert.detail
            }}</span>
            <span
              class="flex flex-wrap items-center gap-2 text-2xs text-ink-subtle"
            >
              <!-- The row reaches the vehicle: diagnosing an alert used to mean reading
                 the device id and going to find it. -->
              <RouterLink
                :to="`/devices/${alert.deviceId}`"
                class="text-brand-ink underline-offset-2 hover:underline"
                >{{ alert.deviceName || alert.deviceId }}</RouterLink
              >
              <!-- The onset, not the last report. `ts` is refreshed on every telemetry
                 cycle, so rendering it made this line rewrite itself once a second. -->
              <span class="font-mono">{{
                formatDateTime(alert.firstSeenAt)
              }}</span>
              <span v-if="alert.code" class="font-mono">#{{ alert.code }}</span>
              <!-- Where the row came from. Computed on every alert and read by
                 nothing until now; it decides whether the vehicle or the platform is the
                 thing to go look at. -->
              <span>{{ SOURCE_LABELS[alert.source] || alert.source }}</span>
              <!-- Handling state: a chip showing 待处理 / 处理中 / 已忽略, with who holds it when
                   claimed or ignored. Server-backed, so it is the same on every console. -->
              <span
                class="rounded-xs border px-1.5 py-0.5"
                :class="
                  DISPOSITION_CHIP[disp.dispositionOf(alert.deviceId, alert.id)]
                "
              >
                {{
                  disp.dispositionLabel(
                    disp.dispositionOf(alert.deviceId, alert.id),
                  )
                }}<template v-if="disp.handledBy(alert.deviceId, alert.id)">
                  · {{ disp.handledBy(alert.deviceId, alert.id) }}</template
                >
              </span>
            </span>
          </div>

          <!-- Per-row handling controls (operator+). The set shown depends on the state: 待处理
               offers 我来处理 + 忽略; 处理中 offers 释放认领 to the claimant or an admin; 已忽略
               offers 取消忽略. The backend enforces the same rules. -->
          <div v-if="canAck" class="flex shrink-0 gap-1">
            <template
              v-if="
                disp.dispositionOf(alert.deviceId, alert.id) === 'unhandled'
              "
            >
              <UiButton
                size="sm"
                variant="primary"
                :aria-label="`我来处理：${alert.title}`"
                @click="claimOne(alert)"
              >
                我来处理
              </UiButton>
              <UiButton
                size="sm"
                variant="secondary"
                :aria-label="`忽略消息：${alert.title}`"
                @click="ignoreOne(alert)"
              >
                忽略
              </UiButton>
            </template>
            <UiButton
              v-else-if="
                disp.dispositionOf(alert.deviceId, alert.id) ===
                  'investigating' && disp.canRelease(alert.deviceId, alert.id)
              "
              size="sm"
              variant="secondary"
              :aria-label="`释放认领：${alert.title}`"
              @click="releaseOne(alert)"
            >
              释放认领
            </UiButton>
            <UiButton
              v-else-if="
                disp.dispositionOf(alert.deviceId, alert.id) === 'ignored'
              "
              size="sm"
              variant="secondary"
              :aria-label="`取消忽略：${alert.title}`"
              @click="unignoreOne(alert)"
            >
              取消忽略
            </UiButton>
          </div>
        </li>
      </ul>

      <UiListPagination
        :page="page"
        :page-count="pageCount"
        :page-size="pageSize"
        :total="filtered.length"
        @update:page="setPage"
        @update:page-size="setPageSize"
      />
    </template>
  </PageHeader>
</template>

<style scoped>
/*
 * Scoped CSS for the same reason `DevicesView` and `SceneMap` use it: these variants key
 * on a runtime severity, and Tailwind only sees literal strings. Every value is a token,
 * so this follows the theme — no `dark:` here and there should not be.
 *
 * v1.0.0 tinted only the border (`alert-drawer.css:126-136`). Kept as a border tint here
 * too rather than promoted to a background: the row already sits on `surface-raised`
 * inside a list of siblings, and a filled row at three severities turns the page into a
 * colour chart. The border is enough to group them at a glance.
 */
.alert-row[data-severity="critical"] {
  border-color: color-mix(in oklab, var(--color-critical) 45%, transparent);
}

.alert-row[data-severity="warning"] {
  border-color: color-mix(in oklab, var(--color-warning) 45%, transparent);
}

.alert-row[data-severity="notice"] {
  border-color: color-mix(in oklab, var(--color-notice) 40%, transparent);
}

/*
 * There is deliberately no `[data-focused]` rule here. See the template comment above
 * the row: the selection this page could key on is one the page never let the operator
 * make, so the ring reported something nothing on screen explained.
 */

/*
 * Ignored rows recede rather than disappear: they are expected/noise, so they stay visible (and
 * filterable) but step back from the firing ones that still need attention.
 */
.alert-row[data-disposition="ignored"] {
  opacity: 0.55;
}
</style>
