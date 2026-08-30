<script setup lang="ts">
/**
 * Top bar: identity, where you are, who you are.
 *
 * Spans the full width with the sidebar below it, rather than the sidebar running
 * full height beside it. Both layouts cost the same 48px of vertical space, so the
 * 11C argument for side navigation is unaffected — and this one puts the product
 * identity, the trail and the session in a single `banner` landmark, which is both
 * the conventional structure and one landmark for a screen reader to jump to
 * instead of three.
 *
 * It stays slim on purpose. Everything that belongs to a page lives on that page;
 * this bar only carries what must be reachable from all of them.
 *
 * Two things the IA calls for are **not** here yet, and their absence is
 * deliberate rather than forgotten:
 *
 * - **The realtime status dot.** It reports whether the WebSocket is live, so it
 *   needs the fleet store — that arrives in Phase 13A. A dot hardcoded to green
 *   would be worse than no dot at all.
 * - **The fleet selector.** NavFleet is single-instance and single-fleet by design,
 *   so a picker with one option is a control that cannot be used. The fleet's
 *   *name* belongs here as text once the store can supply it.
 */
import AppBreadcrumbs from "./AppBreadcrumbs.vue";
import AppSessionMenu from "./AppSessionMenu.vue";
import type { AuthUser } from "@/composables/useAuth";
import type { SidebarMode } from "@/composables/useSidebar";

const { user, sidebarMode } = defineProps<{
  user: AuthUser | null;
  sidebarMode: SidebarMode;
}>();

const emit = defineEmits<{ logout: []; toggleNav: [] }>();

/**
 * One control, three meanings — because to the person clicking it there is only
 * one idea ("show me the navigation"), and the label has to say what will actually
 * happen. Below `lg` the sidebar is a drawer, so the same button opens it.
 */
const NAV_TOGGLE_LABELS: Record<SidebarMode, string> = {
  expanded: "收起侧栏",
  collapsed: "展开侧栏",
  overlay: "打开导航",
};
</script>

<template>
  <header
    class="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3"
  >
    <button
      type="button"
      class="grid size-8 shrink-0 place-items-center rounded-sm text-ink-muted transition-colors duration-150 ease-standard hover:bg-surface-sunken hover:text-ink"
      :aria-label="NAV_TOGGLE_LABELS[sidebarMode]"
      @click="emit('toggleNav')"
    >
      <svg
        class="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>

    <span class="flex shrink-0 items-center gap-2">
      <span
        class="grid size-7 place-items-center rounded-sm bg-brand font-mono text-xs font-semibold text-brand-contrast"
        aria-hidden="true"
        >NF</span
      >
      <!-- The product name is a heading rather than a span: it is the accessible
           name of the whole console, and the login screen uses the same level so
           the two agree about what this application is called. -->
      <h1 class="text-md font-semibold whitespace-nowrap text-ink">
        智能车队监控平台
      </h1>
    </span>

    <span
      class="hidden h-5 w-px shrink-0 bg-border md:block"
      aria-hidden="true"
    />

    <AppBreadcrumbs class="hidden md:block" />

    <div class="ml-auto flex shrink-0 items-center gap-2">
      <AppSessionMenu v-if="user" :user="user" @logout="emit('logout')" />
    </div>
  </header>
</template>
