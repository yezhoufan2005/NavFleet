<script setup lang="ts">
/**
 * The one scroll-table shell every 报表 data table shares, so they finally read as one component
 * (负责人 reqs: 「抽取对齐，别乱写」). It gives:
 *
 * - a gray header **outside** the vertical scroll box, so the scrollbar runs beside the records
 *   only (灰顶栏盖住滑条), padded right by the body's live scrollbar width so the two `table-fixed`
 *   tables stay column-aligned (see `useScrollbarGutter`);
 * - a vertically scrolling body, optionally pinned to a fixed `height` (toggle 图表 ⇆ 数据表 never
 *   resizes the card) or capped by `maxHeight` (content-sized up to it);
 * - whole-table **horizontal** scroll when `minWidth` exceeds the box — header and body sit in one
 *   `minWidth` track and scroll together, so many device columns stay aligned instead of the header
 *   drifting away from the body (the 电量SOC表 右滚错位 bug).
 *
 * Callers provide the columns and cells through three slots: `colgroup` (rendered into both the
 * header and body tables, so widths match), `head` (a `<tr>` of `<th>`), and the default slot (the
 * body `<tr>`s).
 */
import { useTemplateRef } from "vue";
import { useScrollbarGutter } from "@/composables/useScrollbarGutter";

const { label, height, maxHeight, minWidth } = defineProps<{
  /** Accessible name — the sr-only `<caption>` and the scroll region's `aria-label`. */
  label?: string;
  /** Fixed card height in px (keeps 图表/数据表 toggle from resizing). Omit for content height. */
  height?: number;
  /** Cap when not fixed-height (e.g. "24rem") — the body grows to content then scrolls. */
  maxHeight?: string;
  /** Floor width (CSS) below which columns would crush; past it the table scrolls horizontally. */
  minWidth?: string;
}>();

const body = useTemplateRef<HTMLElement>("body");
const gutter = useScrollbarGutter(body);
</script>

<template>
  <div
    class="flex flex-col overflow-x-auto overflow-y-hidden rounded-md border border-border bg-surface-raised"
    :style="height ? { height: `${height}px` } : undefined"
  >
    <div
      class="flex min-h-0 flex-1 flex-col"
      :style="minWidth ? { minWidth } : undefined"
    >
      <div class="bg-surface-sunken" :style="{ paddingRight: `${gutter}px` }">
        <table class="w-full table-fixed border-collapse text-left text-sm">
          <caption v-if="label" class="sr-only">
            {{
              label
            }}
          </caption>
          <slot name="colgroup" />
          <thead class="text-2xs text-ink-muted uppercase">
            <slot name="head" />
          </thead>
        </table>
      </div>
      <div
        ref="body"
        class="min-h-0 flex-1 overflow-y-auto border-t border-border"
        :style="maxHeight && !height ? { maxHeight } : undefined"
        tabindex="0"
        role="region"
        :aria-label="label ? `${label} 数据表` : undefined"
      >
        <table class="w-full table-fixed border-collapse text-left text-sm">
          <slot name="colgroup" />
          <tbody>
            <slot />
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
