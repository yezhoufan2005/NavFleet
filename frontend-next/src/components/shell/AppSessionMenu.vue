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

const { user } = defineProps<{ user: AuthUser }>();
const emit = defineEmits<{ logout: [] }>();

const { preference, setPreference } = useTheme();

const ROLE_LABELS: Record<AuthUser["role"], string> = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
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

        <DropdownMenuLabel class="px-2 py-1 text-2xs text-ink-subtle">
          主题
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
