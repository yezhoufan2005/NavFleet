import { reactive } from "vue";

/**
 * Toast queue.
 *
 * Ported from the v1.0.0 frontend with its behaviour intact — the dedupe key in
 * particular, which is what keeps a looping failure (a reconnect that fails every
 * two seconds) from stacking forty identical toasts. It is the one piece of the
 * old shell that needed no redesign.
 *
 * Two exported shapes on purpose:
 *
 * - `notify` / `dismissNotification` as bare functions, so a module that is not a
 *   component can raise a toast (`lib/globalErrorHandlers.ts`, `useAuth.ts`).
 * - `useNotifications()` for components.
 */
export type NotificationType = "info" | "success" | "warning" | "error";

export interface NotificationItem {
  id: number;
  type: NotificationType;
  message: string;
  dedupeKey?: string;
}

export interface NotifyOptions {
  type?: NotificationType;
  /** Milliseconds until auto-dismiss; `0` keeps it until dismissed. */
  timeout?: number;
  /** While a toast with this key is on screen, further ones are suppressed. */
  dedupeKey?: string;
}

/** Longer for the ones a person has to act on than for the ones they only note. */
const DEFAULT_TIMEOUTS: Record<NotificationType, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

const items = reactive<NotificationItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const activeDedupeKeys = new Set<string>();
let nextId = 1;

export const dismissNotification = (id: number): void => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;

  const [removed] = items.splice(index, 1);
  if (removed?.dedupeKey) activeDedupeKeys.delete(removed.dedupeKey);

  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
};

/** Returns the new toast's id, or `-1` when suppressed by an active dedupe key. */
export const notify = (
  message: string,
  options: NotifyOptions = {},
): number => {
  const type = options.type ?? "info";
  const { dedupeKey } = options;

  if (dedupeKey !== undefined && activeDedupeKeys.has(dedupeKey)) return -1;

  const id = nextId;
  nextId += 1;

  const item: NotificationItem = { id, type, message };
  if (dedupeKey !== undefined) {
    item.dedupeKey = dedupeKey;
    activeDedupeKeys.add(dedupeKey);
  }
  items.push(item);

  const timeout = options.timeout ?? DEFAULT_TIMEOUTS[type];
  if (timeout > 0) {
    timers.set(
      id,
      setTimeout(() => dismissNotification(id), timeout),
    );
  }

  return id;
};

export const useNotifications = () => ({
  items,
  notify,
  dismiss: dismissNotification,
});

/** Test-only reset. Module singletons otherwise leak between test files. */
export const __resetNotifications = (): void => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  activeDedupeKeys.clear();
  items.splice(0, items.length);
  nextId = 1;
};
