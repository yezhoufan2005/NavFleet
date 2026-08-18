import { reactive } from "vue";

export type NotificationType = "info" | "success" | "warning" | "error";

export interface NotificationItem {
  id: number;
  type: NotificationType;
  message: string;
  /** Optional stable key to de-duplicate repeated notifications (e.g. "ws-down"). */
  dedupeKey?: string;
}

interface NotifyOptions {
  type?: NotificationType;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. Defaults by type. */
  timeout?: number;
  dedupeKey?: string;
}

// Module-level singleton state so any composable/service can raise a toast
// without prop-drilling a handler through the component tree.
const items = reactive<NotificationItem[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const activeDedupeKeys = new Set<string>();

const DEFAULT_TIMEOUTS: Record<NotificationType, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

export function dismissNotification(id: number): void {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }
  const [removed] = items.splice(index, 1);
  if (removed?.dedupeKey) {
    activeDedupeKeys.delete(removed.dedupeKey);
  }
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function notify(message: string, options: NotifyOptions = {}): number {
  const type = options.type ?? "info";
  if (options.dedupeKey) {
    if (activeDedupeKeys.has(options.dedupeKey)) {
      return -1;
    }
    activeDedupeKeys.add(options.dedupeKey);
  }

  const id = nextId++;
  items.push({ id, type, message, dedupeKey: options.dedupeKey });

  const timeout = options.timeout ?? DEFAULT_TIMEOUTS[type];
  if (timeout > 0) {
    timers.set(
      id,
      setTimeout(() => dismissNotification(id), timeout),
    );
  }
  return id;
}

export function useNotifications() {
  return { items, notify, dismiss: dismissNotification };
}
