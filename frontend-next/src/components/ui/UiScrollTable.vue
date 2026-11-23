<script setup lang="ts">
/**
 * The one scroll-table shell every 报表 data table shares, so they finally read as one component
 * rather than each hand-rolling its own. It gives:
 *
 * - a gray header **outside** the vertical scroll box, so the scrollbar runs beside the records
 *   only (灰顶栏盖住滑条), padded right by the body's live scrollbar width so the two `table-fixed`
 *   tables stay column-aligned (see `useScrollbarGutter`);
 * - a vertically scrolling body, optionally pinned to a fixed `height` (toggle 图表 ⇆ 数据表 never
 *   resizes the card) or capped by `maxHeight` (content-sized up to it);
 * - **horizontal** scroll when `minWidth` exceeds the box. The body is the one scroller for both
 *   directions, so both scrollbars sit on the visible box's edges (a vertical bar at the far right
 *   of a wider track was unreachable until you scrolled sideways). The header is clipped and
 *   follows the body's `scrollLeft`, so many device columns stay aligned instead of drifting (the
 *   电量SOC表 右滚错位 bug).
 *
 * Callers provide the columns and cells through three slots: `colgroup` (rendered into both the
 * header and body tables, so widths match), `head` (a `<tr>` of `<th>`), and the default slot (the
 * body `<tr>`s).
 */
import { computed, useTemplateRef } from "vue";
import { useScrollbarGutter } from "@/composables/useScrollbarGutter";

const { label, height, maxHeight, minWidth, flush } = defineProps<{
  /** Accessible name — the sr-only `<caption>` and the scroll region's `aria-label`. */
  label?: string;
  /** Fixed card height in px (keeps 图表/数据表 toggle from resizing). Omit for content height. */
  height?: number;
  /** Cap when not fixed-height (e.g. "24rem") — the body grows to content then scrolls. */
  maxHeight?: string;
  /** Floor width (CSS) below which columns would crush; past it the table scrolls horizontally. */
  minWidth?: string;
  /**
   * Drop this shell's own rounded border so it sits flush inside a container that already draws
   * one (e.g. a bordered `<details>`), avoiding a double border and leaving the gray header with
   * square, flat top corners rather than rounded ones.
   */
  flush?: boolean;
}>();

const head = useTemplateRef<HTMLElement>("head");
const body = useTemplateRef<HTMLElement>("body");
const gutter = useScrollbarGutter(body);

/**
 * The header's track is the body's content width: the columns (`minWidth` floor) plus the body's
 * vertical-scrollbar gutter, kept as right padding so both tables get the same width and the
 * header can scroll exactly as far as the body.
 */
const headTrackStyle = computed(() => ({
  paddingRight: `${gutter.value}px`,
  ...(minWidth ? { minWidth: `calc(${minWidth} + ${gutter.value}px)` } : {}),
}));

/** The header follows the body's horizontal scroll. */
const syncHead = (): void => {
  if (head.value && body.value) head.value.scrollLeft = body.value.scrollLeft;
};

/** A horizontal swipe over the header scrolls the body (the header itself never scrolls). */
const forwardWheel = (event: WheelEvent): void => {
  if (body.value && event.deltaX) body.value.scrollLeft += event.deltaX;
};
</script>

<template>
  <div
    class="flex flex-col overflow-hidden bg-surface-raised"
    :class="flush ? '' : 'rounded-md border border-border'"
    :style="height ? { height: `${height}px` } : undefined"
  >
    <div
      ref="head"
      class="shrink-0 overflow-hidden bg-surface-sunken"
      @wheel="forwardWheel"
    >
      <div :style="headTrackStyle">
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
    </div>
    <div
      ref="body"
      class="min-h-0 flex-1 overflow-auto border-t border-border"
      :style="maxHeight && !height ? { maxHeight } : undefined"
      tabindex="0"
      role="region"
      :aria-label="label ? `${label} 数据表` : undefined"
      @scroll="syncHead"
    >
      <table
        class="w-full table-fixed border-collapse text-left text-sm"
        :style="minWidth ? { minWidth } : undefined"
      >
        <slot name="colgroup" />
        <tbody>
          <slot />
        </tbody>
      </table>
    </div>
  </div>
</template>
