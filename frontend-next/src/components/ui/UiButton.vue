<script setup lang="ts">
/**
 * The one button the token slice needs.
 *
 * Every colour comes from a semantic token, so neither variant carries a `dark:`
 * utility — that is the property 12B set out to prove. If the `@theme` override
 * mechanism did not work, this button would keep its light colours on a dark
 * ground and the check in test/tokens.test.ts would fail.
 */
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const { variant = "primary", size = "md" } = defineProps<{
  variant?: Variant;
  size?: Size;
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
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    :class="[
      'inline-flex items-center justify-center font-medium whitespace-nowrap',
      'transition-colors duration-150 ease-standard',
      'disabled:cursor-not-allowed disabled:opacity-55',
      VARIANTS[variant],
      SIZES[size],
    ]"
  >
    <slot />
  </button>
</template>
