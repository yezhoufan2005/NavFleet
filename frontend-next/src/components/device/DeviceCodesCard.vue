<script setup lang="ts">
/**
 * 报码解读 — the vehicle's active report codes, decoded against the codebook, at the top of the
 * 实时 tab beside 当前任务. Same card shape as `DeviceTaskCard`: a title row with a tag, the
 * primary reading, then a hairline and the metadata in small type.
 *
 * With no active code the card collapses to a narrow placeholder (title only, no "nothing here"
 * sentence) so the row keeps its shape; the parent widens it again the moment a code arrives.
 */
import {
  CODE_IMPACTS,
  type CodeChannel,
  type DescribedCode,
} from "@navfleet/shared";
import { formatStamp } from "@navfleet/fleet-core";
import { CODE_CHANNEL_LABELS, SEVERITY_BADGE } from "@/lib/severity";

const { codes, collapsed = false } = defineProps<{
  codes: readonly { channel: CodeChannel; described: DescribedCode }[];
  /** Narrow placeholder: only the title, vertical. */
  collapsed?: boolean;
}>();

/** A code's channel wears its severity tier's badge (error → 告警 …), as messages do everywhere. */
const CHANNEL_BADGE: Record<CodeChannel, string> = {
  error: SEVERITY_BADGE.critical,
  warning: SEVERITY_BADGE.warning,
  info: SEVERITY_BADGE.notice,
};
</script>

<template>
  <section
    class="flex h-full min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    aria-labelledby="codes-heading"
  >
    <header
      class="flex items-center justify-between gap-3"
      :class="collapsed ? 'flex-col' : ''"
    >
      <h3
        id="codes-heading"
        class="text-md font-semibold whitespace-nowrap text-ink"
        :class="collapsed ? 'text-ink-subtle [writing-mode:vertical-rl]' : ''"
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
        v-for="row in codes"
        :key="row.channel"
        class="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            class="rounded-xs px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap"
            :class="CHANNEL_BADGE[row.channel]"
            >{{ CODE_CHANNEL_LABELS[row.channel] }}</span
          >
          <span class="font-mono text-2xs tabular-nums text-ink-subtle">{{
            row.described.code
          }}</span>
          <strong class="text-sm font-semibold text-ink">{{
            row.described.label
          }}</strong>
          <span
            class="ml-auto rounded-xs border border-border px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted"
            >{{ CODE_IMPACTS[row.described.impact].label }}</span
          >
        </div>

        <p class="m-0 text-sm text-ink">{{ row.described.description }}</p>
        <p class="m-0 text-xs text-ink-muted">
          <span class="text-ink-subtle">处理建议 </span>{{ row.described.hint }}
        </p>
        <p
          v-if="row.described.unknown"
          class="m-0 rounded-xs bg-warning-wash px-2 py-1 text-xs text-warning-ink"
        >
          该报码不在当前字典中 —— 显示的是车端原文，含义未经解释
        </p>

        <dl
          class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-2xs"
        >
          <dt class="text-ink-subtle">能力影响</dt>
          <dd class="m-0 text-ink-muted">
            {{ CODE_IMPACTS[row.described.impact].meaning }}
          </dd>
          <template v-if="row.described.stamp">
            <dt class="text-ink-subtle">触发时间</dt>
            <dd class="m-0 font-mono tabular-nums text-ink-muted">
              {{ formatStamp(row.described.stamp) }}
            </dd>
          </template>
          <template v-if="row.described.reported && !row.described.unknown">
            <dt class="text-ink-subtle">车端上报</dt>
            <dd class="m-0 truncate text-ink-muted">
              {{ row.described.reported }}
            </dd>
          </template>
        </dl>
      </article>
    </div>
  </section>
</template>
