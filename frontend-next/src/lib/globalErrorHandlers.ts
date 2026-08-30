import { notify } from "@/composables/useNotifications";

/**
 * Last-resort reporting for errors nothing else caught.
 *
 * Without this, a thrown error inside an event handler or a rejected promise with
 * no `.catch` produces a console line the operator never sees and a UI that just
 * stops responding. Neither handler swallows the event: `window.onerror` returns
 * false and the rejection handler does not `preventDefault`, so the browser still
 * prints the error with its stack. The toast is additional, not a replacement.
 *
 * Ported from the v1.0.0 frontend unchanged — it was already right. Note that it
 * deliberately adds no `console.error` of its own: the browser's own reporting
 * already carries the stack, and the Playwright suite treats any `console.error`
 * as a test failure, so a duplicate line here would turn every reported error
 * into a red run for the second time.
 */
let installed = false;

const summarize = (value: unknown): string => {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return "未知错误";
};

export const installGlobalErrorHandlers = (): void => {
  if (installed) return;
  installed = true;

  const previousOnError = window.onerror;
  window.onerror = (event, source, lineno, colno, error) => {
    const summary = summarize(error ?? event);
    notify(`页面出现异常：${summary}`, {
      type: "error",
      dedupeKey: `window-error:${summary}`,
    });
    if (typeof previousOnError === "function") {
      previousOnError.call(window, event, source, lineno, colno, error);
    }
    // Returning false leaves the default reporting in place — the stack in the
    // console is what makes the toast actionable.
    return false;
  };

  window.addEventListener("unhandledrejection", (event) => {
    const summary = summarize(event.reason);
    notify(`后台任务失败：${summary}`, {
      type: "error",
      dedupeKey: `unhandled-rejection:${summary}`,
    });
  });
};

/** Test-only. Lets a suite install handlers against a fresh window. */
export const __resetGlobalErrorHandlers = (): void => {
  installed = false;
};
