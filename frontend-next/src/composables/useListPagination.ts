import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ComputedRef } from "vue";

/**
 * The one list-pagination behaviour, shared by every paginated table (设备 / 消息 / 审计 /
 * 外发). Before this each view hand-rolled it and they drifted: two kept `page` in the URL
 * and two in local refs, two had a 每页条数 selector and two were fixed at 20, the slice
 * guard and the "clamp when the list shrinks" watch were present in some and not others.
 *
 * This fixes the shape once: page **and** page size both ride in the URL (so "it is on
 * page 3 at 50/页" travels in a link like the sort does), the default is 10, the allowed
 * sizes are 10/20/50, the current page is clamped when a filter shrinks the list, and a
 * page-size change drops back to page 1. A caller hands in the already-filtered rows and
 * gets back the current page's slice plus the controls to drive `UiListPagination`.
 *
 * Param names are overridable so two independent paginators could, in principle, live on
 * one route; today every paginated view is one table, so they default to `page`/`pageSize`.
 */
export interface ListPageSizeOption {
  value: string;
  label: string;
}

export const PAGE_SIZE_OPTIONS: readonly ListPageSizeOption[] = [
  { value: "10", label: "10 条/页" },
  { value: "20", label: "20 条/页" },
  { value: "50", label: "50 条/页" },
];

const ALLOWED_PAGE_SIZES = [10, 20, 50];
const DEFAULT_PAGE_SIZE = 10;

export interface UseListPaginationOptions {
  pageParam?: string;
  pageSizeParam?: string;
}

export function useListPagination<T>(
  items: ComputedRef<readonly T[]>,
  options: UseListPaginationOptions = {},
) {
  const { pageParam = "page", pageSizeParam = "pageSize" } = options;
  const route = useRoute();
  const router = useRouter();

  const pageSize = computed(() => {
    const value = Number(route.query[pageSizeParam]);
    return ALLOWED_PAGE_SIZES.includes(value) ? value : DEFAULT_PAGE_SIZE;
  });

  const page = computed(() => {
    const value = Number(route.query[pageParam]);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  });

  const pageCount = computed(() =>
    Math.max(1, Math.ceil(items.value.length / pageSize.value)),
  );

  const pageItems = computed<readonly T[]>(() => {
    const start = (Math.min(page.value, pageCount.value) - 1) * pageSize.value;
    return items.value.slice(start, start + pageSize.value);
  });

  const setPage = (next: number): void => {
    void router.replace({
      query: {
        ...route.query,
        [pageParam]: next > 1 ? String(next) : undefined,
      },
    });
  };

  const setPageSize = (next: string): void => {
    const size = Number(next);
    void router.replace({
      query: {
        ...route.query,
        // The default is omitted from the URL so a plain link stays clean.
        [pageSizeParam]:
          ALLOWED_PAGE_SIZES.includes(size) && size !== DEFAULT_PAGE_SIZE
            ? String(size)
            : undefined,
        // A density change always returns to page 1 — the old offset would fall out of range.
        [pageParam]: undefined,
      },
    });
  };

  // A filter that shrinks the list can leave the page number past the end; clamp it so the
  // pager never highlights nothing over an empty table.
  watch(pageCount, (count) => {
    if (page.value > count) setPage(count);
  });

  return { page, pageSize, pageCount, pageItems, setPage, setPageSize };
}
