<script setup lang="ts">
/**
 * 当前任务 — the task the vehicle reports it is on, beside 报码解读 at the top of the 实时 tab.
 *
 * Read-only telemetry (see shared `DeviceTask`): the platform shows what the vehicle says it is
 * doing and dispatches nothing. The card reads top-down as an operator asks: which task, how far
 * along (a segmented bar, one segment per step), from where to where, and since when.
 */
import { computed } from "vue";
import { formatStamp } from "@navfleet/fleet-core";
import { parseTimestampMs, type DeviceTask } from "@navfleet/shared";
import UiHelpTip from "@/components/ui/UiHelpTip.vue";
import { FIELD_HELP } from "@/lib/fieldHelp";
import { formatDurationMs } from "@/lib/alertStats";

const {
  task,
  stamp,
  collapsed = false,
} = defineProps<{
  task: DeviceTask | null | undefined;
  /** The device's latest frame time — 已进行 is measured to it, not to the viewer's clock. */
  stamp: string;
  /** Narrow placeholder: only the title, vertical (see `DeviceCodesCard`). */
  collapsed?: boolean;
}>();

const segments = computed(() =>
  task?.steps
    ? Array.from({ length: task.steps }, (_, index) => index < (task.step ?? 0))
    : [],
);

const stepLabel = computed(() => {
  if (!task) return "";
  const count =
    task.step !== null && task.steps !== null
      ? `第 ${task.step} / ${task.steps} 步`
      : "";
  return [count, task.stepName].filter(Boolean).join(" · ");
});

const route = computed(() =>
  task
    ? [
        { key: "from", label: "起点", value: task.from },
        { key: "to", label: task.from ? "终点" : "目标", value: task.to },
      ].filter((end) => end.value)
    : [],
);

const elapsed = computed(() => {
  if (!task?.startedAt) return "--";
  const start = parseTimestampMs(task.startedAt);
  const end = parseTimestampMs(stamp);
  return start === null || end === null
    ? "--"
    : formatDurationMs(Math.max(0, end - start));
});
</script>

<template>
  <section
    class="flex h-full min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    aria-labelledby="task-heading"
  >
    <header
      class="flex items-center justify-between gap-3"
      :class="collapsed ? 'flex-col' : ''"
    >
      <h3
        id="task-heading"
        class="flex items-center gap-1 text-md font-semibold whitespace-nowrap text-ink"
        :class="collapsed ? 'text-ink-subtle [writing-mode:vertical-rl]' : ''"
      >
        当前任务<UiHelpTip v-if="!collapsed" :text="FIELD_HELP.device.task" />
      </h3>
      <span
        v-if="!collapsed && task?.type"
        class="rounded-xs border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted"
        >{{ task.type }}</span
      >
    </header>

    <template v-if="!collapsed && task">
      <p class="m-0 font-mono text-2xs break-all text-ink-subtle">
        {{ task.id }}
      </p>

      <div class="flex flex-col gap-1.5">
        <div
          v-if="segments.length"
          class="flex gap-1"
          role="progressbar"
          :aria-valuenow="task.step ?? 0"
          aria-valuemin="0"
          :aria-valuemax="task.steps ?? 0"
          :aria-valuetext="stepLabel"
          aria-label="任务进度"
        >
          <span
            v-for="(done, index) in segments"
            :key="index"
            class="h-1.5 flex-1 rounded-full"
            :class="done ? 'bg-brand' : 'bg-border'"
          />
        </div>
        <p class="m-0 text-sm text-ink">{{ stepLabel || "--" }}</p>
      </div>

      <ol v-if="route.length" class="m-0 flex list-none flex-col gap-1 p-0">
        <li
          v-for="end in route"
          :key="end.key"
          class="flex items-baseline gap-2 text-sm"
        >
          <span class="w-8 shrink-0 text-2xs text-ink-subtle">{{
            end.label
          }}</span>
          <span class="truncate text-ink">{{ end.value }}</span>
        </li>
      </ol>

      <dl class="m-0 grid grid-cols-2 gap-3 border-t border-border pt-3">
        <div class="flex flex-col gap-0.5">
          <dt class="text-2xs text-ink-subtle">开始时间</dt>
          <dd class="m-0 font-mono text-xs tabular-nums text-ink">
            {{ formatStamp(task.startedAt) }}
          </dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-2xs text-ink-subtle">已进行</dt>
          <dd class="m-0 font-mono text-xs tabular-nums text-ink">
            {{ elapsed }}
          </dd>
        </div>
      </dl>
    </template>
  </section>
</template>
