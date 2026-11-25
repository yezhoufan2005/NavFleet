import { ref } from "vue";

/**
 * How a region that already shows data says it is re-querying (filter change, refresh, page turn).
 *
 * - `bar`: a 2px indeterminate bar along the region's top edge; the content stays as it is.
 * - `dim`: the content fades to 60% until the response lands; no bar.
 *
 * Both are built so the owner can compare them on the real pages and keep one. The choice sits in
 * the session menu (「加载提示」, marked 验收用) and is remembered per browser; once it is made, the
 * losing style, this switch and the menu entry go, and `UiBusyRegion` draws the winner only.
 */
export type RefetchStyle = "bar" | "dim";

const STORAGE_KEY = "navfleet:refetch-style";

const read = (): RefetchStyle => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dim" ? "dim" : "bar";
  } catch {
    return "bar";
  }
};

const style = ref<RefetchStyle>(read());

export const useRefetchStyle = () => ({
  style,
  setStyle: (next: RefetchStyle): void => {
    style.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked storage only loses the memory of the choice, not the choice.
    }
  },
});
