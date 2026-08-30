<script setup lang="ts">
/**
 * The button.
 *
 * Every colour comes from a semantic token, so no variant carries a `dark:`
 * utility — the property 12B set out to prove, and the one `test/tokens.test.ts`
 * enforces. If the `@theme` override mechanism ever broke, this button would keep
 * its light colours on a dark ground and that test would go red.
 *
 * ## Why it can render as something other than a `<button>`
 *
 * Some things that look like buttons are navigation, and navigation has to stay an
 * anchor: middle-click, ⌘-click and "copy link address" are not features a design
 * system gets to remove. The alternative — an `<a>` wrapping a `<button>` — is
 * invalid HTML and gives a screen reader two nested controls to announce.
 *
 * Reka UI's `Primitive` handles the element swap. Rendered as an anchor the
 * `type` and `disabled` attributes are dropped, because neither means anything on
 * an `<a>` and `disabled` in particular would look like it worked while the link
 * stayed fully clickable.
 */
import { computed } from "vue";
import { Primitive } from "reka-ui";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const {
  variant = "primary",
  size = "md",
  type = "button",
  as = "button",
  disabled = false,
} = defineProps<{
  variant?: Variant;
  size?: Size;
  /**
   * Declared as a prop rather than left to attribute fallthrough. Whether a
   * fallthrough `type` overrides the one written in this template is a detail of
   * Vue's merge order, and a submit button that silently became `type="button"`
   * would leave a form that does nothing on Enter.
   */
  type?: "button" | "submit" | "reset";
  as?: "button" | "a";
  disabled?: boolean;
}>();

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-brand-contrast hover:bg-brand-hover",
  secondary:
    "bg-surface-raised text-ink border border-border-strong hover:bg-surface-sunken",
  ghost: "text-ink-muted hover:bg-surface-sunken hover:text-ink",
  danger: "bg-critical text-critical-contrast hover:brightness-110",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-sm rounded-sm gap-1.5",
  md: "h-10 px-4 text-base rounded-md gap-2",
};

const isButton = computed(() => as === "button");
</script>

<template>
  <Primitive
    :as="as"
    :type="isButton ? type : undefined"
    :disabled="isButton && disabled ? true : undefined"
    :class="[
      'inline-flex items-center justify-center font-medium whitespace-nowrap',
      'transition-colors duration-150 ease-standard',
      'disabled:cursor-not-allowed disabled:opacity-55',
      VARIANTS[variant],
      SIZES[size],
    ]"
  >
    <slot />
  </Primitive>
</template>
