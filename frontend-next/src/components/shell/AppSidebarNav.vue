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
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { NAV_SECTIONS } from "@/router";
import { useFleetStore } from "@/stores/fleet";
import NavIcon from "./NavIcon.vue";

const { labelled = true } = defineProps<{
  /** `false` in collapsed mode: icons only. */
  labelled?: boolean;
}>();

const fleet = useFleetStore();

/**
 * The alert count, and the worst severity behind it.
 *
 * v1.0.0 had a badge here (`frontend/src/App.vue:123-126`) and the port dropped it, so an
 * operator on 设备 / 报表 / 管理 could not see that anything was waiting — the capability
 * lost is **"knowing whether to switch pages without switching pages"**, which is the
 * whole reason a nav badge exists.
 *
 * Two things about the old one are deliberately *not* ported:
 *
 * 1. It was always critical-red (`navigation.css:52-63`) whatever the worst severity
 *    actually was, so a fleet with three 提示 rows looked like a fleet on fire. The tone
 *    follows the worst severity present.
 * 2. It was a bare number with nothing to announce it. A screen reader read "告警 3" and
 *    3 could have been anything; the link now carries its own accessible name.
 */
const alertBadge = computed(() => {
  const { critical, warning, notice } = fleet.groupedAlerts;
  const total = critical.length + warning.length + notice.length;
  if (!total) return null;
  const tone = critical.length
    ? "critical"
    : warning.length
      ? "warning"
      : "notice";
  const worst = critical.length ? "告警" : warning.length ? "预警" : "提示";
  return {
    total,
    tone,
    // Capped for width, not for truth — the accessible name keeps the real number.
    text: total > 99 ? "99+" : String(total),
    /**
     * Appended to the link's accessible name, which becomes e.g. 「告警 待处理 3 条（最高
     * 告警级）」. Kept short on purpose: this is read out every time a keyboard user lands
     * on the item, so it has to answer "how many, how bad" and stop.
     *
     * The severity is in the **text**, not only in the pill's colour — a colourblind
     * operator gets nothing from the tone, and that is the same reason `AppTopBar`'s
     * realtime dot carries a word.
     */
    label: `待处理 ${total} 条（最高${worst}级）`,
  };
});

/**
 * `min-h-10` is the fix for a jump nobody would describe as a bug and everybody sees.
 *
 * The row is a flex box, so its height came from whichever child was tallest: labelled
 * that is the label's line box (`--text-md` 15px × 1.6 = 24px), collapsed it is the icon
 * (20px). With `py-2` that is 40px against 36px — so collapsing the sidebar shortened
 * every row by 4px and, because the rows stack, each icon slid up by a further 4px than
 * the one above it. Manual review called it «不流畅的上移视觉», which is exactly what a
 * cumulative offset looks like.
 *
 * 40px = `py-2` + a 24px line box, i.e. the labelled height, pinned so the collapsed rail
 * cannot be shorter. Fixing the *row* rather than nudging the icon down is what makes the
 * two modes agree by construction instead of by a compensating offset that a later change
 * to the icon size would silently undo. `console-shell.spec.ts` measures both.
 */
const BASE_CLASS =
  "group flex min-h-10 items-center rounded-sm py-2 font-medium";
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

/**
 * The badge's own colours, which do **not** transition.
 *
 * Same reason `ACTIVE_CLASS` does not: a pill that animates between a status fill and the
 * brand fill spends ~160ms on an intermediate pair nobody checked the contrast of, and
 * that is exactly the intermittent axe failure documented above.
 */
const BADGE_TONE_CLASS: Record<string, string> = {
  critical: "bg-critical text-critical-contrast",
  warning: "bg-warning text-warning-contrast",
  notice: "bg-notice text-notice-contrast",
};
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
          section.routeName === 'alerts' && alertBadge && !labelled
            ? 'relative'
            : '',
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

        <!--
          One badge, two placements. Labelled it is a trailing pill; collapsed there is no
          label to trail, so it pins to the icon's corner — the rail is 44px wide and an
          inline pill beside a centred icon would not fit.

          `aria-hidden` on the digits with the real sentence on a `sr-only` span: a screen
          reader reading "告警 3" learns nothing, and that is exactly what v1.0.0's bare
          number did.
        -->
        <template v-if="section.routeName === 'alerts' && alertBadge">
          <span
            aria-hidden="true"
            :class="[
              'shrink-0 rounded-full text-center font-mono text-2xs tabular-nums',
              BADGE_TONE_CLASS[alertBadge.tone],
              labelled
                ? 'ml-auto min-w-5 px-1.5 py-0.5'
                : 'absolute top-0.5 right-0.5 min-w-4 px-1 leading-4',
            ]"
            >{{ alertBadge.text }}</span
          >
          <span class="sr-only">{{ alertBadge.label }}</span>
        </template>
      </a>
    </RouterLink>
  </nav>
</template>
