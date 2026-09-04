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
 * The honest limitation is stated on the page, not buried here: acknowledgements are
 * per-browser. They do not reach the database, carry no who and no when, and the next
 * person on shift sees none of them. Saying so is the difference between a known
 * limitation and a silent one.
 */
import { computed, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import { useFleetStore } from "@/stores/fleet";
import { useAlertAck } from "@/composables/useAlertAck";
import { useDebouncedText } from "@/composables/useDebouncedText";
import { useNotifications } from "@/composables/useNotifications";
import { formatDateTime } from "@navfleet/fleet-core";
import type { Severity } from "@navfleet/shared";

const PAGE_SIZE = 20;

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

const SEVERITIES: readonly { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "critical", label: "告警" },
  { value: "warning", label: "预警" },
  { value: "notice", label: "提示" },
];

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
};

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
const { notify } = useNotifications();

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

const severity = computed<Severity | "all">(() => {
  const value = readParam("severity");
  return value === "critical" || value === "warning" || value === "notice"
    ? value
    : "all";
});
const deviceFilter = computed(() => readParam("device"));
const search = computed(() => readParam("q"));
const showAcknowledged = computed(() => readParam("acked") === "1");
const page = computed(() => {
  const value = Number(readParam("page"));
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
});

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

const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const alert of allAlerts.value) {
    if (!seen.has(alert.deviceId)) {
      seen.set(alert.deviceId, alert.deviceName || alert.deviceId);
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
});

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return allAlerts.value.filter((alert) => {
    if (severity.value !== "all" && alert.severity !== severity.value)
      return false;
    if (deviceFilter.value && alert.deviceId !== deviceFilter.value)
      return false;
    if (!showAcknowledged.value && ack.isAcknowledged(alert.id)) return false;
    if (!keyword) return true;
    return [
      alert.title,
      alert.detail,
      alert.deviceName,
      alert.deviceId,
      alert.info,
      // Both forms of the source: the operator sees 规则引擎 on the row, so that is what
      // they will type — but a deployment reading logs may know it as `rule-engine`. The
      // placeholder names 来源, and a placeholder that promises a field the filter does
      // not search is its own small lie.
      SOURCE_LABELS[alert.source],
      alert.source,
    ]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  });
});

const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)),
);
const pageRows = computed(() => {
  const start = (Math.min(page.value, pageCount.value) - 1) * PAGE_SIZE;
  return filtered.value.slice(start, start + PAGE_SIZE);
});

// A list that shrinks under a filter can leave the page number past the end.
watch(pageCount, (count) => {
  if (page.value > count) setQuery({ page: count > 1 ? String(count) : null });
});

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
    .filter((alert) => !ack.isAcknowledged(alert.id))
    .map((alert) => alert.id),
);

/**
 * Acknowledging in bulk offers an undo, because it is the one action here that is both
 * easy to trigger by accident and tedious to reverse by hand. That matters more now that
 * the button reaches past the page — the undo is what makes the wider scope safe rather
 * than alarming.
 */
const acknowledgeFiltered = (): void => {
  const changed = ack.acknowledgeMany(unacknowledgedFiltered.value);
  if (!changed.length) return;
  notify(`已确认 ${changed.length} 条告警`, {
    type: "success",
    action: { label: "撤销", handler: () => ack.unacknowledgeMany(changed) },
  });
};

/**
 * How many of the alerts currently in the fleet are acknowledged.
 *
 * Deliberately **not** `ack.acknowledgedCount`, which counts the whole stored set: that
 * includes ids for alerts that have since cleared, so it drifts upward forever and would
 * report "12 acknowledged" on a page showing three rows. v1.0.0 made the same choice
 * (`frontend/src/views/AlertsView.vue:52-54`).
 */
const acknowledgedPresent = computed(
  () => allAlerts.value.filter((alert) => ack.isAcknowledged(alert.id)).length,
);

/**
 * Clears the acknowledgement of every alert currently in the fleet.
 *
 * `clearAll` would also drop ids belonging to alerts that are no longer present, which
 * is a different and larger action than the button says. The admin page's "clear local
 * data" is not an equivalent either — it takes theme, sidebar, map mode and sound
 * preferences with it.
 */
