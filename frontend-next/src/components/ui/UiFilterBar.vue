<script setup lang="ts">
/**
 * The filter toolbar: a wrapping flex row that holds the page's `UiFilterField`s.
 *
 * The bars had drifted into two shapes — 设备 / 消息 / 报表 wrote a bare
 * `<div class="flex flex-wrap items-end gap-3">`, while 审计 / 外发 wrote the same row as a
 * `<section aria-label="筛选">`. Only the second is reachable as a landmark, so a screen-reader
 * user could jump to the filters on two pages and not the other three. This standardises on the
 * labelled region everywhere; `ariaLabel` defaults to 筛选 and a page with two bars can name them
 * apart.
 *
 * Layout only (`flex flex-wrap items-end gap-3`): fields keep their own widths, wrap to the next
 * line when the row runs out, and sit bottom-aligned so captions of different heights still line
 * their controls up.
 */
withDefaults(defineProps<{ ariaLabel?: string }>(), { ariaLabel: "筛选" });
</script>

<template>
  <section class="flex flex-wrap items-end gap-3" :aria-label="ariaLabel">
    <slot />
  </section>
</template>
