import { nextTick, reactive, watch, type WatchSource } from "vue";

/**
 * Per-field validation for the admin create/edit dialogs — the inline-message pattern mature form
 * libraries use, in place of a single error line at the foot of the form.
 *
 * A dialog validates on submit into a `{ field: message }` map; each required control binds
 * `:invalid="!!errors.field"` (red border) and renders the message beneath itself. On a failed
 * submit `report()` moves focus and the viewport to the first offending control, so the operator is
 * taken straight to what they must fix rather than hunting for a sentence at the bottom.
 *
 * `focusFirst` finds that control by `[aria-invalid="true"]` / `[data-invalid="true"]` inside the
 * open dialog (`.ui-dialog-surface`, which `UiModal` stamps) — a controlled lookup rather than a
 * ref per field, since only one dialog is ever open. A non-input group (e.g. a checkbox fieldset)
 * opts in with `data-invalid` + `tabindex="-1"` so it is focusable too.
 */
export interface FieldErrors {
  errors: Record<string, string>;
  /** Replace the whole error set (pass `{}` to clear) — call when opening/resetting the dialog. */
  setErrors: (next: Record<string, string>) => void;
  /**
   * Clear a field's error the moment the operator edits it. Synchronous on purpose: a value change
   * and a submit in the same tick must not leave the just-set error cleared by a deferred watcher.
   */
  clearOn: (source: WatchSource, field: string) => void;
  /** setErrors + (on any error) focus the first invalid control; returns whether anything failed. */
  report: (next: Record<string, string>) => boolean;
}

export const useFieldErrors = (): FieldErrors => {
  const errors = reactive<Record<string, string>>({});

  const setErrors = (next: Record<string, string>): void => {
    for (const key of Object.keys(errors)) delete errors[key];
    Object.assign(errors, next);
  };

  const clearOn = (source: WatchSource, field: string): void => {
    watch(
      source,
      () => {
        if (field in errors) delete errors[field];
      },
      { flush: "sync" },
    );
  };

  const hasErrors = (): boolean => Object.keys(errors).length > 0;

  /** After the errors render, focus + scroll the first invalid control in the open dialog. */
  const focusFirst = (): void => {
    void nextTick(() => {
      const el = document.querySelector<HTMLElement>(
        '.ui-dialog-surface [aria-invalid="true"], .ui-dialog-surface [data-invalid="true"]',
      );
      if (!el) return;
      el.focus({ preventScroll: true });
      // jsdom (the test env) does not implement scrollIntoView; guard so a failed submit there
      // does not throw out of the microtask.
      el.scrollIntoView?.({ block: "center" });
    });
  };

  const report = (next: Record<string, string>): boolean => {
    setErrors(next);
    const invalid = hasErrors();
    if (invalid) focusFirst();
    return invalid;
  };

  return { errors, setErrors, clearOn, report };
};