const clearAcknowledged = (): void => {
  const cleared = ack.unacknowledgeMany(
    allAlerts.value
      .filter((alert) => ack.isAcknowledged(alert.id))
      .map((a) => a.id),
  );
  if (!cleared.length) return;
  notify(`已取消确认 ${cleared.length} 条告警`, {
    type: "info",
    action: { label: "撤销", handler: () => ack.acknowledgeMany(cleared) },
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
</script>

<template>
  <PageHeader title="消息">
    <template #actions>
      <!--
        「确认当前筛选」rather than 确认本页. The research note for this control says
        「保持能力，补反馈与撤销」 —— the feedback and the undo are here; narrowing the
        scope to one page was not part of it, and on sixty active alerts it turns one
        action into four rounds of pagination.
      -->
      <button
        v-if="unacknowledgedFiltered.length"
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
        @click="acknowledgeFiltered"
      >
        确认当前筛选 {{ unacknowledgedFiltered.length }} 条
      </button>

      <!-- The counterpart v1.0.0 had beside it (`frontend/src/views/AlertsView.vue:195-202`)
           and the port dropped. The admin page's 清除本地数据 is not an equivalent: it
           takes theme, sidebar, map mode and sound preferences with it. -->
      <button
        v-if="acknowledgedPresent"
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
        @click="clearAcknowledged"
      >
        清除已确认 {{ acknowledgedPresent }} 条
      </button>
    </template>

    <!--
      Trimmed rather than deleted (14E). Acceptance asked whether this could go, and the
      answer is half: the *fact* has to stay, because an operator who acknowledges twenty
      rows and then hears a colleague say they see none of them acknowledged has been
      misled by a silence. What went is the half that was written for us — "不入库、不记录
      操作人与时间" restates the same thing in implementation terms, and "落库与历史留到
      Phase 16" is a roadmap note on a page an operator opens every shift.
    -->
    <p class="text-xs text-ink-muted">
      确认状态只保存在本浏览器，换台机器或换个人都看不到。
    </p>

    <div class="flex flex-wrap items-end gap-3">
      <div
        class="flex overflow-hidden rounded-sm border border-border-strong"
        role="group"
        aria-label="严重度"
      >
        <button
          v-for="option in SEVERITIES"
          :key="option.value"
          type="button"
          class="px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            severity === option.value
              ? 'bg-brand text-brand-contrast'
              : 'bg-surface-raised text-ink-muted hover:text-ink'
          "
          :aria-pressed="severity === option.value"
          @click="
            setFilter({
              severity: option.value === 'all' ? null : option.value,
            })
          "
        >
          {{ option.label }}
        </button>
      </div>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">设备</span>
        <select
          class="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink"
          :value="deviceFilter"
          @change="
            setFilter({
              device: ($event.target as HTMLSelectElement).value || null,
            })
          "
        >
          <option value="">全部设备</option>
          <option
            v-for="option in deviceOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">搜索</span>
        <!--
          Bound to the local draft, committed on a timer. Bound to `search` it would read
          from the URL it is about to rewrite, and every keystroke was a navigation.
          `keydown.enter` skips the wait, because pressing Enter in a search box means
          "now" — and `search` inputs get a native clear button, whose `input` event goes
          through the same debounce.
        -->
        <input
          type="search"
          class="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink"
          placeholder="标题/详情/设备/来源"
          :value="searchDraft"
          @input="onSearchInput(($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="flushSearch"
        />
      </label>

      <label class="flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
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
    </div>

    <!-- A live region: filtering down to nothing has to be announced, not leave a
         blank panel behind. -->
    <p
      v-if="!pageRows.length"
      class="rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      {{
        allAlerts.length
          ? "没有符合当前筛选条件的告警。"
          : "当前车队没有活跃告警。"
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
        :data-acknowledged="ack.isAcknowledged(alert.id) ? 'true' : undefined"
      >
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
          </span>
        </div>

        <!-- A toggle that says it is one, rather than a button whose meaning is
             carried by its colour.

             The idle hover moves the border and the surface, not only the ink: acceptance
             reported the hover as barely visible, and it was — a muted-to-ink text change
             on a 12px label is a few percent of the control's area. The confirmed state
             darkens its wash instead, because that one already carries a brand fill and a
             second fill on top would read as a different state rather than a hover. -->
        <button
          type="button"
          class="shrink-0 rounded-sm border px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            ack.isAcknowledged(alert.id)
              ? 'border-brand bg-brand-wash text-brand-ink hover:bg-surface-sunken'
              : 'border-border-strong bg-surface text-ink-muted hover:border-brand hover:bg-brand-wash hover:text-brand-ink'
          "
          :aria-pressed="ack.isAcknowledged(alert.id)"
          :aria-label="`确认告警：${alert.title}`"
          @click="
            ack.isAcknowledged(alert.id)
              ? ack.unacknowledge(alert.id)
              : ack.acknowledge(alert.id)
          "
        >
          {{ ack.isAcknowledged(alert.id) ? "已确认" : "确认" }}
        </button>
      </li>
    </ul>

    <nav
      v-if="pageCount > 1"
      class="flex items-center justify-between gap-3"
      aria-label="分页"
    >
      <button
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted disabled:opacity-50"
        :disabled="page <= 1"
        @click="setQuery({ page: page > 2 ? String(page - 1) : null })"
      >
        上一页
      </button>
      <span class="font-mono text-2xs text-ink-muted"
        >第 {{ Math.min(page, pageCount) }} / {{ pageCount }} 页 · 共
        {{ filtered.length }} 条</span
      >
      <button
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted disabled:opacity-50"
        :disabled="page >= pageCount"
        @click="setQuery({ page: String(Math.min(page + 1, pageCount)) })"
      >
        下一页
      </button>
    </nav>
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
