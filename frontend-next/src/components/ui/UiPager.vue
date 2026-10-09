<script setup lang="ts">
/**
 * The pager — 上一页 / position / (页码跳转) / 下一页.
 *
 * The three views that paginate had each hand-rolled it; this is that control once, on
 * `UiButton ghost sm`. The middle position label is a slot because it is the one part
 * that legitimately differs (设备 appends "· 共 N 台"); everything mechanical is shared.
 *
 * `page` is emitted through `update:page`, so a caller can `v-model:page` a ref or route
 * a clamping setter through `@update:page`.
 *
 * `jump` opts a caller into two extra behaviours (设备 uses them): the pager stays visible
 * even on a single page — a persistent control reads as "this list is paged", where a
 * disappearing one just looks like a layout that moves — and, once there is more than one
 * page, a page-number input appears for jumping straight to a page. Without `jump` the
 * pager keeps its original behaviour: it renders nothing at a single page.
 */
import { ref, watch } from "vue";
import UiButton from "./UiButton.vue";

const {
  page,
  pageCount,
  jump = false,
} = defineProps<{
  page: number;
  pageCount: number;
  jump?: boolean;
}>();

const emit = defineEmits<{ "update:page": [number] }>();

/** The current page, clamped — also the jump input's draft value. */
const draft = ref(String(Math.min(page, pageCount)));
watch(
  () => [page, pageCount] as const,
  () => {
    draft.value = String(Math.min(page, pageCount));
  },
);

const commitJump = (): void => {
  const parsed = Math.round(Number(draft.value));
  const current = Math.min(page, pageCount);
  if (!Number.isFinite(parsed)) {
    draft.value = String(current);
    return;
  }
  const clamped = Math.min(Math.max(parsed, 1), pageCount);
  draft.value = String(clamped);
  if (clamped !== current) emit("update:page", clamped);
};
</script>

<template>
  <div v-if="pageCount > 1 || jump" class="flex items-center gap-3">
    <UiButton
      variant="ghost"
      size="sm"
      :disabled="page <= 1"
      @click="$emit('update:page', page - 1)"
    >
      上一页
    </UiButton>
    <span class="font-mono text-2xs text-ink-muted">
      <slot>第 {{ Math.min(page, pageCount) }} / {{ pageCount }} 页</slot>
    </span>
    <label
      v-if="jump && pageCount > 1"
      class="flex items-center gap-1 text-2xs text-ink-muted"
    >
      跳至
      <input
        v-model="draft"
        type="number"
        min="1"
        :max="pageCount"
        class="h-7 w-12 rounded-sm border border-border-strong bg-surface-raised px-1 text-center font-mono text-xs text-ink tabular-nums transition-colors duration-150 ease-standard hover:border-brand focus:border-brand focus:outline-none"
        aria-label="跳转到页码"
        @change="commitJump"
        @keyup.enter="commitJump"
      />
    </label>
    <UiButton
      variant="ghost"
      size="sm"
      :disabled="page >= pageCount"
      @click="$emit('update:page', page + 1)"
    >
      下一页
    </UiButton>
  </div>
</template>
