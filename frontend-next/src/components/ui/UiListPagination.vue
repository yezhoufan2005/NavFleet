<script setup lang="ts">
/**
 * The standard footer under a paginated table: a 每页条数 selector on the left, the pager
 * (with page-number jump) on the right. One component so 设备 / 消息 / 审计 / 外发 read and
 * behave identically — the thing that drifted before this existed.
 *
 * Pairs with `useListPagination`, which owns the state; this is purely the controls. The
 * middle label defaults to `第 X / Y 页 · 共 N {unit}` and can be overridden through the
 * default slot where a view wants different wording.
 */
import UiSelect from "./UiSelect.vue";
import UiPager from "./UiPager.vue";
import {
  PAGE_SIZE_OPTIONS,
  type ListPageSizeOption,
} from "@/composables/useListPagination";

const {
  page,
  pageCount,
  pageSize,
  total,
  unit = "条",
  pageSizeOptions = PAGE_SIZE_OPTIONS,
} = defineProps<{
  page: number;
  pageCount: number;
  pageSize: number;
  /** Total rows across all pages, for the "共 N 条" count. */
  total: number;
  /** The noun counted — 条 (default), 台, … */
  unit?: string;
  pageSizeOptions?: readonly ListPageSizeOption[];
}>();

defineEmits<{
  "update:page": [number];
  "update:pageSize": [string];
}>();
</script>

<template>
  <nav class="flex items-center justify-between gap-3" aria-label="分页">
    <label class="flex items-center gap-2 font-mono text-2xs text-ink-muted">
      <span>每页条数</span>
      <UiSelect
        :model-value="String(pageSize)"
        :options="pageSizeOptions"
        aria-label="每页条数"
        @update:model-value="$emit('update:pageSize', $event)"
      />
    </label>
    <UiPager
      :page="page"
      :page-count="pageCount"
      jump
      @update:page="$emit('update:page', $event)"
    >
      <slot>
        第 {{ Math.min(page, pageCount) }} / {{ pageCount }} 页 · 共 {{ total }}
        {{ unit }}
      </slot>
    </UiPager>
  </nav>
</template>
