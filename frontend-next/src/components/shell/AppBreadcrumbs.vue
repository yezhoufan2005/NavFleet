<script setup lang="ts">
/**
 * Breadcrumbs, derived from the matched route records (constraint C3).
 *
 * Derived rather than declared per page, because a hand-maintained trail drifts the
 * first time a route moves. Records with no `meta.title` are skipped, which is what
 * lets `/devices` be a titled parent whose empty-path child adds nothing: the trail
 * at `/devices` is 设备, and at `/devices/agv-01` it is 设备 › agv-01 › 实时.
 *
 * **Dynamic segments carry their value.** A record whose own path segment is a param
 * (`:deviceId`) and which declares no `meta.title` contributes the *resolved* value —
 * so the device detail shell shows 设备 › agv-01 rather than a static "设备详情". Its
 * link target is the param-substituted path, since `/devices/:deviceId` is not a URL.
 * A record that has a `meta.title` always uses it, so the `""` tab child under that
 * same path reads 实时 rather than repeating the id.
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

interface Crumb {
  title: string;
  /** A resolved, navigable path — params substituted from the current route. */
  path: string;
}

/** `/devices/:deviceId` → `/devices/agv-01`, so a crumb's link actually resolves. */
const resolvePath = (recordPath: string): string =>
  recordPath.replace(/:([^/]+)/g, (_match, name: string) =>
    String(route.params[name] ?? ""),
  );

const crumbs = computed<Crumb[]>(() =>
  route.matched
    .map((record): Crumb | null => {
      if (typeof record.meta.title === "string") {
        return { title: record.meta.title, path: resolvePath(record.path) };
      }
      // A titleless record whose leaf segment is a param stands in for the value.
      const leaf = record.path.split("/").at(-1) ?? "";
      if (leaf.startsWith(":")) {
        const value = route.params[leaf.slice(1)];
        if (value)
          return { title: String(value), path: resolvePath(record.path) };
      }
      return null;
    })
    .filter((crumb): crumb is Crumb => crumb !== null),
);
</script>

<template>
  <nav aria-label="面包屑" class="min-w-0">
    <ol class="flex min-w-0 items-center gap-1.5 text-sm">
      <li
        v-for="(crumb, index) in crumbs"
        :key="index"
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
        <!--
          `custom`, so vue-router does not stamp `aria-current="page"` onto an ancestor
          link whose path happens to equal the current route — the device-id crumb links
          to `/devices/<id>`, which is exactly the live tab's own URL. Only the last
          crumb (the span below) is the current page; an intermediate link never is.
        -->
        <RouterLink v-else v-slot="{ href, navigate }" :to="crumb.path" custom>
          <a
            :href="href"
            class="truncate text-ink-muted underline-offset-2 transition-colors duration-150 ease-standard hover:text-ink hover:underline"
            @click="navigate"
          >
            {{ crumb.title }}
          </a>
        </RouterLink>
      </li>
    </ol>
  </nav>
</template>
