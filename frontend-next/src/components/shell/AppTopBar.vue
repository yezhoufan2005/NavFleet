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
 * The two things 12C deliberately left blank now arrive with the store (13A-1):
 *
 * - **The realtime status indicator**, which is a dot *and a word*. Colour alone
 *   cannot carry it: a dot that only changes hue says nothing to a colourblind
 *   operator and nothing at all to a screen reader. `role="status"` makes it a live
 *   region, so losing the link is announced rather than merely recoloured.
 * - **The fleet name**, as text. There is still no fleet *selector*: NavFleet is
 *   single-fleet by design, and a picker with one option is a control that cannot
 *   be used.
 */
import { computed } from "vue";
import AppBreadcrumbs from "./AppBreadcrumbs.vue";
import AppSessionMenu from "./AppSessionMenu.vue";
import type { AuthUser } from "@/composables/useAuth";
import type { SidebarMode } from "@/composables/useSidebar";
import { useFleetStore } from "@/stores/fleet";
import type { ConnectionTone } from "@/stores/fleet";

const PRODUCT_NAME = "智能车队监控平台";

const { user, sidebarMode } = defineProps<{
  user: AuthUser | null;
  sidebarMode: SidebarMode;
}>();

const emit = defineEmits<{ logout: []; toggleNav: [] }>();

const fleet = useFleetStore();
const connection = computed(() => fleet.connection);

/**
 * The deployment's fleet name, unless it would only repeat the product name.
 *
 * A single-fleet deployment that never configured one is called 智能车队, and
 * rendering "智能车队监控平台 · 智能车队" spends the most valuable strip of the
 * screen restating the title. A deployment that *did* name its fleet (北区仓储车队)
 * gets it shown, which is the case the name is for.
 */
const fleetName = computed(() => {
  const name = fleet.state.fleetName;
  return name && !PRODUCT_NAME.includes(name) ? name : "";
});

/**
 * Literal class strings, not `` `bg-${tone}` `` — Tailwind only generates what it
 * can see written out, so an interpolated class silently produces no CSS.
 *
 * `ok` is `brand` because the palette has no success colour on purpose: the four
 * status colours describe problems, and "healthy" is the absence of one.
 */
const TONE_DOT: Record<ConnectionTone, string> = {
  ok: "bg-brand",
  warning: "bg-warning",
  critical: "bg-critical",
  pending: "bg-offline",
};

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
      <span
        v-if="fleetName"
        class="hidden max-w-40 truncate text-xs text-ink-muted lg:block"
        >{{ fleetName }}</span
      >
    </span>

    <span
      class="hidden h-5 w-px shrink-0 bg-border md:block"
      aria-hidden="true"
    />

    <AppBreadcrumbs class="hidden md:block" />

    <div class="ml-auto flex shrink-0 items-center gap-2">
      <!-- The word beside the dot is what makes this readable without colour
           vision; `role="status"` is what makes losing the link audible. -->
      <span
        role="status"
        class="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-ink-muted"
        :title="connection.detail"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :class="TONE_DOT[connection.tone]"
          aria-hidden="true"
        />
        <span class="whitespace-nowrap">{{ connection.label }}</span>
      </span>

      <AppSessionMenu v-if="user" :user="user" @logout="emit('logout')" />
    </div>
  </header>
</template>
