<script setup lang="ts">
/**
 * 告警 — equivalence first, depth in Phase 16.
 *
 * What this page owes v1.0.0: severity buckets, a device filter, a search box,
 * acknowledgement, and pagination. What it adds is mostly the 11B audit's list of
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
 * Acknowledgement is server-backed since Phase 16A: it reaches the database, records who
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
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import UiFilterBar from "@/components/ui/UiFilterBar.vue";
import UiFilterField from "@/components/ui/UiFilterField.vue";
import { SEVERITY_LABELS } from "@/lib/severity";
import { compileSearch } from "@/lib/searchQuery";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import AlertHistoryPanel from "@/components/alerts/AlertHistoryPanel.vue";
import { useFleetStore } from "@/stores/fleet";
import { useAlertAck } from "@/composables/useAlertAck";
import { useListPagination } from "@/composables/useListPagination";
import { useAuth } from "@/composables/useAuth";
import { useDebouncedText } from "@/composables/useDebouncedText";
import { useNotifications } from "@/composables/useNotifications";
import { formatDateTime } from "@navfleet/fleet-core";
import type { Severity } from "@navfleet/shared";

/**
 * The four `source` values the normalizer produces, in words.
 *
 * `source` has been computed and carried on every alert since 12A and read by nothing in
 * this front end — v1.0.0 rendered it in the row footer
 * (`frontend/src/views/AlertsView.vue:16-21,226`). It answers a question the title cannot:
 * whether a row came off a vehicle's own report code or was derived by the rule engine,
 * which decides whether the vehicle or the platform is the thing to look at.
 *
 * A snapshot-sourced alert can carry any string (`fleetNormalize.ts:500` defaults it to
 * `"snapshot"`), so unknown values fall through to the raw value rather than being hidden.
 */
const SOURCE_LABELS: Record<string, string> = {
  error_code: "告警报码",
  warning_code: "预警报码",
  info_code: "提示报码",
  "rule-engine": "规则引擎",
  snapshot: "快照",
};

/** The severity filter is multi-select (worst-first); an empty set means 全部. */
const SEVERITY_OPTIONS: readonly { value: Severity; label: string }[] = [
  { value: "critical", label: "告警" },
  { value: "warning", label: "预警" },
  { value: "notice", label: "提示" },
];

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "bg-critical-wash text-critical-ink",
  warning: "bg-warning-wash text-warning-ink",
  notice: "bg-notice-wash text-notice-ink",
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
 * Onset window for 告警史 (history tab only). Server-side (see `AlertHistoryPanel`), so it reaches
 * cleared alerts older than the endpoint's most-recent page — the live tab reads the store and has
 * no history to window, hence these inputs show only when `!isLive`. Independent bounds; native
 * min/max keeps 起 ≤ 止.
 */
const fromDate = computed(() => readParam("from"));
const toDate = computed(() => readParam("to"));
const showAcknowledged = computed(() => readParam("acked") === "1");

/**
 * 消息 is a section with three tabs (1.6.2 IA): live alerts off the store (消息, this view at
 * `/alerts`), 告警史 — cleared alerts — (this same view at `/alerts/history`), and 告警规则 (a
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
  setQuery({ ...patch, page: null });
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
 * `matchAcked` is the 显示已确认 rule folded in as a filter: hidden-by-default acknowledged
 * rows are simply "not matching" unless the toggle is on.
 */
const matchSeverity = (alert: { severity: Severity }): boolean =>
  severity.value.length === 0 || severity.value.includes(alert.severity);
const matchDevice = (alert: { deviceId: string }): boolean =>
  deviceFilter.value.length === 0 ||
  deviceFilter.value.includes(alert.deviceId);
const matchAcked = (alert: { deviceId: string; id: string }): boolean =>
  showAcknowledged.value || !ack.isAcknowledged(alert.deviceId, alert.id);
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
 * 设备 options, faceted against the *other* filters (严重度 / 搜索 / 显示已确认): the dropdown
 * only offers vehicles that still have a matching alert, so narrowing 严重度=预警 (or searching
 * a code) trims the device list to the vehicles that actually have such an alert — the same
 * cascading 设备 页 does. A currently-selected device is always kept listed so it can be
 * unticked even after its own alert clears (the filter lives in the URL and outlives the alert).
 */
