/**
 * Global failure handlers.
 *
 * `ErrorBoundary` only sees failures raised inside the component tree. Errors
 * thrown from timers/listeners and rejected promises land here instead, and
 * would otherwise vanish silently — the operator would keep looking at stale
 * data with no hint that something broke. Both handlers surface a toast and
 * deliberately leave the browser's own console reporting intact.
 */

import { notify } from "../composables/useNotifications";

let installed = false;

const summarize = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    return String(value.message);
  }
  return "未知错误";
};

/**
 * Registers `window.onerror` and the `unhandledrejection` listener. Safe to call
 * more than once: only the first call installs anything.
 */
export function installGlobalErrorHandlers(): void {
  if (installed) {
    return;
  }
  installed = true;

  const previousOnError = window.onerror;
  window.onerror = (event, source, lineno, colno, error) => {
    const summary = summarize(error ?? event);
    notify(`页面出现异常：${summary}`, {
      type: "error",
      // Same failure firing in a loop collapses into one toast; a different one
      // still gets through.
      dedupeKey: `window-error:${summary}`,
    });
    // Chain rather than replace any pre-existing handler, then return false so
    // the browser still prints the original error and its stack.
    previousOnError?.call(window, event, source, lineno, colno, error);
    return false;
  };

  window.addEventListener("unhandledrejection", (event) => {
    const summary = summarize(event.reason);
    notify(`后台任务失败：${summary}`, {
      type: "error",
      dedupeKey: `unhandled-rejection:${summary}`,
    });
    // No preventDefault(): the console keeps reporting the unhandled rejection.
  });
}
