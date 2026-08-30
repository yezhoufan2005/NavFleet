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
import { useAlertSound } from "@/composables/useAlertSound";

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
/**
 * The sound control, which is both the state readout and the unlock gesture.
 *
 * Browsers refuse to start audio without a prior user gesture, so the console cannot
 * decide to be audible on its own — someone has to click something. Making the control
 * that *reports* the state also the one that unlocks it means the click a person makes
 * to say "make sound work" is exactly the gesture the policy requires.
 *
 * Until then it says so out loud. Silently not sounding is the one behaviour that must
 * never happen here: it is indistinguishable from "nothing is wrong".
 */
const sound = useAlertSound();

const SILENT_LABELS: Record<string, string> = {
  locked: "声音未启用",
  muted: "已静音",
  quiet: "免打扰中",
};

const soundLabel = computed(
  () => SILENT_LABELS[sound.silentReason.value] ?? "声音已启用",
);

const soundTitle = computed(() =>
  sound.silentReason.value === "locked"
    ? "点击启用告警声音。浏览器要求先有一次点击才允许播放，所以在此之前告警不会响。"
    : `告警声音：${soundLabel.value}（仅告警级会响，可在用户菜单中调整）`,
);

const onSoundClick = (): void => {
  if (sound.silentReason.value === "locked") void sound.unlock();
};

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

      <button
        type="button"
        class="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs transition-colors duration-150 ease-standard"
        :class="
          sound.silentReason.value === 'locked'
            ? 'text-warning-ink hover:bg-warning-wash'
            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
        "
        :aria-pressed="!sound.silentReason.value"
        :title="soundTitle"
        @click="onSoundClick"
      >
        <svg
          class="size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M5 9v6h3l5 4V5L8 9H5Z" />
          <path v-if="!sound.silentReason.value" d="M17 8a5 5 0 0 1 0 8" />
          <path v-else d="M17 9l4 6M21 9l-4 6" />
        </svg>
        <span class="hidden whitespace-nowrap lg:inline">{{ soundLabel }}</span>
      </button>

      <AppSessionMenu v-if="user" :user="user" @logout="emit('logout')" />
    </div>
  </header>
</template>
