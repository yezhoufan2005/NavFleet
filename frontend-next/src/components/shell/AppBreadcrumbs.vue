<script setup lang="ts">
/**
 * Breadcrumbs, derived from the matched route records (constraint C3).
 *
 * Derived rather than declared per page, because a hand-maintained trail drifts the
 * first time a route moves. Records with no `meta.title` are skipped, which is what
 * lets `/devices` be a titled parent whose empty-path child adds nothing: the trail
 * at `/devices` is 设备, and at `/devices/agv-01` it is 设备 › 设备详情.
 *
 * The last item is the current page and is not a link — an anchor to where you
 * already are is a keyboard stop that does nothing. It carries `aria-current="page"`
 * instead.
 *
 * The root is not repeated as a "首页" crumb. 总览 is a section like the others and
 * appears in the trail under its own name when it is the page you are on.
 */
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

const route = useRoute();

const crumbs = computed(() =>
  route.matched
    .filter((record) => typeof record.meta.title === "string")
    .map((record) => ({
      title: record.meta.title as string,
      path: record.path,
    })),
);
</script>

<template>
  <nav aria-label="面包屑" class="min-w-0">
    <ol class="flex min-w-0 items-center gap-1.5 text-sm">
      <li
        v-for="(crumb, index) in crumbs"
        :key="crumb.path"
        class="flex min-w-0 items-center gap-1.5"
      >
        <span
          v-if="index > 0"
          class="text-ink-subtle select-none"
          aria-hidden="true"
          >›</span
        >
        <span
          v-if="index === crumbs.length - 1"
          class="truncate font-medium text-ink"
          aria-current="page"
        >
          {{ crumb.title }}
        </span>
        <RouterLink
          v-else
          :to="crumb.path"
          class="truncate text-ink-muted underline-offset-2 transition-colors duration-150 ease-standard hover:text-ink hover:underline"
        >
          {{ crumb.title }}
        </RouterLink>
      </li>
    </ol>
  </nav>
</template>
