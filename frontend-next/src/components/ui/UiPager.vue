<script setup lang="ts">
/**
 * The pager — 上一页 / position / 下一页.
 *
 * The three views that paginate had each hand-rolled it: 审计 used `UiButton`s,
 * 设备 and 消息 used raw bordered `<button>`s with their own `px-2.5 py-1 text-xs`
 * string (a fourth, undeclared button size). Same control, three markups. This is
 * it once, on `UiButton ghost sm`.
 *
 * The middle position label is a slot because it is the one part that legitimately
 * differs — 设备 appends "· 共 N 台" — while everything mechanical (the disabled
 * edges, the emit) is shared. The default is the bare "第 X / Y 页". Like every
 * caller before it, the pager renders nothing at a single page.
 *
 * `page` is emitted through `update:page`, so a caller can `v-model:page` a ref or
 * route a clamping setter through `@update:page`.
 */
import UiButton from "./UiButton.vue";

const { page, pageCount } = defineProps<{
  page: number;
  pageCount: number;
}>();

defineEmits<{ "update:page": [number] }>();
</script>

<template>
  <div v-if="pageCount > 1" class="flex items-center gap-3">
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
