<script setup lang="ts">
/**
 * 报码解读 — the vehicle's active report codes, decoded against the codebook, at the top of the
 * 实时 tab beside 当前任务, in the same card shape (`DeviceTaskCard`): a title row with a tag, the
 * primary reading, then a hairline and two-column label/value fields.
 *
 * Per code it answers, in order: what it is (tier badge, name, impact tag; code and subsystem), what
 * it means and what to do, then when it fired and how long it has stood.
 *
 * With no active code it renders as a title-only placeholder (no "nothing here" sentence); the
 * parent decides the placeholder's shape and widens it again the moment a code arrives.
 */
import { computed } from "vue";
import {
  CODE_IMPACTS,
  CODE_SUBSYSTEMS,
  parseTimestampMs,
  type CodeChannel,
  type DescribedCode,
} from "@navfleet/shared";
import { formatStamp } from "@navfleet/fleet-core";
import { textClasses } from "@/lib/uiClasses";
import { vOverflowTitle } from "@/directives/overflowTitle";
import { CODE_CHANNEL_LABELS, SEVERITY_BADGE } from "@/lib/severity";
import { formatDurationMs } from "@/lib/alertStats";

const {
  codes,
  stamp = "",
  collapsed = false,
  vertical = false,
} = defineProps<{
  codes: readonly { channel: CodeChannel; described: DescribedCode }[];
  /** The device's latest frame time — 持续时长 is measured to it, not to the viewer's clock. */
  stamp?: string;
  /** Placeholder: only the title. */
  collapsed?: boolean;
  /** As a placeholder beside an open card: a narrow strip with the title set vertically. */
  vertical?: boolean;
}>();

/** A code's channel wears its severity tier's badge (error → 告警 …), as messages do everywhere. */
const CHANNEL_BADGE: Record<CodeChannel, string> = {
  error: SEVERITY_BADGE.critical,
  warning: SEVERITY_BADGE.warning,
  info: SEVERITY_BADGE.notice,
};

const lasted = (since: string | null): string => {
  const start = since ? parseTimestampMs(since) : null;
  const end = parseTimestampMs(stamp);
  return start === null || end === null
    ? "--"
    : formatDurationMs(Math.max(0, end - start));
};

const rows = computed(() =>
  codes.map(({ channel, described }) => ({
    channel,
    described,
    meta: [
      String(described.code),
      described.subsystem ? CODE_SUBSYSTEMS[described.subsystem] : "",
    ]
      .filter(Boolean)
      .join(" · "),
    fields: [
      {
        label: "触发时间",
        value: described.stamp ? formatStamp(described.stamp) : "--",
      },
      { label: "持续时长", value: lasted(described.stamp) },
    ],
  })),
);
</script>

<template>
  <section
    class="device-top-card @container flex h-full min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    :class="collapsed ? 'is-collapsed' : ''"
    aria-labelledby="codes-heading"
  >
    <header
      class="flex items-center justify-between gap-3"
      :class="collapsed && vertical ? 'flex-col' : ''"
    >
      <h3
        id="codes-heading"
        class="text-md font-semibold whitespace-nowrap"
        :class="[
          collapsed ? 'text-ink-subtle' : 'text-ink',
          collapsed && vertical ? '[writing-mode:vertical-rl]' : '',
        ]"
      >
        报码解读
      </h3>
      <span
        v-if="!collapsed"
        class="rounded-xs border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted"
        >{{ codes.length }} 条活跃</span
      >
    </header>

    <!-- One block per active code, worst first, a hairline between them. -->
    <div v-if="!collapsed" class="flex flex-col divide-y divide-border">
      <article
        v-for="row in rows"
        :key="row.channel"
        class="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0"
      >
        <!-- Title row on a 3-column grid: the badge and the impact tag keep their size, the name
             takes the rest and wraps — up to two lines, then … with the full name on hover. A
             long name never pushes the tag onto its own line. -->
        <div class="flex flex-col gap-1">
          <div
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2"
          >
            <span
              class="rounded-xs px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap"
              :class="CHANNEL_BADGE[row.channel]"
              >{{ CODE_CHANNEL_LABELS[row.channel] }}</span
            >
            <strong
              v-overflow-title
              class="text-sm font-semibold text-ink"
              :class="textClasses.title"
              >{{ row.described.label }}</strong
            >
            <span
              class="rounded-xs border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted"
              :title="CODE_IMPACTS[row.described.impact].meaning"
              >{{ CODE_IMPACTS[row.described.impact].label }}</span
            >
          </div>
          <!-- Code · subsystem is metadata: one line, … past the edge, full text on hover. -->
          <p
            v-overflow-title
            class="m-0 font-mono text-2xs text-ink-subtle"
            :class="textClasses.field"
          >
            {{ row.meta }}
          </p>
        </div>

        <div class="flex flex-col gap-1">
          <!-- Body text wraps in full; wrap-break-word only splits a run with no break point
               (a long Latin token or path) so it cannot overflow the card. -->
          <p class="m-0 text-sm text-ink" :class="textClasses.body">
            {{ row.described.description }}
          </p>
          <p class="m-0 text-xs text-ink-muted" :class="textClasses.body">
            <span class="text-ink-subtle">处理建议：</span
            >{{ row.described.hint }}
          </p>
          <p
            v-if="row.described.unknown"
            class="m-0 rounded-xs bg-warning-wash px-2 py-1 text-xs text-warning-ink"
          >
            该报码不在当前字典中 —— 显示的是车端原文，含义未经解释
          </p>
        </div>

        <!-- Same two-column label/value grid as 当前任务's 起点 / 终点. -->
        <dl
          class="m-0 grid grid-cols-1 gap-x-4 @md:grid-cols-2 gap-y-2 border-t border-border pt-2.5 text-sm"
        >
          <div
            v-for="field in row.fields"
            :key="field.label"
            class="flex min-w-0 items-baseline gap-2"
          >
            <dt class="w-14 shrink-0 text-2xs text-ink-subtle">
              {{ field.label }}
            </dt>
            <dd
              v-overflow-title
              class="m-0 text-ink tabular-nums"
              :class="textClasses.field"
            >
              {{ field.value }}
            </dd>
          </div>
        </dl>
      </article>
    </div>
  </section>
</template>
