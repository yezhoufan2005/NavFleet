<script setup lang="ts">
/**
 * A "?" beside a field label that explains what the field means — units, convention, effect.
 *
 * The console carries domain terms (resolution in m/px, ROS map origin and yaw, debounce windows,
 * report-code channels…) that an operator configuring a site may not know. Mature consoles put a
 * small help affordance next to such labels; this is that, built on reka-ui's Tooltip so it gets
 * the accessible behaviour for free:
 *
 * - opens on hover **and** on keyboard focus (the trigger is a real button in the tab order) —
 *   keyboard focus only: a dialog that moves focus to its first field on open must not pop the
 *   tip of a "?" the pointer is nowhere near, so programmatic and mouse focus are ignored
 *   (`ignore-non-keyboard-focus`);
 * - Esc closes it; it never steals focus;
 * - the text is the trigger's accessible description, so a screen reader announces it with the
 *   button — the visible tooltip is a convenience, not the only channel.
 *
 * A `<button type="button">` rather than a span so it is focusable, but it does nothing on click
 * beyond toggling the tip (touch screens have no hover) — it never submits the form it sits in.
 */
import { ref } from "vue";
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "reka-ui";

const { text, label = "字段说明" } = defineProps<{
  /** The explanation shown in the tip. */
  text: string;
  /** Accessible name of the "?" button; defaults to 字段说明. */
  label?: string;
}>();

const open = ref(false);
</script>

<template>
  <TooltipProvider :delay-duration="150" ignore-non-keyboard-focus>
    <TooltipRoot v-model:open="open">
      <TooltipTrigger as-child>
        <button
          type="button"
          class="ui-help inline-grid size-4 shrink-0 place-items-center rounded-full border border-current text-[10px] leading-none font-semibold text-border-strong transition-colors duration-150 ease-standard hover:text-ink-subtle focus-visible:text-ink-subtle"
          :aria-label="label"
          :aria-description="text"
          @click.prevent.stop="open = !open"
        >
          ?
        </button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          side="top"
          :side-offset="6"
          :collision-padding="8"
          class="z-50 max-w-72 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-ink shadow-overlay"
        >
          {{ text }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
