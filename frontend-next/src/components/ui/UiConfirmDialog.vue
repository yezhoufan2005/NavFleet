<script setup lang="ts">
/**
 * Confirmation dialog for a genuinely irreversible action.
 *
 * The design system removed `UiButton`'s `danger` variant for most of this project's life
 * because a read-only console had no destructive actions. User management is the
 * first that does — delete a user, force-log-out an account, revoke a session — and the note
 * on that variant promised it would return **with** this pattern, not before. This is it.
 *
 * Built on reka `AlertDialog` (not `Dialog`): the role is `alertdialog` and focus lands on the
 * cancel affordance. reka's AlertDialog deliberately ignores a click outside; here a click on the
 * backdrop cancels, the same as every other dialog in the console and the same as Escape —
 * cancelling is always safe, so there is no reason this one dialog should be the exception. Not
 * while the action is in flight (`pending`): then Escape, the backdrop and the close request are
 * all ignored, and the dialog stays up until the request resolves. It is a **controlled**
 * component: the parent owns `open` and closes it only once the request resolves.
 */
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import UiButton from "@/components/ui/UiButton.vue";

const {
  open,
  title,
  description = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "danger",
  pending = false,
} = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  pending?: boolean;
}>();

const emit = defineEmits<{ "update:open": [boolean]; confirm: [] }>();
</script>

<template>
  <AlertDialogRoot
    :open="open"
    @update:open="(next) => (next || !pending) && emit('update:open', next)"
  >
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 z-50 bg-scrim/55"
        @click="!pending && emit('update:open', false)"
      />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 flex w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
      >
        <AlertDialogTitle class="text-md font-semibold text-ink">
          {{ title }}
        </AlertDialogTitle>
        <AlertDialogDescription
          v-if="description"
          class="text-sm text-ink-muted"
        >
          {{ description }}
        </AlertDialogDescription>
        <div class="mt-2 flex justify-end gap-2">
          <AlertDialogCancel as-child>
            <UiButton variant="secondary" size="sm" :disabled="pending">
              {{ cancelLabel }}
            </UiButton>
          </AlertDialogCancel>
          <!--
            A plain button, not `AlertDialogAction`: that primitive closes the dialog the
            instant it is clicked, but a destructive action is async and the dialog should stay
            up (showing `pending`) until the request resolves — the parent closes it by setting
            `open` false on success.
          -->
          <UiButton
            :variant="variant"
            size="sm"
            :disabled="pending"
            @click="emit('confirm')"
          >
            {{ pending ? "处理中…" : confirmLabel }}
          </UiButton>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
