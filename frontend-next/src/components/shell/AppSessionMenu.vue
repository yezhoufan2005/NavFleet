<script setup lang="ts">
/**
 * Session menu: who is signed in, the personal preferences, and sign-out.
 *
 * Preferences live here rather than on a settings page — an 11C decision (§1). A
 * settings *page* for "which theme do I like" is a page nobody navigates to twice,
 * and it competes for a slot in the primary navigation with things a whole shift
 * depends on.
 *
 * Built on Reka UI's `DropdownMenu`, and that is the point of introducing it here:
 * focus management, roving focus through the items, Escape and outside-click
 * dismissal, and the `aria-expanded` / `aria-haspopup` wiring are the parts of a
 * menu that are tedious to get right and easy to get subtly wrong. This is the
 * first real use of the primitive library the design system committed to, so it is
 * also the cheapest place to find out it does not fit.
 *
 * ## One deliberate change from v1.0.0
 *
 * There, 退出 was a bare button in the header. It now sits inside this menu, which
 * costs the e2e logout case one extra step (open the menu, then click). That is the
 * IA decision showing up in the equivalence net, not an accident — see
 * ROADMAP Phase 12C.
 */
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui";
import type { AuthUser } from "@/composables/useAuth";
import { useTheme, type ThemePreference } from "@/composables/useTheme";
import { useAlertSound } from "@/composables/useAlertSound";
import type { QuietHours, SoundVolume } from "@/composables/useAlertSound";

const { user } = defineProps<{ user: AuthUser }>();
const emit = defineEmits<{ logout: [] }>();

const { preference, resolved, setPreference } = useTheme();
const sound = useAlertSound();

const ROLE_LABELS: Record<AuthUser["role"], string> = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
};

const VOLUME_OPTIONS: readonly { value: SoundVolume; label: string }[] = [
  { value: "low", label: "轻" },
  { value: "medium", label: "中" },
  { value: "high", label: "重" },
];

/**
 * Two presets and an always-on, rather than a time picker. A free-form range needs a
 * form, and a form belongs on a settings page this IA deliberately does not have — see
 * 13D-2 for why that is a deferral rather than a claim that presets are the same thing.
 *
 * 全天 is here rather than being left to 静音 because the two are different promises:
 * 静音 is a switch someone flips for the next few minutes, 免打扰 全天 is a standing rule
 * that survives a reload and does not get forgotten about.
 */
const QUIET_OPTIONS: readonly { value: QuietHours; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "all", label: "全天" },
  { value: "night", label: "夜间 22:00–08:00" },
];

const onVolumeChange = (value: unknown): void => {
  const match = VOLUME_OPTIONS.find((option) => option.value === value);
  if (match) sound.setVolume(match.value);
};

const onQuietChange = (value: unknown): void => {
  const match = QUIET_OPTIONS.find((option) => option.value === value);
  if (match) sound.setQuietHours(match.value);
};

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/**
 * Reka's radio group is typed for arbitrary values, so narrow on the way back in
 * rather than casting: an unrecognised value leaves the preference untouched.
 */
const onThemeChange = (value: unknown): void => {
  const match = THEME_OPTIONS.find((option) => option.value === value);
  if (match) setPreference(match.value);
};
</script>

