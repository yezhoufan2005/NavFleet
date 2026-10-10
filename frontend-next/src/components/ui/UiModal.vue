<script setup lang="ts">
/**
 * The modal shell for a create/edit form, factored out of the admin editors (车辆 / 编队 / 角色 /
 * 用户组 / 用户 / 场景 / 报码字典 / 定时报表 / 外发) that each hand-rolled the same reka `Dialog`
 * scaffold — `DialogRoot/Portal/Overlay/Content/Title/Description` with a byte-identical content
 * class string. One component ends that drift; it mirrors `UiConfirmDialog` but on `Dialog`
 * (not `AlertDialog`), because these are forms, not "are you sure" confirmations.
 *
 * **Controlled**: the parent owns `open` and closes the dialog itself (so it can keep it up while a
 * save is in flight), via the forwarded `update:open`. The form is the default slot. `title` names
 * the dialog (wired to `DialogTitle` for a11y); `description` is the accessible description, kept
 * visually hidden (`sr-only`) — the forms carry their own visible labels. `maxWidth` picks the
 * content width (md/lg/xl). The content caps at 85vh and scrolls, so a tall form never overflows.
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";

const {
  open,
  title,
  description = "",
  maxWidth = "md",
} = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  maxWidth?: "md" | "lg" | "xl";
}>();

const emit = defineEmits<{ "update:open": [boolean] }>();

const MAX_WIDTH: Record<"md" | "lg" | "xl", string> = {
  md: "max-w-100",
  lg: "max-w-120",
  xl: "max-w-140",
};
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
      <DialogContent
        :class="[
          'ui-dialog-surface fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md border border-border bg-surface-raised p-5 shadow-overlay',
          MAX_WIDTH[maxWidth],
        ]"
      >
        <DialogTitle class="text-md font-semibold text-ink">{{
          title
        }}</DialogTitle>
        <DialogDescription class="sr-only">{{
          description || title
        }}</DialogDescription>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
