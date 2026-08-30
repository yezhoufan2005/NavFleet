import { computed, reactive } from "vue";

/**
 * Client-side alert acknowledgement.
 *
 * Alerts are derived from live telemetry, so there is nothing on the backend to
 * "clear" — an alert disappears when the condition behind it does. What an operator
 * still needs is to mark one as *seen*, so acknowledgement is tracked by the alert's
 * stable id and persisted per browser.
 *
 * **This is knowingly the wrong place for it, and the page says so out loud.**
 * Acknowledgements never reach the database, carry no who and no when, and the next
 * person on shift sees none of them. `/api/v1/alerts` — which would fix half of
 * that — already exists and has never been called. Both are Phase 16 work; porting
 * the local behaviour first is what lets the console reach parity without pretending
 * the limitation is not there.
 */
const STORAGE_KEY = "navfleet:acked-alerts";

const load = (): string[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // Private mode can throw on access alone.
    return [];
  }
};

/** Module singleton: every view has to share one acknowledgement set. */
const state = reactive({ ids: new Set<string>(load()) });

const persist = (): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.ids]));
  } catch {
    // Storage blocked; the acknowledgement still holds for this session.
  }
};

export const useAlertAck = () => {
  const acknowledge = (id: string): void => {
    if (!id) return;
    state.ids.add(id);
    persist();
  };

  const unacknowledge = (id: string): void => {
    if (!id) return;
    state.ids.delete(id);
    persist();
  };

  /** Returns the ids it actually changed, so a caller can offer an undo. */
  const acknowledgeMany = (ids: readonly string[]): string[] => {
    const changed = ids.filter((id) => id && !state.ids.has(id));
    changed.forEach((id) => state.ids.add(id));
    if (changed.length) persist();
    return changed;
  };

  const unacknowledgeMany = (ids: readonly string[]): void => {
    ids.forEach((id) => state.ids.delete(id));
    persist();
  };

  const clearAll = (): void => {
    state.ids.clear();
    persist();
  };

  return {
    acknowledgedCount: computed(() => state.ids.size),
    isAcknowledged: (id: string): boolean => state.ids.has(id),
    acknowledge,
    unacknowledge,
    acknowledgeMany,
    unacknowledgeMany,
    clearAll,
  };
};

export const ALERT_ACK_STORAGE_KEY = STORAGE_KEY;

/** Test-only: module state would otherwise leak between files. */
export const __resetAlertAck = (): void => {
  state.ids = new Set<string>(load());
};