const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const alert of allAlerts.value) {
    if (matchSeverity(alert) && matchSearch(alert) && matchAcked(alert)) {
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
      matchAcked(alert) &&
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
 * The port had narrowed this to `pageRows`, and `docs/frontend-research.md:36` says the
 * opposite for this control: "保持能力，补反馈与撤销". The feedback and the undo did get
 * added; the capability quietly shrank, with no reason in the code or the commit. On a
 * fleet with sixty active alerts "确认本页" means four rounds of clicking through
 * pagination to do what v1.0.0 did once.
 */
const unacknowledgedFiltered = computed(() =>
  filtered.value
    .filter((alert) => !ack.isAcknowledged(alert.deviceId, alert.id))
    .map((alert) => ({ deviceId: alert.deviceId, id: alert.id })),
);

/**
 * Acknowledging in bulk offers an undo, because it is the one action here that is both
 * easy to trigger by accident and tedious to reverse by hand. That matters more now that
 * the button reaches past the page — the undo is what makes the wider scope safe rather
 * than alarming. Each call is a backend write; `acknowledgeMany` returns only the refs that
 * actually landed, so the undo restores exactly those.
 */
const acknowledgeFiltered = async (): Promise<void> => {
  const changed = await ack.acknowledgeMany(unacknowledgedFiltered.value);
  if (!changed.length) return;
  notify(`已确认 ${changed.length} 条消息`, {
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
 * Confirm the ticked rows (minus any already acknowledged), then clear the selection. Same
 * undo-toast contract as 确认当前筛选 — `acknowledgeMany` returns only what actually landed.
 */
const acknowledgeSelected = async (): Promise<void> => {
  const refs = [...selected.value.values()].filter(
    (entry) => !ack.isAcknowledged(entry.deviceId, entry.id),
  );
  selected.value = new Map();
  const changed = await ack.acknowledgeMany(refs);
  if (!changed.length) return;
  notify(`已确认 ${changed.length} 条消息`, {
    type: "success",
    action: {
      label: "撤销",
      handler: () => void ack.unacknowledgeMany(changed),
    },
  });
};

/**
 * The per-row toggle. Confirming one message now gives the same feedback the bulk actions do —
 * a toast with an undo — because a single confirm is just as easy to misfire and was the one ack
 * path that happened silently. Un-confirming is the correction itself, so it stays quiet; a
 * failed write already surfaces its own error from `useAlertAck`.
 */
const toggleOne = async (alert: {
  deviceId: string;
  id: string;
}): Promise<void> => {
  if (ack.isAcknowledged(alert.deviceId, alert.id)) {
    void ack.unacknowledge(alert.deviceId, alert.id);
    return;
  }
  const ok = await ack.acknowledge(alert.deviceId, alert.id);
  if (!ok) return;
  notify("已确认 1 条消息", {
    type: "success",
    action: {
      label: "撤销",
      handler: () => void ack.unacknowledge(alert.deviceId, alert.id),
    },
  });
};

/**
 * How many of the alerts currently in the fleet are acknowledged.
 *
 * Deliberately **not** a stored count that would include ids for alerts that have since
 * cleared: this counts the acknowledged alerts currently in the fleet, so it cannot drift
 * upward past what the page can show. v1.0.0 made the same choice
 * (`frontend/src/views/AlertsView.vue:52-54`).
 */
const acknowledgedPresent = computed(
  () =>
    allAlerts.value.filter((alert) =>
      ack.isAcknowledged(alert.deviceId, alert.id),
    ).length,
);

/**
 * Clears the acknowledgement of every alert currently in the fleet. Symmetric with the bulk
 * confirm: it only touches alerts the page can see, so the undo can put back exactly those.
 */
const clearAcknowledged = async (): Promise<void> => {
  const cleared = await ack.unacknowledgeMany(
    allAlerts.value
      .filter((alert) => ack.isAcknowledged(alert.deviceId, alert.id))
      .map((alert) => ({ deviceId: alert.deviceId, id: alert.id })),
  );
  if (!cleared.length) return;
  notify(`已取消确认 ${cleared.length} 条消息`, {
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
 * One-time migration of this browser's old localStorage acknowledgements (Phase 16A): once
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
// (Phase 16A). Any role may read it — who-confirmed-what is shown to viewers too; only the
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
      <!--
        确认选中 — the ticked rows (see the per-row checkboxes). Explicit counterpart to
        确认当前筛选: the operator chose exactly these, possibly across pages.
      -->
      <UiButton
        v-if="isLive && canAck && selectedCount"
        variant="primary"
        size="sm"
        @click="acknowledgeSelected"
      >
        确认选中 {{ selectedCount }} 条
      </UiButton>

      <!--
        「确认当前筛选」rather than 确认本页. The research note for this control says
        「保持能力，补反馈与撤销」 —— the feedback and the undo are here; narrowing the
        scope to one page was not part of it, and on sixty active alerts it turns one
        action into four rounds of pagination.
      -->
      <UiButton
        v-if="isLive && canAck && unacknowledgedFiltered.length"
        variant="secondary"
        size="sm"
        @click="acknowledgeFiltered"
      >
        确认当前筛选 {{ unacknowledgedFiltered.length }} 条
      </UiButton>

      <!-- The counterpart v1.0.0 had beside it (`frontend/src/views/AlertsView.vue:195-202`)
           and the port dropped. The admin page's 清除本地数据 is not an equivalent: it
           takes theme, sidebar, map mode and sound preferences with it. -->
      <UiButton
        v-if="isLive && canAck && acknowledgedPresent"
        variant="secondary"
        size="sm"
        @click="clearAcknowledged"
      >
        清除已经确认 {{ acknowledgedPresent }} 条
      </UiButton>
    </template>

    <AppSectionTabs />

    <UiFilterBar>
      <UiFilterField label="严重度">
        <UiMultiSelect
          :model-value="severity"
          :options="SEVERITY_OPTIONS"
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
        <UiInput
          type="search"
          placeholder="标题/详情/设备/来源"
          :model-value="searchDraft"
          @update:model-value="onSearchInput"
          @keydown.enter.prevent="flushSearch"
        />
      </UiFilterField>

      <!--
        起止时间：仅 告警史 有（实时页读 store、没有历史可窗）。服务端过滤，能取到最近一页之外的
        旧记录。起 ≤ 止 由原生 min/max 约束；两端独立可选。
      -->
      <UiFilterField v-if="!isLive" label="起始时间">
        <UiInput
          type="date"
          :model-value="fromDate"
          :max="toDate || undefined"
          aria-label="起始日期"
          @update:model-value="(value) => setFilter({ from: value || null })"
        />
      </UiFilterField>
      <UiFilterField v-if="!isLive" label="结束时间">
        <UiInput
          type="date"
          :model-value="toDate"
          :min="fromDate || undefined"
          aria-label="结束日期"
          @update:model-value="(value) => setFilter({ to: value || null })"
        />
      </UiFilterField>

      <!--
        `min-h-6` on the label and a 16px box: the audit at 390px found this input at
        13×13, and WCAG 2.5.8 asks for a 24px target. The *label* is the target — clicking
        the words toggles it — so the height goes there rather than on the box, which would
        just make an oversized checkbox.
      -->
      <label
        v-if="isLive"
        class="flex min-h-6 items-center gap-2 text-xs text-ink-muted"
      >
        <input
          type="checkbox"
          class="size-4"
          :checked="showAcknowledged"
          @change="
            setFilter({
              acked: ($event.target as HTMLInputElement).checked ? '1' : null,
            })
          "
        />
        <!-- The count v1.0.0 carried in this label (`AlertsView.vue:185`). Without it the
             checkbox does not say whether ticking it would reveal anything. -->
        显示已确认<template v-if="acknowledgedPresent"
          >（{{ acknowledgedPresent }}）</template
        >
      </label>
    </UiFilterBar>

    <AlertHistoryPanel v-if="!isLive" />

    <template v-else>
      <!-- A live region: filtering down to nothing has to be announced, not leave a
           blank panel behind. -->
      <p
        v-if="!pageRows.length"
        class="rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
        role="status"
      >
        {{
          allAlerts.length
            ? "没有符合当前筛选条件的消息"
            : "当前车队没有活跃消息"
        }}
      </p>

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
        selected vehicle — was restored in 13T-C and **removed again in 14A acceptance**.
        It reported a fact this page cannot explain. In v1.0.0 that rule lived in an alert
        drawer *beside the map*, where the selection was visible and the operator had just
        made it. Here the page is reached from the sidebar and offers no selection control
        at all, so the ring marked whichever vehicle `ensureSelectedDevice()` had picked —
        the alphabetically first one on a cold load, or whatever was last clicked on 设备,
        possibly minutes ago on another page. Manual review read it as rows lighting up at
        random, which is the correct reading: nothing on screen accounted for it. A cue
        whose cause is off-screen is noise, however faithful it is to the original.
      -->
        <li
          v-for="alert in pageRows"
          :key="alert.id"
          class="alert-row flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3 sm:flex-row sm:items-start"
          :data-severity="alert.severity"
          :data-acknowledged="
            ack.isAcknowledged(alert.deviceId, alert.id) ? 'true' : undefined
          "
        >
          <!-- Select-to-confirm: ticking rows feeds 确认选中 above. Operator+ only, since the
               whole point is bulk acknowledgement; viewers never see it. -->
          <input
            v-if="canAck"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0"
            :checked="isSelected(alert)"
            :aria-label="`选择告警：${alert.title}`"
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
              <!-- Where the row came from. Computed on every alert since 12A and read by
                 nothing until now; it decides whether the vehicle or the platform is the
                 thing to go look at. -->
              <span>{{ SOURCE_LABELS[alert.source] || alert.source }}</span>
              <!-- Who confirmed it (Phase 16A). Server-backed, so it is the same name on
                 every console — the point of moving acknowledgement off localStorage. -->
              <span
                v-if="ack.acknowledgedBy(alert.deviceId, alert.id)"
                class="text-brand-ink"
                >已确认 ·
                {{ ack.acknowledgedBy(alert.deviceId, alert.id) }}</span
              >
            </span>
          </div>

          <!-- A toggle that says it is one, rather than a button whose meaning is
             carried by its colour.

             Idle fill is `surface-sunken` — one step *down* from the row's own
             `surface-raised`, so the control reads as a distinct button rather than a label
             painted in the row's own colour (acceptance: the old `bg-surface` sat at the same
             value as the surface behind it). The confirmed state carries the brand wash. -->
          <button
            v-if="canAck"
            type="button"
            class="inline-flex h-8 shrink-0 items-center rounded-sm border px-3 text-xs transition-colors duration-150 ease-standard"
            :class="
              ack.isAcknowledged(alert.deviceId, alert.id)
                ? 'border-brand bg-brand-wash text-brand-ink hover:bg-surface-sunken'
                : 'border-border-strong bg-surface-sunken text-ink hover:border-brand hover:bg-brand-wash hover:text-brand-ink'
            "
            :aria-pressed="ack.isAcknowledged(alert.deviceId, alert.id)"
            :aria-label="`确认消息：${alert.title}`"
            @click="toggleOne(alert)"
          >
            {{
              ack.isAcknowledged(alert.deviceId, alert.id) ? "已确认" : "确认"
            }}
          </button>
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
 * Acknowledged rows recede rather than disappear. They are hidden by default, so this
 * only shows once 显示已确认 is on — which is precisely when "which of these did I
 * already deal with" is the question being asked.
 */
.alert-row[data-acknowledged="true"] {
  opacity: 0.55;
}
</style>
