import { computed, ref, type ComputedRef } from "vue";

/**
 * Whether a form has unsaved changes, by comparing its current values with a snapshot.
 *
 * `read` returns the form's values (any JSON-shaped data). Call `mark()` when the form is filled
 * (dialog opened, config loaded, save succeeded); `dirty` is true while the values differ from that
 * snapshot. Comparison is by JSON, so it ignores identity and catches edits nested in arrays/objects.
 */
export const useDirtySnapshot = (
  read: () => unknown,
): { dirty: ComputedRef<boolean>; mark: () => void } => {
  const snapshot = ref<string | null>(null);
  const mark = (): void => {
    snapshot.value = JSON.stringify(read());
  };
  const dirty = computed(
    () => snapshot.value !== null && JSON.stringify(read()) !== snapshot.value,
  );
  return { dirty, mark };
};
