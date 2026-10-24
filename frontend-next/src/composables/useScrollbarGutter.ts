import { onBeforeUnmount, ref, watch, type Ref, type ShallowRef } from "vue";

/**
 * Keep a split "header table + scrolling body table" aligned.
 *
 * A data table whose header sits *outside* the vertical scroll box (so the scrollbar runs beside
 * the records only — the 灰色顶栏盖住滑条 look) drifts the moment the body scrolls: the body table
 * loses the scrollbar's width, the header table does not, and the right-hand column no longer lines
 * up. The fix is to reserve exactly that width on the header. It isn't a constant — it's 0 with
 * overlay scrollbars (macOS default) and ~15px with classic ones — so we measure the live body and
 * hand back the gutter in px for the caller to pad the header's right with.
 *
 * Pass the body's template ref (from `useTemplateRef`); get back the gutter in px. A
 * `ResizeObserver` re-measures on every layout change.
 */
export function useScrollbarGutter(
  bodyRef: Readonly<ShallowRef<HTMLElement | null>>,
): Ref<number> {
  const gutter = ref(0);
  let observer: ResizeObserver | null = null;

  const measure = (): void => {
    const el = bodyRef.value;
    if (el) gutter.value = Math.max(0, el.offsetWidth - el.clientWidth);
  };

  watch(
    bodyRef,
    (el) => {
      observer?.disconnect();
      observer = null;
      if (el && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(el);
        measure();
      }
    },
    { flush: "post" },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return gutter;
}
