<script setup lang="ts">
/**
 * Secondary navigation: the tab strip for a section (1.6.2 IA).
 *
 * A section like 用户 owns more than one page (账号 and 角色与用户组). Rather than the old
 * approach — cards under a 管理 hub, or a lone `?view=` toggle bolted to a filter bar (消息's
 * 告警史) — its pages are real child routes and this strip switches between them. Because they
 * are routes, a pasted link opens the right tab, Back/Forward walk the tabs, and the active
 * state follows `router-link-active` rather than a local ref.
 *
 * The strip is declared once on the section's parent route (`meta.tabs`) and read off the
 * matched ancestor here — a normalized matched record does not expose its own `children`, so the
 * list lives in meta instead of being derived from them. Each section page renders it just under
 * its `PageHeader` title, so the section name sits above the strip and the tab switches the
 * content below. It renders nothing on a page that is not part of a multi-tab section.
 *
 * Tabs the current user may not see are filtered out (same capability rule as the primary nav);
 * the route guard is still the real gate. A section that would show only one tab renders nothing —
 * a single tab is not a choice, and the page's own header already names it.
 */
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { SectionTab } from "@/router";
import { useAuth } from "@/composables/useAuth";

const route = useRoute();
const { can } = useAuth();

/** The strip declared nearest the current page: the deepest matched record that carries one. */
const tabs = computed<readonly SectionTab[]>(() => {
  const withTabs = route.matched.filter((record) => record.meta.tabs?.length);
  const owner = withTabs.at(-1);
  return (owner?.meta.tabs ?? []).filter(
    (tab) => !tab.capability || can(tab.capability),
  );
});

const IDLE_CLASS =
  "border-transparent text-ink-muted hover:border-border-strong hover:text-ink";
const ACTIVE_CLASS = "border-brand text-ink";
</script>

<template>
  <!--
    No `overflow` here on purpose: `overflow-x: auto` forces the computed `overflow-y` to `auto`
    too, and the tabs' `-mb-px` (which laps the bottom border onto the strip's own) then pokes one
    pixel past the box and raises a spurious vertical scrollbar. The handful of short tabs never
    need to scroll horizontally, so the safe fix is to not scroll at all.
  -->
  <nav
    v-if="tabs.length > 1"
    aria-label="分区导航"
    class="mb-4 flex gap-1 border-b border-border"
  >
    <RouterLink
      v-for="tab in tabs"
      :key="tab.routeName"
      v-slot="{ href, isExactActive, navigate }"
      :to="{ name: tab.routeName }"
      custom
    >
      <a
        :href="href"
        :class="[
          '-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-standard',
          isExactActive ? ACTIVE_CLASS : IDLE_CLASS,
        ]"
        :aria-current="isExactActive ? 'page' : undefined"
        @click="navigate"
      >
        {{ tab.label }}
      </a>
    </RouterLink>
  </nav>
</template>
