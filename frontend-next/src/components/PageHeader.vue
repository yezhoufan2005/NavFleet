<script setup lang="ts">
/**
 * The frame every page sits in: title, optional lede, actions slot, content.
 *
 * Exists so the page heading is one decision made once rather than twelve. v1.0.0
 * had no such thing, and the result is visible in `frontend-parity.md`: heading
 * levels, spacing and whether a page even has a title vary page by page.
 *
 * The title is an `h2`. The product name in the top bar is the document's `h1`, so
 * a page heading is one level below it — that also matches v1.0.0, which keeps the
 * existing Playwright `getByRole("heading", …)` queries working (they match on
 * name, not level, but the reading order they imply should still be right).
 *
 * ## `lede` is for information, not for describing the page
 *
 * Seven of the nine pages used to carry a sentence explaining what the page was
 * («列表与地图是同一批设备的两种投影»), and manual review asked for all of them gone.
 * Rightly: an operator who opens 设备 twice a shift reads that line zero times, and
 * it costs a permanent band of vertical space on every page above the content they
 * came for. The pages that keep a lede are the two where the line *is* content —
 * 404's explanation, and the device id on 设备详情.
 *
 * If a page genuinely has something to state (场景's read-only red line), it goes in
 * the body, where it sits with the rest of the page's content and can react to state.
 *
 * ## `scrollContent`
 *
 * Two page shapes exist in this console, and until 14A one of them was accidental.
 * 总览 / 设备 / 报表 / 管理 fill the viewport and scroll *inside* a panel; 系统状态
 * (measured at 1650px against an 852px content area) instead scrolled as a document,
 * so the page title left the screen and, on a page that also has a scrollable table,
 * there were two scrollbars whose targets depended on where the pointer was. Manual
 * review reported that as a bug, and it is: the shell is fixed to `h-dvh`, so a page
 * that outgrows it hands the operator a second, unexpected scroller.
 *
 * Opting in keeps the heading and the actions in place and gives the content its own
 * scroller. It is a prop rather than the default because a page whose content fits has
 * nothing to gain from an extra scroll container, and one that lays out its own
 * viewport-filling panels (设备) must not get a second one wrapped around them.
 */
defineProps<{
  title: string;
  lede?: string;
  /** Fill the viewport and scroll the content, instead of scrolling the whole page. */
  scrollContent?: boolean;
}>();
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4" :class="{ 'h-full': scrollContent }">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-xl font-semibold text-ink">{{ title }}</h2>
        <p v-if="lede" class="max-w-prose text-sm text-ink-muted">{{ lede }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <!--
      The wrapper repeats `flex flex-col gap-4` on purpose: the slot's children are
      otherwise laid out by the root, and moving them into a plain `div` would drop
      the spacing between them.

      `relative` is load-bearing, not decoration. A scroll container only clips
      absolutely-positioned descendants whose containing block it *is* — so without it,
      every `sr-only` element inside (`position: absolute`) escaped the clip and was
      contained by the initial containing block instead. On 系统状态 the table's
      `<caption class="sr-only">` sat at document y=1191 and stretched the **document**
      to 1192px against a 900px viewport: the page-level scrollbar this prop exists to
      remove, reintroduced by a 1px invisible box. Measured, not guessed.
    -->
    <div
      v-if="scrollContent"
      class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
    >
      <slot />
    </div>
    <slot v-else />
  </div>
</template>
