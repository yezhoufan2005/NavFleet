<script setup lang="ts">
/**
 * Toast host.
 *
 * Two live-region layers, both from the v1.0.0 version and both intentional: the
 * container is `aria-live="polite"` so a toast that appears while a screen reader
 * is idle gets announced, and each toast is a `role="status"` so one that replaces
 * another is announced as its own message rather than as a diff of the list.
 *
 * `polite` rather than `assertive` even for errors: these arrive during work, and
 * an assertive region interrupts mid-sentence. Anything that genuinely must
 * interrupt belongs in a dialog, not here.
 *
 * Positioned bottom-right rather than v1.0.0's top-right. The top-right corner is
 * where the session menu opens from, and a toast landing there covered the menu it
 * was often telling you about.
 */
import {
  useNotifications,
  type NotificationType,
} from "@/composables/useNotifications";

const { items, dismiss, runAction } = useNotifications();

const ICONS: Record<NotificationType, string> = {
  info: "ℹ",
  success: "✓",
  warning: "!",
  error: "✕",
};

/**
 * Written out per type rather than composed from the type name — Tailwind only
 * generates classes it can see as literal text, and an interpolated
 * `bg-${type}-wash` compiles to nothing at all, silently.
 */
const TONES: Record<NotificationType, string> = {
  info: "border-border-strong bg-surface-raised text-ink",
  success: "border-brand bg-brand-wash text-brand-ink",
  warning: "border-warning bg-warning-wash text-warning-ink",
  error: "border-critical bg-critical-wash text-critical-ink",
};
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4"
    aria-live="polite"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-entrance"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-exit"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-for="item in items"
        :key="item.id"
        class="pointer-events-auto flex max-w-96 items-start gap-2 rounded-md border p-3 text-sm shadow-overlay"
        :class="TONES[item.type]"
        role="status"
      >
        <span class="font-semibold" aria-hidden="true">{{
          ICONS[item.type]
        }}</span>
        <span class="min-w-0 flex-1 break-words">{{ item.message }}</span>
        <!-- An undo, when the action that raised this offered one. Before the close
             button so it is the first thing Tab reaches. -->
        <button
          v-if="item.action"
          type="button"
          class="shrink-0 rounded-xs px-1.5 py-0.5 text-xs font-semibold underline underline-offset-2"
          @click="runAction(item.id)"
        >
          {{ item.action.label }}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-xs px-1 leading-none opacity-70 transition-opacity duration-150 ease-standard hover:opacity-100"
          aria-label="关闭"
          @click="dismiss(item.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
