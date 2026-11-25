<script setup lang="ts">
/**
 * The first load of a region — nothing to show yet. A skeleton in the shape of what will arrive,
 * so the wait reads as "this is filling in" and the layout does not jump when it lands:
 *
 * - `table`: the shared table panel (`tableClasses`) — a header strip and `rows` body rows of
 *   `columns` bars. Row heights are the real ones, computed from the type tokens: a text row is
 *   `py-2` around one `text-sm` line box; an `action` row is `py-2` around an `sm` button (h-8).
 * - `fields`: label/value pairs, `columns` across (a card's 字段 grid).
 * - `cards`: `rows` card blocks, `columns` across.
 * - `block`: one block filling the box it is given (a chart canvas, a map) — size it with a class.
 * - `lines`: `rows` text lines (a short panel).
 *
 * Shown only after `LOADING_DELAY_MS` (a fast response shows nothing at all), with `label` as the
 * screen-reader status — the bars themselves are `aria-hidden`, see `UiSkeleton`.
 *
 * Re-queries of a region that already has data are `UiBusyRegion`'s job, not this one's.
 */
import { computed } from "vue";
import { useDelayedFlag } from "@/composables/useDelayedFlag";
import UiSkeleton from "@/components/ui/UiSkeleton.vue";

type Kind = "table" | "fields" | "cards" | "block" | "lines";

const {
  label = "",
  kind = "table",
  rows = 5,
  columns = 4,
  action = false,
} = defineProps<{
  /**
   * What is loading, read to screen readers: `正在加载用户`. Leave it off on the second and later
   * pieces of a composite skeleton, so the wait is announced once.
   */
  label?: string;
  kind?: Kind;
  rows?: number;
  columns?: number;
  /** Table rows carry a button (操作 column): reserve its height, not a text line's. */
  action?: boolean;
}>();

const shown = useDelayedFlag(() => true);

/** Bar widths per column, so a row reads as data of different lengths rather than a grid. */
const WIDTHS = ["72%", "48%", "86%", "56%", "64%", "40%", "78%", "52%"];
const widthOf = (index: number): string => WIDTHS[index % WIDTHS.length]!;

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
}));
</script>

<template>
  <div class="ui-loading" :aria-busy="true" data-loading="">
    <p v-if="shown && label" class="sr-only" role="status">{{ label }}</p>

    <template v-if="shown">
      <div
        v-if="kind === 'table'"
        class="overflow-hidden rounded-md border border-border bg-surface-raised"
        aria-hidden="true"
      >
        <div
          class="grid gap-x-6 bg-surface-sunken px-3 py-2"
          :style="gridStyle"
        >
          <span
            v-for="column in columns"
            :key="column"
            class="loading-head-box flex items-center"
          >
            <span class="skeleton-bar h-2" :style="{ width: '38%' }" />
          </span>
        </div>
        <div
          v-for="row in rows"
          :key="row"
          class="grid gap-x-6 border-b border-border px-3 py-2 last:border-0"
          :style="gridStyle"
        >
          <span
            v-for="column in columns"
            :key="column"
            class="flex items-center"
            :class="action ? 'h-8' : 'loading-row-box'"
          >
            <span
              class="skeleton-bar h-3"
              :style="{ width: widthOf(row + column) }"
            />
          </span>
        </div>
      </div>

      <dl
        v-else-if="kind === 'fields'"
        class="m-0 grid gap-x-6 gap-y-3"
        :style="gridStyle"
        aria-hidden="true"
      >
        <div
          v-for="field in rows * columns"
          :key="field"
          class="flex flex-col gap-1.5"
        >
          <span class="skeleton-bar h-2.5" :style="{ width: '32%' }" />
          <span class="skeleton-bar h-3.5" :style="{ width: widthOf(field) }" />
        </div>
      </dl>

      <div
        v-else-if="kind === 'cards'"
        class="grid gap-4"
        :style="gridStyle"
        aria-hidden="true"
      >
        <UiSkeleton v-for="card in rows * columns" :key="card" variant="card" />
      </div>

      <UiSkeleton v-else-if="kind === 'block'" variant="block" class="h-full" />

      <UiSkeleton v-else :rows="rows" />
    </template>
  </div>
</template>

<style scoped>
/* The real line boxes, from the type tokens: a header cell is one `text-2xs` line, a body cell
   one `text-sm` line — so the skeleton's rows are exactly as tall as the table's. */
.loading-head-box {
  height: calc(var(--text-2xs) * var(--text-2xs--line-height));
}
.loading-row-box {
  height: calc(var(--text-sm) * var(--text-sm--line-height));
}

.skeleton-bar {
  display: block;
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    var(--color-surface-sunken) 0%,
    var(--color-border) 50%,
    var(--color-surface-sunken) 100%
  );
  background-size: 200% 100%;
  animation: loading-sweep 1.4s ease-in-out infinite;
}

@keyframes loading-sweep {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-bar {
    animation: none;
    background: var(--color-border);
  }
}
</style>