<template>
  <!--
    `modal="false"` on purpose. Reka's default hides the rest of the page with
    `aria-hidden` while the menu is open, but leaves everything inside it in the tab
    order — which axe flags as `aria-hidden-focus` (serious), and rightly: a screen
    reader is told the shell is not there while a keyboard can still tab into it.
    A menu is not a dialog; the ARIA menu-button pattern does not ask for the page
    to be hidden. Escape, outside-click dismissal and focus return to the trigger
    all still come from the primitive.
  -->
  <DropdownMenuRoot :modal="false">
    <DropdownMenuTrigger
      class="flex items-center gap-2 rounded-sm border border-border px-2 py-1.5 text-sm text-ink transition-colors duration-150 ease-standard hover:bg-surface-sunken data-[state=open]:bg-surface-sunken"
    >
      <span
        class="grid size-6 shrink-0 place-items-center rounded-full bg-brand-wash font-mono text-2xs font-semibold text-brand-ink"
        aria-hidden="true"
      >
        {{ user.username.slice(0, 2).toUpperCase() }}
      </span>
      <span class="max-w-32 truncate">{{ user.username }}</span>
      <span class="text-2xs text-ink-muted">{{ ROLE_LABELS[user.role] }}</span>
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :side-offset="6"
        align="end"
        class="z-50 min-w-56 rounded-md border border-border bg-surface-raised p-1 shadow-overlay"
      >
        <DropdownMenuLabel class="px-2 py-1.5 text-2xs text-ink-subtle">
          已登录：{{ user.username }} · {{ ROLE_LABELS[user.role] }}
        </DropdownMenuLabel>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />

        <!--
          The label says which of the two is in force, not only which option is selected.
          `resolved` has been exported by `useTheme` since 12B with no reader, and it is
          the only thing that can answer this while 跟随系统 is chosen — the radio says
          「跟随系统」 and the screen is dark, and nothing on the page connects the two.
        -->
        <DropdownMenuLabel class="px-2 py-1 text-2xs text-ink-subtle">
          主题 ·
          <span class="text-ink-muted"
            >当前生效：{{ resolved === "dark" ? "深色" : "浅色" }}</span
          >
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          :model-value="preference"
          @update:model-value="onThemeChange"
        >
          <DropdownMenuRadioItem
            v-for="option in THEME_OPTIONS"
            :key="option.value"
            :value="option.value"
            class="flex cursor-default items-center justify-between rounded-sm px-2 py-1.5 text-sm text-ink-muted select-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-ink data-[state=checked]:text-ink"
          >
            {{ option.label }}
            <span
              v-if="preference === option.value"
              class="text-brand-ink"
              aria-hidden="true"
              >✓</span
            >
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator class="my-1 h-px bg-border" />

        <DropdownMenuLabel class="px-2 py-1 text-2xs text-ink-subtle">
          告警声音
        </DropdownMenuLabel>
        <!-- `@select.prevent` so toggling does not close the menu: someone adjusting
             sound usually adjusts more than one of these. -->
        <DropdownMenuCheckboxItem
          :model-value="sound.muted.value"
          class="flex cursor-default items-center justify-between rounded-sm px-2 py-1.5 text-sm text-ink-muted select-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-ink"
          @select.prevent
          @update:model-value="sound.setMuted(!sound.muted.value)"
        >
          静音
          <span
            v-if="sound.muted.value"
            class="text-brand-ink"
            aria-hidden="true"
            >✓</span
          >
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup
          :model-value="sound.volume.value"
          @update:model-value="onVolumeChange"
        >
          <DropdownMenuRadioItem
            v-for="option in VOLUME_OPTIONS"
            :key="option.value"
            :value="option.value"
            class="flex cursor-default items-center justify-between rounded-sm px-2 py-1.5 text-sm text-ink-muted select-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-ink data-[state=checked]:text-ink"
            @select.prevent
          >
            音量 {{ option.label }}
            <span
              v-if="sound.volume.value === option.value"
              class="text-brand-ink"
              aria-hidden="true"
              >✓</span
            >
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />

        <!--
          免打扰 is its own section, not a third row of 告警声音, because it answers a
          different question: 声音 is "how loud, and is it on right now", 免打扰 is "when
          should this console never make a sound". Merged into one list they read as five
          equal settings, and the two 关闭 / 静音 rows next to each other look like the
          same switch written twice.
        -->
        <DropdownMenuLabel class="px-2 py-1 text-2xs text-ink-subtle">
          免打扰
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          :model-value="sound.quietHours.value"
          @update:model-value="onQuietChange"
        >
          <DropdownMenuRadioItem
            v-for="option in QUIET_OPTIONS"
            :key="option.value"
            :value="option.value"
            class="flex cursor-default items-center justify-between rounded-sm px-2 py-1.5 text-sm text-ink-muted select-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-ink data-[state=checked]:text-ink"
            @select.prevent
          >
            {{ option.label }}
            <span
              v-if="sound.quietHours.value === option.value"
              class="text-brand-ink"
              aria-hidden="true"
              >✓</span
            >
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem
          class="cursor-default rounded-sm px-2 py-1.5 text-sm text-ink-muted select-none data-[highlighted]:bg-critical-wash data-[highlighted]:text-critical-ink"
          @select="emit('logout')"
        >
          退出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
