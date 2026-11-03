<script setup lang="ts">
/**
 * The fold chevron used by every disclosure row — the device list and the 消息史 day groups —
 * so they open and close with the same mark. Points right when closed, rotates a quarter-turn to
 * point down when `open`. Size and colour come from the parent: it draws in `currentColor` at
 * `size-3`, and a caller passing its own size/colour class overrides that.
 */
defineProps<{ open: boolean }>();
</script>

<template>
  <svg
    class="size-3 shrink-0 transition-transform"
    :class="{ 'rotate-90': open }"
    viewBox="0 0 12 12"
    aria-hidden="true"
  >
    <path
      d="M4 2.5 8 6l-4 3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
