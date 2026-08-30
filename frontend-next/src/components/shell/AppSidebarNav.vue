<script setup lang="ts">
/**
 * Primary navigation.
 *
 * Renders the same markup in all three sidebar modes — only the width and whether
 * labels are visible differ — so there is one set of links to keep accessible
 * rather than one per mode. In `collapsed` mode the label stays in the DOM, hidden
 * from sight but not from assistive technology, and each link carries a `title` so
 * a mouse user can recover the name too.
 *
 * The item list comes from `NAV_SECTIONS` in the router module. A test resolves
 * every entry against the real route table, so a renamed route cannot leave a
 * silently dead link here.
 *
 * ## Why `custom` rather than `active-class`
 *
 * Two reasons, both learned the hard way:
 *
 * 1. Handing `active-class` a set of colour utilities puts them in a specificity
 *    tie with the idle ones — both are single-class selectors, so which wins is
 *    decided by Tailwind's output order rather than by anything written here. The
 *    two class sets below are mutually exclusive instead, which needs no `!`.
 * 2. **The active state must not transition its colours.** In v1.0.0 the nav pill
 *    animated `background` and `color` on different curves, so for ~160ms the
 *    outgoing item rendered muted ink on the brand fill — a real 1.38:1 pair that
 *    turned up as an intermittently red axe audit (see ROADMAP, 2026-08-29). The
 *    highlight is "you are here", which should be immediate anyway.
 *
 * `aria-current` is set from `isExactActive`, not `isActive`: while a device detail
 * page is open the 设备 item is highlighted as the containing section, but the
 * current *page* is the detail page, and announcing both as current is a lie.
 */
import { RouterLink } from "vue-router";
import { NAV_SECTIONS } from "@/router";
import NavIcon from "./NavIcon.vue";

const { labelled = true } = defineProps<{
  /** `false` in collapsed mode: icons only. */
  labelled?: boolean;
}>();

const BASE_CLASS = "group flex items-center rounded-sm py-2 font-medium";
/**
 * Collapsed, the rail is 44px wide (11C §3.1) and the nav's own padding takes 12 of
 * them, so a labelled item's `px-2` plus a 20px icon does not fit and the pill
 * clips at the edge. Centring with no horizontal padding is what makes the icon sit
 * in the middle of the rail rather than against its side.
 */
const SPACING_CLASS = {
  labelled: "gap-3 px-2",
  collapsed: "justify-center px-0",
} as const;
const IDLE_CLASS =
  "text-ink-muted transition-colors duration-150 ease-standard hover:bg-surface-sunken hover:text-ink";
const ACTIVE_CLASS = "bg-brand text-brand-contrast";
</script>

<template>
  <nav
    aria-label="主导航"
    class="flex min-h-0 flex-1 flex-col gap-1 py-2"
    :class="labelled ? 'px-2' : 'px-1.5'"
  >
    <RouterLink
      v-for="section in NAV_SECTIONS"
      :key="section.routeName"
      v-slot="{ href, isActive, isExactActive, navigate }"
      :to="{ name: section.routeName }"
      custom
    >
      <a
        :href="href"
        :class="[
          BASE_CLASS,
          labelled ? SPACING_CLASS.labelled : SPACING_CLASS.collapsed,
          isActive ? ACTIVE_CLASS : IDLE_CLASS,
        ]"
        :aria-current="isExactActive ? 'page' : undefined"
        :title="labelled ? undefined : section.label"
        @click="navigate"
      >
        <NavIcon :name="section.icon" />
        <!-- Kept in the accessibility tree when collapsed rather than removed:
             the link's name is the only thing that says where it goes. -->
        <span :class="labelled ? 'truncate text-md' : 'sr-only'">
          {{ section.label }}
        </span>
      </a>
    </RouterLink>
  </nav>
</template>
